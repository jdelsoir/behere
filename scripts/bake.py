#!/usr/bin/env python3
"""BeHERE data bake: sources on the wire -> web/data, byte-identically.

Implements docs/CONTRACT.md v1 exactly. The contract outranks PLAN.md.

Standard library only. No pip, no numpy, no shapely, no requests. This runs in
GitHub Actions against a cold cache, so every large input is streamed to disk
and then streamed again out of the archive: at no point is the 865 MB address
file or the 212 MB sector geometry held in memory.

Pipeline
--------
  1. sector geometry   streamed out of the zip, feature by feature, giving both
                       the pilot polygons and the national nuts3 lookup
  2. addresses         streamed out of the zip (or out of --sample), filtered to
                       the pilot NIS set, each row resolved to its 2025 sector
                       by bake-time point-in-polygon (CONTRACT 6.1)
  3. GTFS stops        stops.txt only, from four NAP feeds, kept only where the
                       stop lands in a cell we already ship
  4. emit              meta.json, <nis>/{meta.json,streets.json,sector.geojson},
                       grid/<cell>.json, plus the shared frozen files
  5. verify + report   self-checks from CONTRACT 13, then the byte budget

Idempotency
-----------
Every file is serialised with sort_keys=True, separators=(",", ":"),
ensure_ascii=False, exactly one trailing LF. Grid shards and municipality meta
contain zero floating-point numbers (asserted before writing). Sector geometry
is rounded to exactly 5 decimal places. No wall-clock value is written anywhere
except meta.json's `built`, which is max(retrieved) over the sources and is
therefore a property of the cache, not of the run. SOURCE_DATE_EPOCH overrides
it for reproducible-build testing.

Usage
-----
  python3 scripts/bake.py --out web/data --cache-dir .cache/bake
  python3 scripts/bake.py --sample fixture.txt --out /tmp/dry   # dry run
  python3 scripts/bake.py --cities 92003,81001                  # partial tree
"""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import io
import json
import math
import os
import re
import shutil
import socket
import sys
import time
import urllib.parse
import zipfile
from datetime import datetime, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(_HERE)
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from grid import wgs84_to_cell, neighbours           # noqa: E402
from geo31370 import lb72_to_wgs84, simplify_ring_lonlat  # noqa: E402


# ===========================================================================
# Contract constants. Do not tune these without bumping CONTRACT_VERSION.
# ===========================================================================

CONTRACT_VERSION = 1
VINTAGE = "2025-01-01"
COORD_DP = 5
GRID_SRS = "EPSG:3035"
GRID_SIZE_M = 1000

# CONTRACT 6.2: the deterministic tolerance ladder and the per-file cap.
SECTOR_LADDER = (8, 10, 12, 15, 20, 25, 35, 50)
SECTOR_MAX_BYTES = 150000

# CONTRACT 13 gate 3 / acceptance test 10.
BUDGET_MAX_GZ = 3145728

# The pilot municipalities, 2025 NIS codes. Single source of truth: the CI
# gates in .github/workflows/ import this dict rather than repeating it, so a
# city added here cannot drift out of sync with the checks that guard it.
#
# Court-Saint-Etienne and Mont-Saint-Guibert are spelled here exactly as
# Statbel authors them. Statbel writes Court-Saint-Etienne without the acute
# accent while preserving it in Liege -> "Liège" in the same file, so the
# unaccented form is the authored name, not a mangling on our side, and is left
# alone under the never-rewrite-authored-names rule.
PILOTS = {
    "21004": "City of Brussels",
    "25023": "Court-Saint-Etienne",
    "25068": "Mont-Saint-Guibert",
    "25121": "Ottignies-LLN",
    "35013": "Ostend",
    "44021": "Ghent",
    "62063": "Liege",
    "81001": "Arlon",
    "92003": "Andenne",
}

# CONTRACT 4.1: the nine German-speaking Community municipalities.
DE_COMMUNITY = frozenset({
    "63001", "63012", "63013", "63023", "63040",
    "63048", "63061", "63067", "63087",
})

# The date every runtime source was last probed live. Used as `retrieved` for
# sources that are never downloaded by the bake. A constant, never the clock.
VERIFIED_ON = "2026-08-15"

UA = ("BeHERE-bake/1.0 (+https://github.com/behere/behere; "
      "static PWA data bake; keyless)")

DOWNLOAD_CHUNK = 1 << 20
LOG_EVERY = 32 << 20


# ===========================================================================
# Mirrors.
#
# `statbel.fgov.be` publishes both an A and an AAAA record. Runners have no
# IPv6 route, so glibc sorts IPv4 first, and that IPv4 path has been observed
# blackholed for a runner's egress IP: no RST, no ICMP, just silence. The
# egress IP is fixed for the whole job, so retrying cannot find a different
# source address, only outlast the block. `Fetcher._probe` makes that failure
# fast and truthful, but it cannot make it survivable.
#
# So the pinned 2025 bulk sources are mirrored as release assets on this repo.
# The mirror is tried FIRST and its sha256 is enforced STRICTLY: a mismatch
# means the asset was tampered with or badly uploaded, and the bake falls
# through to upstream rather than baking unknown bytes. Upstream keeps its
# recorded provenance in meta.json either way; a mirror is a transport detail,
# not a source. Verified byte-identical to upstream on 15 August 2026.
# ===========================================================================

MIRROR_BASE = "https://github.com/jdelsoir/behere/releases/download/data-2025/"

# cache filename -> sha256 of the upstream bytes, as published.
MIRRORED = {
    "sh_statbel_statistical_sectors_31370_20250101.geojson.zip":
        "93e87cf818ed649b9b478c3613104c9945dc6a2c449da7efb0d69224b2f08606",
}


# ===========================================================================
# Sources. `_fetch` entries are (cache filename, url) pairs the bake downloads.
# Everything without `_fetch` is a runtime source, described but never called
# here. Keys prefixed with "_" are stripped before meta.json is written.
# ===========================================================================

NAP_STATIC = ("https://api-management-discovery-production.azure-api.net"
              "/api/gtfs/feed/%s/static")
GTFS_OPERATORS = ("delijn", "nmbssncb", "stibmivb", "tec")

SOURCES = [
    dict(
        id="bosa_best_address",
        title="BeSt Address, Brussels / Flanders / Wallonia",
        publisher="BOSA / the three regional address authorities",
        url="https://opendata.bosa.be/download/best/openaddress-be{bru,vlg,wal}.zip",
        vintage="2025-01-01",
        licence="Open data, free reuse with attribution",
        role=("Authoritative address geometry. CONTRACT 12 correction 4: street "
              "names are already in the Statbel address file, so this join is "
              "not needed for names and the download is skipped by default."),
        runtime=False,
        _group="optional",
        _fetch=[("openaddress-be%s.zip" % r,
                 "https://opendata.bosa.be/download/best/openaddress-be%s.zip" % r)
                for r in ("bru", "vlg", "wal")],
    ),
    dict(
        id="catalog_datastore_brussels",
        title="Brussels regional open data catalogue (GeoNetwork)",
        publisher="Brussels-Capital Region",
        url="https://catalog.datastore.brussels/geonetwork/srv/eng/q?_content_type=json",
        vintage="live",
        licence="Unverified, discovery only (PLAN section 11)",
        role="Regional dataset discovery for the Brussels Around band.",
        runtime=True,
        _group="runtime",
    ),
    dict(
        id="geo_onroerenderfgoed",
        title="Flemish heritage boundaries, point in polygon",
        publisher="Agentschap Onroerend Erfgoed",
        url="https://geo.onroerenderfgoed.be/zoekdiensten/afbakeningen",
        vintage="live",
        licence="Open data, attribution requested",
        role="Protected monuments and landscapes at the device position. NL only.",
        runtime=True,
        _group="runtime",
    ),
    dict(
        id="geoservices_wallonie_tourism",
        title="Walloon tourism offer, ArcGIS REST",
        publisher="Service public de Wallonie",
        url=("https://geoservices.wallonie.be/arcgis/rest/services/TOURISME/"
             "OFFRES_TOURISTIQUES/MapServer"),
        vintage="live",
        licence="Open data Wallonie",
        role="13 layers of Walloon tourist offer, 2000 records per page. FR only.",
        runtime=True,
        _group="runtime",
    ),
    dict(
        id="irail_liveboard",
        title="iRail API v1",
        publisher="iRail / Open Knowledge Belgium",
        url="https://api.irail.be/v1/",
        vintage="live",
        licence="Open Data, attribution requested",
        role="Live train departures for the Go band.",
        runtime=True,
        _group="runtime",
    ),
    dict(
        id="nap_gtfs_rt",
        title="GTFS realtime, four operators via the Belgian NAP",
        publisher="FPS Mobility and Transport (NAP)",
        url=("https://api-management-discovery-production.azure-api.net"
             "/api/gtfs/feed/{operator}/rt/{trip-update|alert|vehicle-position}"),
        vintage="live",
        licence="Keyless open access via the Belgian NAP",
        role="Delay and alert overlay on the baked stop index.",
        runtime=True,
        _group="runtime",
    ),
    dict(
        id="nap_gtfs_static",
        title="GTFS static, De Lijn / TEC / STIB-MIVB / NMBS-SNCB",
        publisher="FPS Mobility and Transport (NAP)",
        url=NAP_STATIC.replace("%s", "{operator}"),
        vintage=VERIFIED_ON,
        licence="Keyless open access via the Belgian NAP",
        role=("stops.txt and translations.txt for all four operators. Baked, "
              "never fetched at runtime (287 MB)."),
        runtime=False,
        _group="core",
        _fetch=[("gtfs_%s.zip" % op, NAP_STATIC % op) for op in GTFS_OPERATORS],
        # HEAD returns 404 while GET returns 200, and Range: is ignored: a range
        # request pulls the full body. The fetcher never sends HEAD and treats a
        # 200 answer to a Range request as "start again from zero".
        _no_head=True,
    ),
    dict(
        id="ods_opendatasoft",
        title="Opendatasoft Explore v2.1, three city portals",
        publisher="Stad Gent / ODWB / City of Brussels",
        url="https://{data.stad.gent|www.odwb.be|opendata.brussels.be}/api/explore/v2.1/",
        vintage="live",
        licence="Per portal, open data",
        role=("Local city datasets for the Around band. Daily quota differs per "
              "portal (250,000 / 20,000 / 100,000); read x-ratelimit-limit."),
        runtime=True,
        _group="runtime",
    ),
    dict(
        id="statbel_addr_sector_2025",
        title="Addresses and statistical sectors, 2025-04-01",
        publisher="Statbel (Statistics Belgium)",
        url=("https://doc.statbel.fgov.be/publications/OpenData/"
             "TF_RGN_ADDRESSES_STAT_SECTORS_20250401.txt.zip"),
        vintage="2025-04-01",
        licence="Statbel open data",
        role=("The join spine: 4,490,779 addresses with NIS, street, postcode, "
              "WGS84 and the GRD_NEWID 1 km cell."),
        runtime=False,
        _group="core",
        _fetch=[("TF_RGN_ADDRESSES_STAT_SECTORS_20250401.txt.zip",
                 "https://doc.statbel.fgov.be/publications/OpenData/"
                 "TF_RGN_ADDRESSES_STAT_SECTORS_20250401.txt.zip")],
    ),
    dict(
        id="statbel_hvd",
        title="Statbel high-value datasets API",
        publisher="Statbel (Statistics Belgium)",
        url="https://opendata-api.statbel.fgov.be/",
        vintage="live",
        licence="Statbel open data",
        role=("Zoom out band. Columns are UPPERCASE and no table reaches "
              "municipality level, so queries key on nuts3."),
        runtime=True,
        _group="runtime",
    ),
    dict(
        id="statbel_refnis_2025",
        title="REFNIS municipality code list, situation 2025-01-01",
        publisher="Statbel (Statistics Belgium)",
        url="https://statbel.fgov.be/en/open-data/refnis-code-list",
        vintage="2025-01-01",
        licence="Statbel open data",
        role=("Source of municipalities.json and nis_history.json, both frozen "
              "and generated by scripts/build_municipalities.py."),
        runtime=False,
        _group="frozen",
    ),
    dict(
        id="statbel_sectors_2025",
        title="Statistical sectors, situation 2025-01-01",
        publisher="Statbel (Statistics Belgium)",
        url=("https://statbel.fgov.be/sites/default/files/files/opendata/"
             "Statistische%20sectoren/"
             "sh_statbel_statistical_sectors_31370_20250101.geojson.zip"),
        vintage="2025-01-01",
        licence="Statbel open data",
        role=("Sector polygons, and the point-in-polygon authority for every "
              "address's 2025 sector."),
        runtime=False,
        _group="core",
        _fetch=[("sh_statbel_statistical_sectors_31370_20250101.geojson.zip",
                 "https://statbel.fgov.be/sites/default/files/files/opendata/"
                 "Statistische%20sectoren/"
                 "sh_statbel_statistical_sectors_31370_20250101.geojson.zip")],
    ),
    dict(
        id="toerismevlaanderen_bulk",
        title="Toerisme Vlaanderen linked open data, bulk CSV",
        publisher="Toerisme Vlaanderen",
        url="https://linked.toerismevlaanderen.be/datasets",
        vintage="live",
        licence="Open data Vlaanderen",
        role=("Phase 2 POI source for the Flemish pilots. Fetched and counted; "
              "not emitted, because CONTRACT 7.2 defines no object schema for "
              "the grid shard `p` key."),
        runtime=False,
        _group="optional",
        # The bulk file lives behind a rotating UUID and the server forces
        # content-disposition: attachment. The current link is discovered from
        # the dataset page at fetch time.
        _fetch=[("toerismevlaanderen_public.csv", None)],
        _discover=("https://linked.toerismevlaanderen.be/datasets",
                   r'/files/[0-9a-f-]+/download\?name=public\.csv',
                   "https://linked.toerismevlaanderen.be"),
    ),
    dict(
        id="wallonia_tourism_bulk",
        title="Offres touristiques de Wallonie, bulk CSV",
        publisher="Service public de Wallonie",
        url=("https://geoservices.wallonie.be/geotraitement/spwdatadownload/"
             "results/91721175-5f01-410c-8c78-37c1d1893ba2/"
             "OFFRES_TOURISTIQUES_CSV.zip"),
        vintage="live",
        licence="Open data Wallonie",
        role=("Phase 2 POI source and the offline fallback for the Walloon "
              "ArcGIS layer. Fetched and counted; not emitted, because "
              "CONTRACT 7.2 defines no object schema for the shard `p` key."),
        runtime=False,
        _group="optional",
        _fetch=[("OFFRES_TOURISTIQUES_CSV.zip",
                 "https://geoservices.wallonie.be/geotraitement/spwdatadownload/"
                 "results/91721175-5f01-410c-8c78-37c1d1893ba2/"
                 "OFFRES_TOURISTIQUES_CSV.zip")],
    ),
]

SOURCE_BY_ID = {s["id"]: s for s in SOURCES}


# ===========================================================================
# Errors and logging
# ===========================================================================

class BakeError(RuntimeError):
    """Anything that must stop the bake with a non-zero exit."""


_T0 = time.time()
_QUIET = False


def log(msg, *args):
    if _QUIET:
        return
    if args:
        msg = msg % args
    sys.stderr.write("[%7.1fs] %s\n" % (time.time() - _T0, msg))
    sys.stderr.flush()


def out(msg="", *args):
    """The report. Goes to stdout so CI can capture it separately from the log."""
    if args:
        msg = msg % args
    sys.stdout.write(msg + "\n")


# ===========================================================================
# Serialisation, per CONTRACT 1.1
# ===========================================================================

def dumps(obj):
    """The one serialiser. Every shipped byte goes through here."""
    return json.dumps(
        obj, sort_keys=True, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8") + b"\n"


def gz_len(blob):
    """Gzipped size at level 9 with mtime pinned, so the number is stable."""
    return len(gzip.compress(blob, 9, mtime=0))


def assert_no_floats(obj, where):
    """CONTRACT 1.2: grid shards and <nis>/meta.json carry zero floats."""
    stack = [obj]
    while stack:
        o = stack.pop()
        if isinstance(o, float):
            raise BakeError("float leaked into %s: %r" % (where, o))
        if isinstance(o, dict):
            stack.extend(o.values())
        elif isinstance(o, (list, tuple)):
            stack.extend(o)


_SIXDP = re.compile(rb"-?[0-9]+\.[0-9]{6,}")


def delta(values):
    """Delta-encode a list of ints against a running sum starting at 0."""
    encoded = []
    prev = 0
    for v in values:
        encoded.append(v - prev)
        prev = v
    return encoded


PRECACHE_NAME = "precache.json"

# A manifest entry may only ever be a plain relative path to a baked file under
# web/data/. This rejects a leading slash, a backslash, any URL scheme, an
# authority ("//host/..."), and any parent segment.
_PRECACHE_BAD = re.compile(r"""(?x)
      ^/                                  # absolute path
    | ^[A-Za-z][A-Za-z0-9+.\-]*:          # https:, data:, javascript:
    | //                                  # protocol-relative or an authority
    | \\                                  # a Windows separator
    | (?:^|/)\.\.(?:/|$)                  # a parent segment
""")


def assert_baked_relpath(rel):
    """CONTRACT: precache.json lists baked files, and nothing else.

    THIS IS THE BAKE-TIME HALF OF THE OSM TILE PROHIBITION. web/sw.js
    precaches every entry of this manifest at install, across all seven pilot
    cities at once. The OSM tile usage policy forbids bulk downloading, and
    downloading an area of tiles for offline use IS bulk downloading, so a
    basemap tile must never be listed here -- nor any other absolute URL, which
    would also turn a static site's install step into an off-origin fetch loop.

    Structural rather than a denylist: no host can be named at all, so this
    cannot be defeated by a different tile server, a mirror or a CDN alias.
    """
    if not isinstance(rel, str) or not rel or _PRECACHE_BAD.search(rel):
        raise BakeError(
            "precache.json may only list plain relative paths under web/data/; "
            "refusing %r. An absolute URL here would make the service worker "
            "bulk-download off-origin at install, which for OSM tiles is an "
            "explicit breach of the tile usage policy." % (rel,))
    return rel


def precache_doc(relpaths, cells_by_city, cities, vintage=VINTAGE):
    """The manifest web/sw.js reads to store the whole release at install.

    PLAN phase 1's exit criterion is "every pilot city resolves offline from a
    COLD cache". A cache-first fetch rule cannot deliver that on its own: it
    only ever caches squares the user already stood in while online. So the
    service worker precaches this list at install, and this function is what
    keeps the list in step with the bake instead of hand-maintained in JS.

    Idempotent by construction: every list is sorted, every number is derived
    from the bytes on disk, and no wall-clock value appears anywhere. Carries
    the pinned vintage, which is also what verification gate 6 checks for.

    Every entry is put through assert_baked_relpath(), so an OSM tile -- or any
    other absolute URL -- cannot reach this document even if something upstream
    hands one in. See that function for why that matters.

    :param relpaths: iterable of paths relative to web/data/
    :param cells_by_city: {nis: [cell id, ...]}
    :param cities: the NIS codes shipped in this release
    """
    files = sorted(set(assert_baked_relpath(r)
                       for r in relpaths if r != PRECACHE_NAME))
    cells = {}
    for nis in sorted(cities):
        listed = sorted(set(cells_by_city.get(nis, ())))
        cells[nis] = ["grid/%s.json" % c for c in listed]
    return {
        "vintage": vintage,
        "count": len(files),
        "cities": sorted(cities),
        "cells": cells,
        "files": files,
    }


class Writer:
    """Writes the output tree and remembers every byte it wrote."""

    def __init__(self, root):
        self.root = root
        self.files = {}          # relative path -> (raw bytes, gz bytes)

    def write(self, relpath, blob):
        path = os.path.join(self.root, relpath)
        d = os.path.dirname(path)
        if d:
            os.makedirs(d, exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(blob)
        self.files[relpath] = (len(blob), gz_len(blob))
        return len(blob)

    def write_json(self, relpath, obj):
        return self.write(relpath, dumps(obj))


# ===========================================================================
# Fetching. Resumable, cached, streamed to disk. Never sends HEAD.
# ===========================================================================

def build_date():
    """Today in UTC, or SOURCE_DATE_EPOCH if the environment pins it."""
    sde = os.environ.get("SOURCE_DATE_EPOCH")
    if sde:
        return datetime.fromtimestamp(int(sde), timezone.utc).strftime("%Y-%m-%d")
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


class Fetcher:
    """Cache-first downloader.

    A file in the cache is trusted when its sidecar records the same byte count.
    Sidecars carry the retrieval date, which is what makes meta.json's `built`
    a property of the inputs rather than of the run: rebake from the same cache,
    get the same byte.

    A cached file with no sidecar is adopted (hashed, sidecar written) so a
    CI cache restore or a hand-seeded directory works without a re-download.

    ON CONNECT TIMEOUTS, AND WHY THERE IS A PROBE BEFORE EVERY DOWNLOAD
    ------------------------------------------------------------------
    `statbel.fgov.be` publishes both an A record (193.191.245.121) and an AAAA
    record. GitHub Actions runners have no IPv6 route, and the A record is
    reachable from most runner IPs but silently blackholes the SYN from some:
    no RST, no ICMP, just nothing. That combination produces a spectacularly
    misleading failure through plain `urlopen`:

      * `socket.create_connection` walks the getaddrinfo list. IPv4 sorts
        first (glibc, RFC 6724, no usable IPv6 source address).
      * The IPv4 connect hangs. `urlopen`'s `timeout` is 300 s here because
        the same number is the per-read timeout for a 212 MB stream, so the
        socket timeout never fires. The kernel's own SYN retry limit does,
        after tcp_syn_retries=6, which is 1+2+4+8+16+32+64 = 127 seconds.
      * The IPv6 address is then tried and fails instantly, ENETUNREACH.
      * `create_connection` re-raises the LAST error, so the caller is told
        "Network is unreachable" about an IPv6 address it never wanted, and
        the actual fault, a dead IPv4 path, is nowhere in the message.

    Each attempt therefore burned 127 s and lied about why. `_probe` connects
    to each address itself, IPv4 first, with a short deadline of its own, so a
    dead path costs CONNECT_TIMEOUT seconds instead of 127 and the log names
    every address and its real errno. The socket is closed immediately; the
    real transfer is still done by `urlopen`, which keeps redirect handling,
    TLS verification and resume exactly as they were.

    A runner's egress IP is fixed for the whole job, so retrying cannot find a
    different source address. The retry budget is wide (see `retries`) because
    waiting the block out inside the job is the only lever available.
    """

    # Per-address connect deadline. Short: an answering host completes in well
    # under a second from a runner, so anything slower is a dead path, not a
    # busy one.
    CONNECT_TIMEOUT = 15

    def __init__(self, cache_dir, offline=False, timeout=300, retries=11):
        self.cache_dir = cache_dir
        self.offline = offline
        self.timeout = timeout
        self.retries = retries
        os.makedirs(cache_dir, exist_ok=True)

    def _probe(self, url):
        """Open and close one TCP connection to `url`'s host, IPv4 first.

        Returns None when some address answered. Returns a human-readable
        string naming every address and its error when none did, which the
        caller turns into a retry rather than a 127-second stall.
        """
        parts = urllib.parse.urlsplit(url)
        host = parts.hostname
        port = parts.port or (443 if parts.scheme == "https" else 80)
        if not host:
            return None
        try:
            infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        except OSError as exc:
            return "%s: DNS failed: %r" % (host, exc)
        # IPv4 before IPv6: no runner has an IPv6 route, and an ENETUNREACH
        # from a trailing AAAA is what masked the real error before.
        infos.sort(key=lambda i: 0 if i[0] == socket.AF_INET else 1)
        errs = []
        for family, socktype, proto, _canon, addr in infos:
            sock = socket.socket(family, socktype, proto)
            sock.settimeout(self.CONNECT_TIMEOUT)
            try:
                sock.connect(addr)
                return None
            except OSError as exc:
                errs.append("%s: %s" % (addr[0], exc))
            finally:
                sock.close()
        return "%s unreachable (%s)" % (host, "; ".join(errs))

    def _sidecar(self, name):
        return os.path.join(self.cache_dir, name + ".fetchmeta.json")

    def sidecar(self, name):
        """The recorded provenance of a cached file, or None."""
        return self._read_sidecar(name)

    def _read_sidecar(self, name):
        p = self._sidecar(name)
        if not os.path.exists(p):
            return None
        try:
            with open(p, "rb") as fh:
                return json.loads(fh.read().decode("utf-8"))
        except (ValueError, OSError):
            return None

    def _write_sidecar(self, name, meta):
        with open(self._sidecar(name), "wb") as fh:
            fh.write(dumps(meta))

    def fetch(self, name, url):
        """Return (path, retrieved_date). Raises BakeError on failure."""
        final = os.path.join(self.cache_dir, name)
        side = self._read_sidecar(name)

        if os.path.exists(final):
            size = os.path.getsize(final)
            if side and side.get("bytes") == size:
                log("cache hit   %s (%s B, retrieved %s)",
                    name, f"{size:,}", side["retrieved"])
                return final, side["retrieved"]
            if side is None and size > 0:
                # Adopt a hand-seeded / CI-restored file.
                digest = _sha256_file(final)
                want = MIRRORED.get(name)
                if want and digest != want:
                    raise BakeError(
                        "%s: seeded cache file has sha256 %s, expected %s. "
                        "Delete it and re-fetch rather than baking unknown "
                        "bytes." % (name, digest, want))
                meta = {"bytes": size, "retrieved": build_date(),
                        "sha256": digest, "url": url or "", "adopted": True}
                self._write_sidecar(name, meta)
                log("cache adopt %s (%s B)", name, f"{size:,}")
                return final, meta["retrieved"]

        if self.offline:
            raise BakeError(
                "offline and %s is not in the cache (%s). Run without --offline "
                "or seed the cache directory." % (name, final))

        # Mirror first, upstream second. A mirrored asset must match its pinned
        # digest exactly; upstream is authoritative and only warns, so that a
        # republished-but-equivalent upstream file cannot break a rebuild.
        candidates = []
        if name in MIRRORED:
            candidates.append((MIRROR_BASE + name, True))
        if url:
            candidates.append((url, False))
        if not candidates:
            raise BakeError("no URL resolved for cache entry %s" % name)

        last_err = None
        part = final + ".part"
        for candidate, is_mirror in candidates:
            # A partial left by a previous candidate belongs to a different
            # URL. Resuming it with a Range against this one would splice two
            # unrelated bodies together.
            if os.path.exists(part):
                os.remove(part)
            try:
                digest = self._download(name, candidate, final)
            except BakeError as exc:
                last_err = str(exc)
                log("fetch failed %s from %s: %s", name, candidate, last_err)
                continue
            want = MIRRORED.get(name)
            if want and digest != want:
                if is_mirror:
                    os.remove(final)
                    last_err = ("mirror sha256 %s != pinned %s"
                                % (digest, want))
                    log("fetch reject %s: %s", name, last_err)
                    continue
                log("WARNING     %s: upstream sha256 %s != pinned %s. "
                    "Upstream is authoritative; the pin in MIRRORED is stale "
                    "and the mirror should be refreshed.", name, digest, want)
            if is_mirror:
                log("mirrored    %s (pinned sha256 verified)", name)
            meta = self._read_sidecar(name)
            return final, meta["retrieved"]

        raise BakeError("%s: every source failed. Last error: %s"
                        % (name, last_err))

    def _download(self, name, url, final):
        import urllib.error
        import urllib.request

        part = final + ".part"
        last_err = None
        for attempt in range(self.retries + 1):
            have = os.path.getsize(part) if os.path.exists(part) else 0

            # Fail fast and truthfully on a dead path. See the class docstring:
            # without this, a blackholed SYN costs 127 s and is then reported as
            # an IPv6 ENETUNREACH that has nothing to do with the real fault.
            dead = self._probe(url)
            if dead is not None:
                last_err = dead
                self._backoff(attempt, name, last_err)
                continue

            req = urllib.request.Request(url, headers={
                "User-Agent": UA,
                # Ask for raw bytes: urllib does not transparently decode, and a
                # gzip content-encoding on a zip would corrupt the resume maths.
                "Accept-Encoding": "identity",
            })
            if have:
                req.add_header("Range", "bytes=%d-" % have)
            try:
                resp = urllib.request.urlopen(req, timeout=self.timeout)
            except urllib.error.HTTPError as exc:
                if exc.code == 416 and have:
                    # The partial is already the whole file, or the server is
                    # confused. Either way, start over rather than guess.
                    os.remove(part)
                    last_err = "416 on resume, restarting"
                    log("fetch retry %s: %s", name, last_err)
                    continue
                if exc.code in (408, 429, 500, 502, 503, 504):
                    last_err = "HTTP %d" % exc.code
                    self._backoff(attempt, name, last_err)
                    continue
                raise BakeError("%s: HTTP %d fetching %s" % (name, exc.code, url))
            except (urllib.error.URLError, socket.timeout, OSError) as exc:
                last_err = repr(exc)
                self._backoff(attempt, name, last_err)
                continue

            status = getattr(resp, "status", None) or resp.getcode()
            headers = resp.headers
            if status == 206:
                total = _range_total(headers.get("Content-Range"))
                mode = "r+b"
            else:
                # 200 to a Range request means the server ignored it. The NAP
                # /static endpoints and the SPW download service both do this:
                # a 100 KB range request returns the full body. Start at zero.
                have = 0
                clen = headers.get("Content-Length")
                total = int(clen) if clen and clen.isdigit() else None
                mode = "wb"

            log("fetch       %s <- %s (HTTP %d%s)", name, url, status,
                ", resuming at %s B" % f"{have:,}" if have else "")
            try:
                written = self._stream(resp, part, mode, have, total, name)
            except (urllib.error.URLError, socket.timeout, OSError) as exc:
                last_err = repr(exc)
                self._backoff(attempt, name, last_err)
                continue
            finally:
                resp.close()

            if total is not None and written != total:
                last_err = "short read: %d of %d bytes" % (written, total)
                self._backoff(attempt, name, last_err)
                continue

            digest = _sha256_file(part)
            os.replace(part, final)
            self._write_sidecar(name, {
                "bytes": written,
                "retrieved": build_date(),
                "sha256": digest,
                "url": url,
            })
            log("fetched     %s (%s B, sha256 %s)", name, f"{written:,}",
                digest[:16])
            return digest

        raise BakeError("%s: giving up after %d attempts (%s)"
                        % (name, self.retries + 1, last_err))

    def _stream(self, resp, part, mode, start, total, name):
        os.makedirs(os.path.dirname(part) or ".", exist_ok=True)
        written = start
        next_log = LOG_EVERY
        with open(part, mode) as fh:
            if mode == "r+b":
                fh.seek(start)
                fh.truncate(start)
            while True:
                chunk = resp.read(DOWNLOAD_CHUNK)
                if not chunk:
                    break
                fh.write(chunk)
                written += len(chunk)
                if written >= next_log:
                    log("  ... %s %s B%s", name, f"{written:,}",
                        " of %s" % f"{total:,}" if total else "")
                    next_log += LOG_EVERY
        return written

    def _backoff(self, attempt, name, why):
        # Capped at 90 s. With retries=11 that is a retry window of roughly
        # eleven minutes, which is the only lever available against a host that
        # is blackholing this runner's egress IP: the IP is fixed for the whole
        # job, so retrying cannot find a different source address, it can only
        # outlast the block. Well inside the 90-minute job timeout.
        wait = min(90, 2 ** attempt)
        log("fetch retry %s in %ds: %s", name, wait, why)
        time.sleep(wait)


def _range_total(content_range):
    if not content_range:
        return None
    tail = content_range.rsplit("/", 1)[-1].strip()
    return int(tail) if tail.isdigit() else None


def _sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            chunk = fh.read(1 << 20)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def discover_url(page_url, pattern, base, timeout=60):
    """Resolve a rotating download link by reading its listing page."""
    import urllib.request
    req = urllib.request.Request(page_url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        html = resp.read().decode("utf-8", "replace")
    m = re.search(pattern, html)
    if not m:
        raise BakeError("could not discover a download link on %s" % page_url)
    return base + m.group(0)


# ===========================================================================
# Streaming GeoJSON: yield each Feature's raw bytes without loading the file
# ===========================================================================

_STRUCT = re.compile(rb'[\{\}\[\]"]')


def _escaped(buf, pos):
    """True when buf[pos] is preceded by an odd run of backslashes."""
    n = 0
    i = pos - 1
    while i >= 0 and buf[i:i + 1] == b"\\":
        n += 1
        i -= 1
    return n % 2 == 1


def iter_geojson_features(stream, chunk_size=1 << 20):
    """Yield the raw bytes of every object inside the top-level features array.

    Works on pretty-printed, line-delimited and single-line GeoJSON alike, and
    never holds more than one feature plus one chunk in memory.
    """
    buf = b""
    scan = 0                # next byte to look at
    found_key = False       # seen the "features" key
    in_array = False        # seen the '[' that opens the feature array
    in_str = False
    depth = 0
    start = None
    eof = False

    while True:
        if not eof:
            data = stream.read(chunk_size)
            if data:
                buf += data
            else:
                eof = True
        if not found_key:
            i = buf.find(b'"features"', scan)
            if i < 0:
                if eof:
                    raise BakeError("no top-level 'features' array in the GeoJSON")
                # Keep a small overlap so the key cannot straddle a boundary.
                if len(buf) > 64:
                    drop = len(buf) - 64
                    buf = buf[drop:]
                scan = 0
                continue
            found_key = True
            scan = i + len(b'"features"')
        if not in_array:
            j = buf.find(b"[", scan)
            if j < 0:
                if eof:
                    raise BakeError("'features' key is not followed by an array")
                continue
            in_array = True
            scan = j + 1

        consumed_to = scan
        for m in _STRUCT.finditer(buf, scan):
            ch = buf[m.start():m.start() + 1]
            if in_str:
                if ch == b'"' and not _escaped(buf, m.start()):
                    in_str = False
                continue
            if ch == b'"':
                in_str = True
                continue
            if ch == b"{":
                if depth == 0:
                    start = m.start()
                depth += 1
            elif ch == b"}":
                depth -= 1
                if depth == 0 and start is not None:
                    yield buf[start:m.start() + 1]
                    start = None
                    consumed_to = m.start() + 1
            elif ch == b"]" and depth == 0:
                return
        scan = len(buf)
        if start is None:
            if consumed_to > 0:
                buf = buf[consumed_to:]
                scan -= consumed_to
        elif start > 0:
            buf = buf[start:]
            scan -= start
            start = 0
        if eof:
            if depth or start is not None:
                raise BakeError("GeoJSON ended inside a feature object")
            return


_RE_REFNIS = re.compile(r'"cd_munty_refnis"\s*:\s*"(\d{5})"')
_RE_NUTS3 = re.compile(r'"cd_nuts_lvl3"\s*:\s*"([A-Z0-9]+)"')
_HEAD_BYTES = 4096


# ===========================================================================
# Point in polygon, in EPSG:31370 metres. CONTRACT 6.1.
# ===========================================================================

class SectorIndex:
    """Uniform-grid point location over one municipality's sector polygons.

    The address file carries XY_X_LB72 / XY_Y_LB72 and the sector geometry is
    published in EPSG:31370, so the test runs in the source projection: no
    reprojection error enters the sector assignment.
    """

    CELL = 200.0  # metres

    def __init__(self, features):
        self.polys = []      # (sector_code, outer, holes, minx, miny, maxx, maxy)
        for code, rings_by_poly in features:
            for rings in rings_by_poly:
                if not rings:
                    continue
                outer = _ring_arrays(rings[0])
                holes = [_ring_arrays(r) for r in rings[1:]]
                self.polys.append((code, outer, holes) + outer[2])
        # Deterministic order: lowest sector code wins any overlap.
        self.polys.sort(key=lambda p: (p[0], p[3], p[4]))
        self.buckets = {}
        for idx, p in enumerate(self.polys):
            minx, miny, maxx, maxy = p[3], p[4], p[5], p[6]
            gx0 = int(math.floor(minx / self.CELL))
            gx1 = int(math.floor(maxx / self.CELL))
            gy0 = int(math.floor(miny / self.CELL))
            gy1 = int(math.floor(maxy / self.CELL))
            for gx in range(gx0, gx1 + 1):
                for gy in range(gy0, gy1 + 1):
                    self.buckets.setdefault((gx, gy), []).append(idx)

    def locate(self, x, y):
        """Sector code containing (x, y), or "" when no polygon contains it."""
        key = (int(math.floor(x / self.CELL)), int(math.floor(y / self.CELL)))
        for idx in self.buckets.get(key, ()):
            code, outer, holes, minx, miny, maxx, maxy = self.polys[idx]
            if x < minx or x > maxx or y < miny or y > maxy:
                continue
            if not _pip(outer, x, y):
                continue
            if any(_pip(h, x, y) for h in holes):
                continue
            return code
        return ""


def _ring_arrays(ring):
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return (xs, ys, (min(xs), min(ys), max(xs), max(ys)))


def _pip(ring, px, py):
    """Crossing-number test. Deterministic; boundary points fall consistently."""
    xs, ys, (minx, miny, maxx, maxy) = ring
    if px < minx or px > maxx or py < miny or py > maxy:
        return False
    inside = False
    n = len(xs)
    j = n - 1
    for i in range(n):
        yi = ys[i]
        yj = ys[j]
        if (yi > py) != (yj > py):
            xi = xs[i]
            if px < xi + (py - yi) * (xs[j] - xi) / (yj - yi):
                inside = not inside
        j = i
    return inside


# ===========================================================================
# Stage 1: sector geometry
# ===========================================================================

def load_sectors(path, cities):
    """Stream the sector zip. Returns (per-city features, national nuts3 map)."""
    zf = zipfile.ZipFile(path)
    member = None
    for info in zf.infolist():
        if info.filename.endswith(".geojson") and not info.is_dir():
            member = info.filename
            break
    if member is None:
        raise BakeError("no .geojson member inside %s" % path)
    log("sectors     reading %s (%s B uncompressed)",
        member, f"{zf.getinfo(member).file_size:,}")

    per_city = {nis: [] for nis in cities}
    nuts3 = {}
    seen = 0
    with zf.open(member) as raw:
        for blob in iter_geojson_features(raw):
            seen += 1
            head = blob[:_HEAD_BYTES].decode("utf-8", "replace")
            m_nis = _RE_REFNIS.search(head)
            m_n3 = _RE_NUTS3.search(head)
            if m_nis is None or m_n3 is None:
                feat = json.loads(blob.decode("utf-8"))
                props = feat["properties"]
                nis = props["cd_munty_refnis"]
                nuts3[nis] = props.get("cd_nuts_lvl3") or None
                if nis not in per_city:
                    continue
            else:
                nis = m_nis.group(1)
                nuts3[nis] = m_n3.group(1)
                if nis not in per_city:
                    continue
                feat = json.loads(blob.decode("utf-8"))
                props = feat["properties"]
            geom = feat["geometry"]
            if geom["type"] == "Polygon":
                polys = [geom["coordinates"]]
            elif geom["type"] == "MultiPolygon":
                polys = geom["coordinates"]
            else:
                raise BakeError("unexpected sector geometry type %r" % geom["type"])
            per_city[nis].append({
                "s": props["cd_sector"],
                "nl": props.get("tx_sector_descr_nl") or "",
                "fr": props.get("tx_sector_descr_fr") or "",
                "de": props.get("tx_sector_descr_de") or "",
                "polys": polys,
            })
    zf.close()

    if seen < 1000:
        raise BakeError("only %d sector features parsed; the stream reader is "
                        "not seeing the file" % seen)
    for nis in cities:
        if not per_city[nis]:
            raise BakeError("no sector geometry for NIS %s" % nis)
    log("sectors     %d features scanned, %d municipalities carry nuts3",
        seen, len(nuts3))
    for nis in sorted(cities):
        log("  %s %-18s %4d sectors", nis, PILOTS.get(nis, "?"), len(per_city[nis]))
    return per_city, nuts3


def build_sector_geojson(nis, features):
    """Reproject, run the tolerance ladder, return (blob, tolerance, count)."""
    converted = []
    for feat in sorted(features, key=lambda f: f["s"]):
        polys = [[[list(lb72_to_wgs84(x, y)) for x, y in ring] for ring in poly]
                 for poly in feat["polys"]]
        converted.append((feat, polys))

    blob = None
    tol = SECTOR_LADDER[-1]
    kept = 0
    for tol in SECTOR_LADDER:
        emitted = []
        for feat, polys in converted:
            new_polys = []
            for poly in polys:
                new_rings = []
                for ring in poly:
                    simplified = simplify_ring_lonlat(ring, tol)
                    rounded = _round_ring(simplified)
                    if len(rounded) >= 4:
                        new_rings.append(rounded)
                if new_rings:
                    new_polys.append(new_rings)
            if not new_polys:
                continue
            emitted.append({
                "type": "Feature",
                "geometry": {"type": "MultiPolygon", "coordinates": new_polys},
                "properties": {"s": feat["s"], "nl": feat["nl"],
                               "fr": feat["fr"], "de": feat["de"]},
            })
        blob = dumps({
            "type": "FeatureCollection",
            "features": emitted,
            "properties": {"nis": nis, "tolerance_m": tol,
                           "vintage": VINTAGE, "dp": COORD_DP},
        })
        kept = len(emitted)
        if len(blob) <= SECTOR_MAX_BYTES:
            break

    if len(blob) > SECTOR_MAX_BYTES:
        raise BakeError(
            "NIS %s sector.geojson is %d B at the coarsest rung (%d m); the "
            "ladder in CONTRACT 6.2 does not reach the 150,000 B cap"
            % (nis, len(blob), tol))
    if _SIXDP.search(blob):
        raise BakeError("NIS %s sector.geojson carries more than 5 decimals" % nis)
    return blob, tol, kept


def _round_ring(ring):
    """Round to 5 dp, drop consecutive duplicates, re-close. CONTRACT 6.2."""
    result = []
    prev = None
    for lon, lat in ring:
        point = [round(lon, COORD_DP), round(lat, COORD_DP)]
        if point != prev:
            result.append(point)
        prev = point
    if len(result) >= 2 and result[0] != result[-1]:
        result.append(result[0])
    return result


# ===========================================================================
# Stage 2: addresses
# ===========================================================================

ADDR_MEMBER_SUFFIX = ".txt"

REQUIRED_COLUMNS = (
    "CD_REFNIS", "CD_ZIP", "CD_STR", "TX_STR_NM_NL", "TX_STR_NM_FR",
    "TX_STR_NM_DE", "TX_HO_NR", "XY_X_LB72", "XY_Y_LB72",
    "XY_LON_WGS84", "XY_LAT_WGS84", "GRD_NEWID",
)


def open_address_stream(path, sample):
    """Return (binary stream, closer, label).

    The sample fixture and the real archive both come out of here as a binary
    stream of the identical pipe-delimited text, so --sample exercises the same
    parsing, filtering, point-in-polygon and sharding code as a full run.
    """
    if sample:
        fh = open(sample, "rb")
        return fh, fh.close, sample
    zf = zipfile.ZipFile(path)
    member = None
    for info in zf.infolist():
        if info.filename.endswith(ADDR_MEMBER_SUFFIX) and not info.is_dir():
            member = info.filename
            break
    if member is None:
        raise BakeError("no .txt member inside %s" % path)
    stream = zf.open(member)

    def close():
        stream.close()
        zf.close()

    return stream, close, "%s!%s" % (os.path.basename(path), member)


class AddressPass:
    """One streaming pass over the address file."""

    def __init__(self, cities, indexes):
        self.cities = cities
        self.indexes = indexes
        self.rows = {nis: [] for nis in cities}      # nis -> list of tuples
        self.cells = {nis: set() for nis in cities}
        self.streets = {nis: {} for nis in cities}   # id -> [nl, fr, de]
        self.zips = {nis: set() for nis in cities}
        self.foreign = {}                            # (cell, nis) -> count
        self.total = 0
        self.kept = 0
        self.no_cell = 0
        self.no_coord = 0
        self.pip_miss = 0

    def run(self, stream, label):
        text = io.TextIOWrapper(stream, encoding="utf-8", newline="")
        header = text.readline().rstrip("\r\n")
        cols = header.split("|")
        idx = {name: i for i, name in enumerate(cols)}
        missing = [c for c in REQUIRED_COLUMNS if c not in idx]
        if missing:
            raise BakeError("%s is missing columns %s" % (label, missing))
        ncols = len(cols)
        c_nis = idx["CD_REFNIS"]
        c_cell = idx["GRD_NEWID"]
        cell_is_last = (c_cell == ncols - 1)
        if c_nis != 0:
            raise BakeError("CD_REFNIS is not the first column in %s" % label)
        c_zip, c_str = idx["CD_ZIP"], idx["CD_STR"]
        c_nl, c_fr, c_de = (idx["TX_STR_NM_NL"], idx["TX_STR_NM_FR"],
                            idx["TX_STR_NM_DE"])
        c_ho = idx["TX_HO_NR"]
        c_xl, c_yl = idx["XY_X_LB72"], idx["XY_Y_LB72"]
        c_lon, c_lat = idx["XY_LON_WGS84"], idx["XY_LAT_WGS84"]

        cities = self.cities
        foreign = self.foreign
        log("addresses   streaming %s", label)
        for line in text:
            line = line.rstrip("\r\n")
            if not line:
                continue
            self.total += 1
            if self.total % 500000 == 0:
                log("  ... %s rows read, %s kept", f"{self.total:,}",
                    f"{self.kept:,}")
            nis = line.partition("|")[0]
            if nis not in cities:
                cell = (line.rsplit("|", 1)[-1] if cell_is_last
                        else line.split("|")[c_cell])
                if cell:
                    key = (cell, nis)
                    foreign[key] = foreign.get(key, 0) + 1
                continue
            parts = line.split("|")
            if len(parts) != ncols:
                raise BakeError("row %d of %s has %d columns, expected %d"
                                % (self.total, label, len(parts), ncols))
            cell = parts[c_cell]
            if not cell:
                self.no_cell += 1
                continue
            lon_s, lat_s = parts[c_lon], parts[c_lat]
            xl_s, yl_s = parts[c_xl], parts[c_yl]
            if not lon_s or not lat_s or not xl_s or not yl_s:
                self.no_coord += 1
                continue
            lon_u = int(round(float(lon_s) * 1e5))
            lat_u = int(round(float(lat_s) * 1e5))
            sector = self.indexes[nis].locate(float(xl_s), float(yl_s))
            if not sector:
                self.pip_miss += 1
            street_id = int(parts[c_str])
            names = self.streets[nis].get(street_id)
            if names is None:
                self.streets[nis][street_id] = [parts[c_nl], parts[c_fr],
                                                parts[c_de]]
            else:
                for k, col in ((0, c_nl), (1, c_fr), (2, c_de)):
                    if not names[k] and parts[col]:
                        names[k] = parts[col]
            zip_code = parts[c_zip]
            self.zips[nis].add(zip_code)
            self.cells[nis].add(cell)
            self.rows[nis].append(
                (cell, street_id, parts[c_ho], lat_u, lon_u, sector, zip_code))
            self.kept += 1

        log("addresses   %s rows read, %s kept for %d municipalities",
            f"{self.total:,}", f"{self.kept:,}", len(cities))
        if self.no_cell:
            log("addresses   %d rows dropped: no GRD_NEWID", self.no_cell)
        if self.no_coord:
            log("addresses   %d rows dropped: no coordinates", self.no_coord)
        if self.pip_miss:
            log("addresses   %d rows fell outside every 2025 sector polygon; "
                "they ship with the \"\" sentinel (CONTRACT 12)", self.pip_miss)
        for nis in sorted(cities):
            if not self.rows[nis]:
                raise BakeError(
                    "no addresses found for NIS %s (%s). Refusing to emit a "
                    "partial shard set." % (nis, PILOTS.get(nis, "?")))


def house_number(raw):
    """CONTRACT 7.2: int when purely numeric with no leading zero, else string."""
    if raw.isascii() and raw.isdigit() and (raw == "0" or raw[0] != "0"):
        return int(raw)
    return raw


# ===========================================================================
# Stage 3: GTFS stops
# ===========================================================================

STOP_LANGS = frozenset({"nl", "fr", "de"})


def load_stops(paths_by_operator, wanted_cells):
    """stops.txt only, sharded by 1 km cell. Nothing else is retained."""
    by_cell = {}
    for operator in GTFS_OPERATORS:
        path = paths_by_operator.get(operator)
        if not path:
            raise BakeError("GTFS feed for %s was not fetched" % operator)
        zf = zipfile.ZipFile(path)
        names = set(zf.namelist())
        if "stops.txt" not in names:
            raise BakeError("%s has no stops.txt" % path)

        # translations.txt carries authored NL/FR/DE stop names (CONTRACT 7.7).
        # It is read, never written: no GTFS table other than stops is emitted.
        # NMBS also authors an `en` translation. CONTRACT 7.2 types `t` as
        # {fr, nl, de} only, so `en` is dropped here; see the report.
        translations = {}
        if "translations.txt" in names:
            with zf.open("translations.txt") as raw:
                reader = csv.DictReader(
                    io.TextIOWrapper(raw, encoding="utf-8-sig", newline=""))
                for row in reader:
                    if (row.get("table_name") == "stops"
                            and row.get("field_name") == "stop_name"):
                        value = row.get("field_value") or ""
                        lang = row.get("language") or ""
                        text = row.get("translation") or ""
                        if value and lang in STOP_LANGS and text:
                            translations.setdefault(value, {})[lang] = text

        raw_rows = 0
        kept = 0
        parents = 0
        with zf.open("stops.txt") as raw:
            reader = csv.DictReader(
                io.TextIOWrapper(raw, encoding="utf-8-sig", newline=""))
            for row in reader:
                raw_rows += 1
                if (row.get("location_type") or "0") != "0":
                    parents += 1
                    continue
                lat_s = (row.get("stop_lat") or "").strip()
                lon_s = (row.get("stop_lon") or "").strip()
                if not lat_s or not lon_s:
                    continue
                try:
                    lat = float(lat_s)
                    lon = float(lon_s)
                except ValueError:
                    continue
                cell = wgs84_to_cell(lat, lon)
                if cell not in wanted_cells:
                    continue
                name = row.get("stop_name") or ""
                stop = {
                    "o": operator,
                    "i": row.get("stop_id") or "",
                    "n": name,
                    "_lat_u": int(round(lat * 1e5)),
                    "_lon_u": int(round(lon * 1e5)),
                }
                tr = translations.get(name)
                if tr:
                    stop["t"] = dict(tr)
                parent = row.get("parent_station") or ""
                if parent:
                    stop["ps"] = parent
                by_cell.setdefault(cell, []).append(stop)
                kept += 1
        zf.close()
        log("gtfs        %-9s %6d rows, %5d non-platform records dropped "
            "(location_type != 0), %4d stops inside shipped cells, "
            "%d translated names",
            operator, raw_rows, parents, kept, len(translations))

    for cell in by_cell:
        by_cell[cell].sort(key=lambda s: (s["o"], s["i"]))
    return by_cell


# ===========================================================================
# Stage 4: emit
# ===========================================================================

def language_for(nis, rgn):
    """CONTRACT 4.1, fully determined by region plus the nine DE municipalities."""
    if rgn == "02000":
        return {"default": "nl", "official": ["nl"]}
    if rgn == "04000":
        return {"default": "fr", "official": ["fr", "nl"]}
    if rgn == "03000" and nis in DE_COMMUNITY:
        return {"default": "de", "official": ["de"]}
    return {"default": "fr", "official": ["fr"]}


def build_streets(nis, streets):
    ids = sorted(streets)
    obj = {
        "nis": nis,
        "n": len(ids),
        "id": delta(ids),
        "vintage": VINTAGE,
    }
    for pos, lang in enumerate(("nl", "fr", "de")):
        column = [streets[i][pos] for i in ids]
        if any(column):
            obj[lang] = column
    for i in ids:
        if not any(streets[i]):
            raise BakeError(
                "street %d in NIS %s has no name in nl, fr or de; resolver "
                "step 4 would fail (CONTRACT 13 gate 5)" % (i, nis))
    return obj


def build_shard(cell, rows, stops, foreign_here):
    """One grid/<cell>.json object. Zero floats by construction.

    Row layout: (cell, street_id, house, lat_u, lon_u, sector, zip, nis).
    CONTRACT 7.2 fixes the first three sort keys; the rest are tie-breakers that
    exist only so the order cannot depend on dict or set iteration.
    """
    rows = sorted(rows, key=lambda r: (r[1], len(r[2]), r[2], r[7], r[3], r[4]))
    lat_min = min([r[3] for r in rows] + [s["_lat_u"] for s in stops])
    lon_min = min([r[4] for r in rows] + [s["_lon_u"] for s in stops])
    # CONTRACT 7.3: floor to 2 dp, in integer 1e-5-degree units, so adding one
    # address cannot move the origin and rewrite every offset in the shard.
    origin_lat = (lat_min // 1000) * 1000
    origin_lon = (lon_min // 1000) * 1000

    municipalities = sorted({r[7] for r in rows})
    m_index = {nis: i for i, nis in enumerate(municipalities)}

    sectors = sorted({r[5] for r in rows})
    s_index = {code: i for i, code in enumerate(sectors)}
    zips = sorted({r[6] for r in rows})
    z_index = {code: i for i, code in enumerate(zips)}

    addresses = {
        "n": len(rows),
        "st": delta([r[1] for r in rows]),
        "h": [house_number(r[2]) for r in rows],
        "y": delta([r[3] - origin_lat for r in rows]),
        "x": delta([r[4] - origin_lon for r in rows]),
        "sc": sectors,
        "s": delta([s_index[r[5]] for r in rows]),
        "zt": zips,
        "z": delta([z_index[r[6]] for r in rows]),
    }
    if len(municipalities) > 1:
        addresses["mi"] = delta([m_index[r[7]] for r in rows])

    shard = {
        "c": cell,
        "v": VINTAGE,
        "o": [origin_lat, origin_lon],
        "m": municipalities,
        "a": addresses,
    }
    if stops:
        emitted = []
        for stop in stops:
            entry = {k: v for k, v in stop.items() if not k.startswith("_")}
            entry["y"] = stop["_lat_u"] - origin_lat
            entry["x"] = stop["_lon_u"] - origin_lon
            emitted.append(entry)
        shard["t"] = emitted
    if foreign_here:
        shard["fm"] = dict(foreign_here)
    assert_no_floats(shard, "grid/%s.json" % cell)
    return shard


def augment_municipalities(src_path, nuts3):
    """CONTRACT 3: add nuts3 to the frozen municipalities.json."""
    with open(src_path, "rb") as fh:
        data = json.loads(fh.read().decode("utf-8"))
    added = 0
    for nis, record in data["municipalities"].items():
        value = nuts3.get(nis)
        if value and record.get("nuts3") != value:
            record["nuts3"] = value
            added += 1
    return data, added


# ===========================================================================
# Optional POI sources: fetched, counted, deliberately not emitted
# ===========================================================================

def count_poi(paths):
    """Report record counts only. CONTRACT 7.2 gives `p` no object schema."""
    report = []
    tvl = paths.get("toerismevlaanderen_public.csv")
    if tvl and os.path.exists(tvl):
        n = 0
        with open(tvl, "r", encoding="utf-8", newline="") as fh:
            for _ in csv.reader(fh, delimiter=";"):
                n += 1
        report.append(("toerismevlaanderen_bulk", max(0, n - 1)))
    wal = paths.get("OFFRES_TOURISTIQUES_CSV.zip")
    if wal and os.path.exists(wal):
        n = 0
        zf = zipfile.ZipFile(wal)
        for info in zf.infolist():
            if info.filename.lower().endswith(".csv"):
                with zf.open(info) as raw:
                    for _ in io.TextIOWrapper(raw, encoding="utf-8",
                                              errors="replace", newline=""):
                        n += 1
                break
        zf.close()
        report.append(("wallonia_tourism_bulk", max(0, n - 1)))
    return report


# ===========================================================================
# Main
# ===========================================================================

def parse_args(argv):
    p = argparse.ArgumentParser(
        prog="bake.py",
        description="Build web/data from the pinned 2025 sources. "
                    "Byte-identical for identical input.")
    p.add_argument("--out", default=os.path.join(_REPO, "web", "data"),
                   help="output tree (default: web/data)")
    p.add_argument("--cache-dir", default=os.path.join(_REPO, ".cache", "bake"),
                   help="download cache (default: .cache/bake)")
    p.add_argument("--cities", default="",
                   help="comma-separated NIS codes; default is every pilot")
    p.add_argument("--sample", default="",
                   help="read this pre-extracted address fixture instead of "
                        "downloading the 212 MB archive. Same code path.")
    p.add_argument("--with-optional", action="store_true",
                   help="also fetch BeSt Address and the two tourism bulk files")
    p.add_argument("--offline", action="store_true",
                   help="never touch the network; a cache miss is fatal")
    p.add_argument("--max-gz-bytes", type=int, default=BUDGET_MAX_GZ,
                   help="fail if the shipped tree exceeds this gzipped size")
    p.add_argument("--quiet", action="store_true", help="suppress the progress log")
    return p.parse_args(argv)


def main(argv=None):
    global _QUIET
    args = parse_args(argv if argv is not None else sys.argv[1:])
    _QUIET = args.quiet

    if args.cities:
        cities = [c.strip() for c in re.split(r"[,\s]+", args.cities) if c.strip()]
        unknown = [c for c in cities if not re.fullmatch(r"\d{5}", c)]
        if unknown:
            raise BakeError("not NIS codes: %s" % unknown)
    else:
        cities = sorted(PILOTS)
    cities = sorted(set(cities))
    partial = set(cities) != set(PILOTS)

    out_root = os.path.abspath(args.out)
    fetcher = Fetcher(os.path.abspath(args.cache_dir), offline=args.offline)

    log("bake        contract v%d, vintage %s, %d municipalities",
        CONTRACT_VERSION, VINTAGE, len(cities))
    if args.sample:
        log("bake        SAMPLE MODE: addresses come from %s. The output is a "
            "pipeline validation, not a release.", args.sample)
    if partial:
        log("bake        PARTIAL SET %s: grid/ is rebuilt from these "
            "municipalities only.", ",".join(cities))

    # --- fetch -------------------------------------------------------------
    retrieved = {}
    fetched_paths = {}
    for source in SOURCES:
        group = source.get("_group")
        if group == "optional" and not args.with_optional:
            retrieved[source["id"]] = VERIFIED_ON
            log("skip        %s (optional; --with-optional to fetch)", source["id"])
            continue
        entries = source.get("_fetch")
        if not entries:
            retrieved[source["id"]] = VERIFIED_ON
            continue
        if (source["id"] == "statbel_addr_sector_2025" and args.sample):
            # The fixture replaces the payload, not the provenance. Reuse the
            # cached archive's retrieval date when it exists so meta.json still
            # describes the real source; otherwise fall back to the probe date.
            side = fetcher.sidecar(entries[0][0])
            retrieved[source["id"]] = side["retrieved"] if side else VERIFIED_ON
            log("skip        %s (--sample supplies the rows)", source["id"])
            continue
        dates = []
        for name, url in entries:
            if url is None and source.get("_discover"):
                page, pattern, base = source["_discover"]
                cached = fetcher.sidecar(name)
                if cached and os.path.exists(os.path.join(fetcher.cache_dir, name)):
                    url = cached.get("url") or ""
                else:
                    url = discover_url(page, pattern, base)
                    log("discover    %s -> %s", source["id"], url)
            path, date = fetcher.fetch(name, url)
            fetched_paths[name] = path
            dates.append(date)
        retrieved[source["id"]] = max(dates)

    # --- stage 1: sectors --------------------------------------------------
    sector_zip = fetched_paths[
        "sh_statbel_statistical_sectors_31370_20250101.geojson.zip"]
    sector_features, nuts3 = load_sectors(sector_zip, cities)
    indexes = {}
    for nis in cities:
        indexes[nis] = SectorIndex(
            [(f["s"], f["polys"]) for f in sector_features[nis]])
    log("sectors     point-in-polygon index built for %d municipalities",
        len(indexes))

    # --- stage 2: addresses ------------------------------------------------
    addr_zip = fetched_paths.get(
        "TF_RGN_ADDRESSES_STAT_SECTORS_20250401.txt.zip")
    if args.sample and not os.path.exists(args.sample):
        raise BakeError("--sample file not found: %s" % args.sample)
    stream, closer, label = open_address_stream(addr_zip, args.sample)
    passer = AddressPass(set(cities), indexes)
    try:
        passer.run(stream, label)
    finally:
        closer()

    all_cells = set()
    for nis in cities:
        all_cells |= passer.cells[nis]
    log("grid        %d distinct 1 km cells carry shipped addresses",
        len(all_cells))

    # --- stage 3: stops ----------------------------------------------------
    gtfs_paths = {op: fetched_paths["gtfs_%s.zip" % op] for op in GTFS_OPERATORS}
    stops_by_cell = load_stops(gtfs_paths, all_cells)
    log("gtfs        %d stops across %d cells",
        sum(len(v) for v in stops_by_cell.values()), len(stops_by_cell))

    # --- stage 4: emit -----------------------------------------------------
    writer = Writer(out_root)
    grid_dir = os.path.join(out_root, "grid")
    if os.path.isdir(grid_dir):
        shutil.rmtree(grid_dir)
    for nis in cities:
        city_dir = os.path.join(out_root, nis)
        if os.path.isdir(city_dir):
            shutil.rmtree(city_dir)

    src_munty = os.path.join(_REPO, "web", "data", "municipalities.json")
    src_hist = os.path.join(_REPO, "web", "data", "nis_history.json")
    for path in (src_munty, src_hist):
        if not os.path.exists(path):
            raise BakeError("frozen input missing: %s" % path)
    munty_doc, added = augment_municipalities(src_munty, nuts3)
    writer.write_json("municipalities.json", munty_doc)
    log("shared      municipalities.json (+nuts3 on %d records)", added)
    with open(src_hist, "rb") as fh:
        writer.write("nis_history.json", fh.read())

    # CONTRACT 8: the override files are hand-written and human-reviewed.
    # bake.py copies and validates them, and must never generate them.
    src_i18n_dir = os.path.join(_REPO, "web", "data", "i18n")
    i18n_note = None
    copied = []
    if os.path.isdir(src_i18n_dir):
        for name in sorted(os.listdir(src_i18n_dir)):
            if not name.endswith(".json"):
                continue
            src = os.path.join(src_i18n_dir, name)
            with open(src, "rb") as fh:
                blob = fh.read()
            try:
                json.loads(blob.decode("utf-8"))
            except ValueError as exc:
                raise BakeError("i18n/%s is not valid JSON: %s" % (name, exc))
            if os.path.abspath(src) != os.path.abspath(
                    os.path.join(out_root, "i18n", name)):
                writer.write("i18n/%s" % name, blob)
            else:
                writer.files["i18n/%s" % name] = (len(blob), gz_len(blob))
            copied.append(name)
    if "en.json" not in copied:
        i18n_note = ("web/data/i18n/en.json is absent. It is hand-written and "
                     "human-reviewed (CONTRACT 8) and bake.py must never "
                     "generate it.")
        log("WARNING     %s", i18n_note)
    else:
        log("shared      i18n: %s (copied, never generated)", ", ".join(copied))

    # foreign-municipality counts, restricted to cells we actually ship
    foreign_by_cell = {}
    for (cell, nis), count in passer.foreign.items():
        if cell in all_cells:
            foreign_by_cell.setdefault(cell, {})[nis] = count

    # grid shards
    rows_by_cell = {}
    for nis in cities:
        for row in passer.rows[nis]:
            rows_by_cell.setdefault(row[0], []).append(row + (nis,))

    per_city_grid = {nis: [0, 0, 0] for nis in cities}  # raw, gz, shards
    largest = (0, "")
    for cell in sorted(rows_by_cell):
        shard = build_shard(cell, rows_by_cell[cell],
                            stops_by_cell.get(cell, []),
                            foreign_by_cell.get(cell))
        blob = dumps(shard)
        writer.write("grid/%s.json" % cell, blob)
        raw, gz = len(blob), gz_len(blob)
        if raw > largest[0]:
            largest = (raw, cell)
        for nis in shard["m"]:
            per_city_grid[nis][0] += raw
            per_city_grid[nis][1] += gz
            per_city_grid[nis][2] += 1

    # per-municipality files
    munty = munty_doc["municipalities"]
    city_totals = {}
    for nis in cities:
        record = munty.get(nis)
        if record is None:
            raise BakeError("NIS %s is not in municipalities.json" % nis)
        rows = passer.rows[nis]
        cells = sorted(passer.cells[nis])
        sector_blob, tolerance, sector_count = build_sector_geojson(
            nis, sector_features[nis])
        writer.write("%s/sector.geojson" % nis, sector_blob)

        streets_obj = build_streets(nis, passer.streets[nis])
        streets_raw = writer.write_json("%s/streets.json" % nis, streets_obj)

        stops_here = sum(len(stops_by_cell.get(c, ())) for c in cells)
        meta = {
            "nis": nis,
            "name": {"nl": record["nl"], "fr": record["fr"], "de": record["de"]},
            "rgn": record["rgn"],
            "prov": record["prov"],
            "dstr": record["dstr"],
            "nuts3": record.get("nuts3"),
            "lang": language_for(nis, record["rgn"]),
            "counts": {
                "addresses": len(rows),
                "streets": streets_obj["n"],
                "sectors": sector_count,
                "cells": len(cells),
                "stops": stops_here,
            },
            "zips": sorted(passer.zips[nis]),
            "cells": cells,
            "bbox": [min(r[3] for r in rows), min(r[4] for r in rows),
                     max(r[3] for r in rows), max(r[4] for r in rows)],
            "sector_tolerance_m": tolerance,
            "vintage": VINTAGE,
        }
        assert_no_floats(meta, "%s/meta.json" % nis)
        writer.write_json("%s/meta.json" % nis, meta)
        city_totals[nis] = {
            "addresses": len(rows),
            "streets": streets_obj["n"],
            "sectors": sector_count,
            "cells": len(cells),
            "stops": stops_here,
            "tolerance": tolerance,
            "sector_bytes": len(sector_blob),
            "streets_bytes": streets_raw,
        }
        log("emit        %s %-18s %6d addr, %4d streets, %3d sectors @ %2d m, "
            "%3d cells, %4d stops", nis, PILOTS.get(nis, record["nl"]),
            len(rows), streets_obj["n"], sector_count, tolerance, len(cells),
            stops_here)

    # root manifest
    sources_out = []
    for source in SOURCES:
        entry = {k: v for k, v in source.items() if not k.startswith("_")}
        entry["retrieved"] = retrieved[source["id"]]
        sources_out.append(entry)
    sources_out.sort(key=lambda s: s["id"])
    built = max(s["retrieved"] for s in sources_out)
    root_meta = {
        "contract": CONTRACT_VERSION,
        "vintage": VINTAGE,
        "built": built,
        "coord_dp": COORD_DP,
        "grid": {"srs": GRID_SRS, "size_m": GRID_SIZE_M,
                 "cells": len(rows_by_cell)},
        "municipalities": cities,
        "sources": sources_out,
    }
    writer.write_json("meta.json", root_meta)

    # Offline precache manifest. Written LAST, because it lists everything the
    # bake produced, and it never lists itself.
    writer.write_json(
        PRECACHE_NAME,
        precache_doc(writer.files.keys(), passer.cells, cities))
    log("shared      %s (%d files for the service worker to store at install)",
        PRECACHE_NAME, len(writer.files) - 1)

    # --- verification, CONTRACT 13 ----------------------------------------
    problems = verify(writer, out_root, cities, passer, sector_features)

    # --- report ------------------------------------------------------------
    report(writer, cities, city_totals, per_city_grid, largest,
           len(rows_by_cell), passer, args, i18n_note, root_meta,
           fetched_paths, args.max_gz_bytes, problems)

    total_gz = sum(gz for _, gz in writer.files.values())
    if problems:
        raise BakeError("%d verification problem(s); see the report above"
                        % len(problems))
    if total_gz > args.max_gz_bytes:
        raise BakeError("shipped tree is %d B gzipped, over the %d B budget"
                        % (total_gz, args.max_gz_bytes))
    return 0


def verify(writer, out_root, cities, passer, sector_features):
    """The cheap half of CONTRACT 13, run inside the bake so it fails loudly."""
    problems = []

    # gate 2: precision
    for rel in writer.files:
        if rel.endswith(".geojson"):
            with open(os.path.join(out_root, rel), "rb") as fh:
                if _SIXDP.search(fh.read()):
                    problems.append("%s carries more than 5 decimal places" % rel)

    # gate 2, second half: a grid shard must round-trip with zero floats
    for rel in writer.files:
        if not rel.startswith("grid/"):
            continue
        with open(os.path.join(out_root, rel), "rb") as fh:
            blob = fh.read()
        if not blob.endswith(b"\n") or blob.count(b"\n") != 1:
            problems.append("%s is not exactly one LF-terminated line" % rel)
        try:
            assert_no_floats(json.loads(blob.decode("utf-8")), rel)
        except BakeError as exc:
            problems.append(str(exc))

    # gate 3: per-file sector cap
    for rel, (raw, _gz) in writer.files.items():
        if rel.endswith("sector.geojson") and raw > SECTOR_MAX_BYTES:
            problems.append("%s is %d B, over the 150,000 B cap" % (rel, raw))

    # gate 7: referential integrity
    sector_codes = {nis: {f["s"] for f in feats}
                    for nis, feats in sector_features.items()}
    for nis in cities:
        known_streets = set(passer.streets[nis])
        for row in passer.rows[nis]:
            if row[1] not in known_streets:
                problems.append("street %d in NIS %s is not in streets.json"
                                % (row[1], nis))
                break
        for row in passer.rows[nis]:
            if row[5] and row[5] not in sector_codes[nis]:
                problems.append("sector %s in NIS %s is not in sector.geojson"
                                % (row[5], nis))
                break
        for cell in passer.cells[nis]:
            if "grid/%s.json" % cell not in writer.files:
                problems.append("cell %s listed by NIS %s has no shard"
                                % (cell, nis))
                break

    # gate 4: no secrets anywhere in the tree
    needles = (b"key=", b"token", b"apikey", b"api_key", b"Authorization")
    for rel in writer.files:
        with open(os.path.join(out_root, rel), "rb") as fh:
            blob = fh.read()
        for needle in needles:
            if needle in blob:
                problems.append("%s contains %r" % (rel, needle.decode()))

    # gate 6: vintage. Grid shards spell it "v" (CONTRACT 7.2), everything
    # else spells it "vintage".
    long_form = b'"vintage":"%s"' % VINTAGE.encode()
    short_form = b'"v":"%s"' % VINTAGE.encode()
    for rel in writer.files:
        if rel in ("meta.json", "municipalities.json", "nis_history.json"):
            continue
        with open(os.path.join(out_root, rel), "rb") as fh:
            blob = fh.read()
        if long_form not in blob and short_form not in blob:
            problems.append("%s does not carry the pinned vintage" % rel)
    return problems


def report(writer, cities, city_totals, per_city_grid, largest, shard_count,
           passer, args, i18n_note, root_meta, fetched_paths, max_gz, problems):
    files = writer.files
    built = root_meta["built"]

    def size_of(rel):
        return files.get(rel, (0, 0))

    out()
    out("=" * 78)
    out("BeHERE bake report   contract v%d   vintage %s   built %s"
        % (CONTRACT_VERSION, VINTAGE, built))
    out("=" * 78)
    if args.sample:
        out("SAMPLE MODE: addresses came from %s." % args.sample)
        out("             Shapes and idempotency are real; counts are not a release.")
    out()
    out("%-8s %-18s %8s %8s %8s %8s %8s %10s %10s"
        % ("NIS", "city", "addr", "streets", "sectors", "cells", "stops",
           "raw B", "gz B"))
    out("-" * 78)
    total_raw = total_gz = 0
    for nis in cities:
        t = city_totals[nis]
        raw = (size_of("%s/meta.json" % nis)[0]
               + size_of("%s/streets.json" % nis)[0]
               + size_of("%s/sector.geojson" % nis)[0]
               + per_city_grid[nis][0])
        gz = (size_of("%s/meta.json" % nis)[1]
              + size_of("%s/streets.json" % nis)[1]
              + size_of("%s/sector.geojson" % nis)[1]
              + per_city_grid[nis][1])
        total_raw += raw
        total_gz += gz
        out("%-8s %-18s %8d %8d %8d %8d %8d %10d %10d"
            % (nis, PILOTS.get(nis, "?"), t["addresses"], t["streets"],
               t["sectors"], t["cells"], t["stops"], raw, gz))
    out("-" * 78)
    out("%-27s %8s %8s %8s %8s %8s %10d %10d"
        % ("SUM OF CITIES", "", "", "", "", "", total_raw, total_gz))

    shared = ["meta.json", "municipalities.json", "nis_history.json", "i18n/en.json"]
    shared_raw = sum(size_of(r)[0] for r in shared)
    shared_gz = sum(size_of(r)[1] for r in shared)
    out("%-27s %8s %8s %8s %8s %8s %10d %10d"
        % ("shared files", "", "", "", "", "", shared_raw, shared_gz))

    tree_raw = sum(raw for raw, _ in files.values())
    tree_gz = sum(gz for _, gz in files.values())
    out("=" * 78)
    out("%-27s %8s %8s %8s %8s %8s %10d %10d"
        % ("TREE TOTAL (deduplicated)", "", "", "", "", "", tree_raw, tree_gz))
    out("budget: %d B gzipped of %d B allowed  (%.1f%% used, %s)"
        % (tree_gz, max_gz, 100.0 * tree_gz / max_gz,
           "PASS" if tree_gz <= max_gz else "OVER BUDGET"))
    shard_bytes = {rel[5:-5]: raw for rel, (raw, _) in files.items()
                   if rel.startswith("grid/")}
    worst = (0, "")
    for cell in shard_bytes:
        nine = sum(shard_bytes.get(n, 0) for n in neighbours(cell))
        if nine > worst[0]:
            worst = (nine, cell)
    out()
    out("grid: %d shards, largest %d B raw (%s), median %d B raw"
        % (shard_count, largest[0], largest[1],
           _median(list(shard_bytes.values()))))
    out("      worst 9-cell read %d B raw, centred on %s "
        "(CONTRACT 7.5: render the centre cell first)" % (worst[0], worst[1]))
    out("sector simplification (CONTRACT 6.2 ladder, cap %d B):" % SECTOR_MAX_BYTES)
    for nis in cities:
        t = city_totals[nis]
        out("  %s %-18s %2d m  %7d B raw  %6d B gz"
            % (nis, PILOTS.get(nis, "?"), t["tolerance"], t["sector_bytes"],
               size_of("%s/sector.geojson" % nis)[1]))
    out()
    out("addresses read %d, shipped %d, outside every 2025 sector %d"
        % (passer.total, passer.kept, passer.pip_miss))
    foreign_total = sum(v for (cell, _n), v in passer.foreign.items()
                        if cell in set().union(*passer.cells.values()))
    out("foreign addresses inside shipped cells: %d (counted in `fm`, not baked)"
        % foreign_total)
    poi = count_poi(fetched_paths)
    if poi:
        out()
        out("POI sources fetched and counted, NOT emitted "
            "(CONTRACT 7.2 defines no object schema for the shard `p` key):")
        for name, n in poi:
            out("  %-28s %8d records" % (name, n))
    if i18n_note:
        out()
        out("NOT SHIPPED: %s" % i18n_note)
    out()
    out("sources (%d in meta.json; built = max(retrieved) = %s):"
        % (len(root_meta["sources"]), built))
    for s in root_meta["sources"]:
        out("  %-28s %-8s vintage %-12s retrieved %s"
            % (s["id"], "runtime" if s["runtime"] else "baked",
               s["vintage"], s["retrieved"]))
    if problems:
        out()
        out("VERIFICATION PROBLEMS (%d):" % len(problems))
        for p in problems[:40]:
            out("  - %s" % p)
    else:
        out()
        out("verification: precision, sector cap, referential integrity, "
            "no-secrets and vintage gates all pass")
    out("=" * 78)


def _median(values):
    if not values:
        return 0
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) // 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BakeError as exc:
        sys.stderr.write("\nBAKE FAILED: %s\n" % exc)
        sys.exit(2)
    except KeyboardInterrupt:
        sys.stderr.write("\ninterrupted\n")
        sys.exit(130)
