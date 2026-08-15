#!/usr/bin/env python3
"""Vendor Caprasimo and Figtree into web/fonts/, standard library only.

BeHERE ships no CDN request at runtime. The Organic design system's own
stylesheet opens with an @import of fonts.googleapis.com; that line is deleted
in web/app/tokens.css and the four woff2 files it needs are served from
/behere/fonts/ instead. This script is what puts them there.

Both faces are SIL Open Font License 1.1, so vendoring the binaries is clean
provided the licence text ships with them. It does: OFL-Caprasimo.txt and
OFL-Figtree.txt are fetched from each family's own upstream and written beside
the fonts. Shipping OFL fonts without their licence text is a licence breach,
so a failure to fetch either OFL.txt fails the whole run.

WHAT IS FETCHED

  Caprasimo 400          latin, latin-ext        static, the family has one weight
  Figtree wght 300..900  latin, latin-ext        variable, one file per subset

  The variable Figtree is the default because web/app/tokens.css declares
  `font-weight: 300 900` against `figtree-var-*.woff2`. It is also smaller than
  the three static weights the design system asks for (400/600/700): 30.4 kB of
  variable against 52.9 kB of static, for a superset of the range. Pass
  `--figtree static` for the contingency plan, which writes
  figtree-{400,600,700}-{latin,latin-ext}.woff2 instead; tokens.css then needs
  its two Figtree @font-face blocks replaced by six.

  latin-ext is worth its 12.6 kB, but not for the reason usually given. The
  French, Dutch and German diacritics in Belgian place names are all Latin-1:
  Liege's e-grave is U+00E8 and Buellingen's u-diaeresis is U+00FC, both inside
  the `latin` subset. A scan of all 708 files under web/data finds ZERO
  characters above U+00FF outside the punctuation block, so the baked data alone
  would never fetch latin-ext at all.

  It is for the runtime strings, which are not in web/data and are not under our
  control: iRail stop names, GTFS-realtime headsigns, Opendatasoft event titles
  and the Walloon agenda carry names of Polish, Turkish and Romanian origin
  (L-stroke U+0141, s-comma U+0219, o-double-acute U+0151) that Latin-1 does not
  reach. CLAUDE.md forbids rewriting a name to suit a font, so the alternative
  to shipping latin-ext is a visible tofu box in a live event title.

  Because @font-face carries `unicode-range`, a browser fetches latin-ext only
  when a character in that range actually renders. Its cost at runtime is zero
  today. That is also why sw.js should list all four files in SHELL_OPTIONAL and
  not SHELL_REQUIRED: a font that fails to store degrades to the fallback stack,
  which is not an install failure.

INTEGRITY

  Every body is checked before it is allowed near the tree:

    * the woff2 magic bytes, b"wOF2", at offset 0
    * the woff2 header's own `length` field equals the number of bytes received,
      which catches a truncated transfer that magic bytes alone would not
    * numTables > 0
    * a floor on the byte count, so a captive-portal HTML error page or an empty
      200 can never overwrite a good font

  A file that fails any check is never written. If a good file is already on
  disk, a failing download leaves it untouched and the run exits non-zero.

IDEMPOTENCE

  A file whose bytes on disk already hash to the digest in scripts/fonts.lock.json
  is left alone: no request, no write, byte-identical tree. Running this twice
  gives an empty diff, which is the working agreement in CLAUDE.md.

  The lock file records, per file: byte count, sha256, the URL it came from and
  the mirror order tried. `--check` re-verifies the tree against the lock with
  no network at all, which is what CI should run.

USAGE

    python3 scripts/fetch_fonts.py                  # vendor (or confirm) everything
    python3 scripts/fetch_fonts.py --check          # offline verify against the lock
    python3 scripts/fetch_fonts.py --force          # re-download even if hashes match
    python3 scripts/fetch_fonts.py --figtree static # 400/600/700 instead of variable
    python3 scripts/fetch_fonts.py --out web/fonts --lock scripts/fonts.lock.json
"""

import argparse
import hashlib
import json
import os
import struct
import sys
import time
import urllib.error
import urllib.request

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(_HERE)

DEFAULT_OUT = os.path.join(_REPO, "web", "fonts")
DEFAULT_LOCK = os.path.join(_HERE, "fonts.lock.json")

# A descriptive agent, the same courtesy PLAN.md asks for on iRail. jsDelivr and
# raw.githubusercontent both serve a default urllib agent fine, but naming the
# caller is free and makes an abuse report answerable.
UA = ("BeHERE-font-vendor/1 (+https://github.com/; static PWA, "
      "build-time font vendoring, no runtime CDN)")

TIMEOUT = 30
RETRIES = 3
BACKOFF = 1.5

# No real woff2 subset in this set is under 2 kB (Caprasimo latin-ext is the
# smallest at 2,332 B). 1024 is a floor against error pages, not a size check;
# the header length equality below is the actual integrity test.
MIN_WOFF2_BYTES = 1024
MIN_LICENCE_BYTES = 3000

WOFF2_MAGIC = b"wOF2"

# The unicode ranges Google Fonts publishes for these two subsets. Recorded in
# the lock so tokens.css's unicode-range declarations can be diffed against the
# source of truth rather than trusted.
UNICODE_RANGE = {
    "latin": ("U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, "
              "U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, "
              "U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD"),
    "latin-ext": ("U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, "
                  "U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, "
                  "U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, "
                  "U+2113, U+2C60-2C7F, U+A720-A7FF"),
}

# --- what to fetch --------------------------------------------------------
#
# Two mirrors each, tried in order. api.fontsource.org 302s to the same jsDelivr
# objects, so the second is a redundancy against one host being unreachable
# rather than a different build of the font.


def _fontsource(family, leaf):
    """The two equivalent Fontsource URLs for one subset file."""
    return [
        "https://cdn.jsdelivr.net/fontsource/fonts/%s@latest/%s" % (family, leaf),
        "https://api.fontsource.org/v1/fonts/%s/%s" % (family.split(":")[0], leaf),
    ]


CAPRASIMO = [
    {
        "name": "caprasimo-400-latin.woff2",
        "family": "Caprasimo", "subset": "latin", "axis": "static", "weight": "400",
        "urls": _fontsource("caprasimo", "latin-400-normal.woff2"),
    },
    {
        "name": "caprasimo-400-latin-ext.woff2",
        "family": "Caprasimo", "subset": "latin-ext", "axis": "static", "weight": "400",
        "urls": _fontsource("caprasimo", "latin-ext-400-normal.woff2"),
    },
]

FIGTREE_VARIABLE = [
    {
        "name": "figtree-var-latin.woff2",
        "family": "Figtree", "subset": "latin", "axis": "wght", "weight": "300 900",
        "urls": _fontsource("figtree:vf", "latin-wght-normal.woff2"),
    },
    {
        "name": "figtree-var-latin-ext.woff2",
        "family": "Figtree", "subset": "latin-ext", "axis": "wght", "weight": "300 900",
        "urls": _fontsource("figtree:vf", "latin-ext-wght-normal.woff2"),
    },
]

# The contingency: the three weights the Organic stylesheet's @import asked for.
FIGTREE_STATIC = [
    {
        "name": "figtree-%s-%s.woff2" % (w, sub),
        "family": "Figtree", "subset": sub, "axis": "static", "weight": w,
        "urls": _fontsource("figtree", "%s-%s-normal.woff2"
                            % ("latin" if sub == "latin" else "latin-ext", w)),
    }
    for w in ("400", "600", "700")
    for sub in ("latin", "latin-ext")
]

# Each family's own OFL.txt, not a generic copy of the licence. The copyright
# line at the top is part of the licence and differs per family, so a shared
# OFL.txt would misattribute both.
LICENCES = [
    {
        "name": "OFL-Caprasimo.txt",
        "family": "Caprasimo",
        "must_contain": ["SIL OPEN FONT LICENSE Version 1.1",
                         "The Caprasimo Project Authors"],
        "urls": [
            "https://raw.githubusercontent.com/google/fonts/main/ofl/caprasimo/OFL.txt",
            "https://raw.githubusercontent.com/docrepair-fonts/caprasimo-fonts/main/OFL.txt",
        ],
    },
    {
        "name": "OFL-Figtree.txt",
        "family": "Figtree",
        "must_contain": ["SIL OPEN FONT LICENSE Version 1.1",
                         "The Figtree Project Authors"],
        "urls": [
            "https://raw.githubusercontent.com/google/fonts/main/ofl/figtree/OFL.txt",
            "https://raw.githubusercontent.com/erikdkennedy/figtree/master/OFL.txt",
        ],
    },
]


def plan(figtree):
    fonts = list(CAPRASIMO)
    fonts += FIGTREE_VARIABLE if figtree == "variable" else FIGTREE_STATIC
    return fonts


# --- validation -----------------------------------------------------------

class Rejected(Exception):
    """A body that must not be allowed to touch the tree."""


def check_woff2(body, name):
    """Raise Rejected unless `body` really is a complete woff2 file.

    Three independent things have to line up: the magic bytes, the length the
    file claims about itself, and a plausible table count. Magic bytes alone
    would accept the first four bytes of a truncated transfer.
    """
    if len(body) < MIN_WOFF2_BYTES:
        raise Rejected("%s: %d bytes is too short to be a font (floor %d)"
                       % (name, len(body), MIN_WOFF2_BYTES))
    if body[:4] != WOFF2_MAGIC:
        head = body[:16]
        raise Rejected("%s: not woff2, first bytes are %r (expected %r)"
                       % (name, head, WOFF2_MAGIC))
    if len(body) < 48:
        raise Rejected("%s: woff2 header is truncated" % name)
    length = struct.unpack(">I", body[8:12])[0]
    if length != len(body):
        raise Rejected("%s: woff2 header claims %d bytes, received %d "
                       "(truncated transfer)" % (name, length, len(body)))
    num_tables = struct.unpack(">H", body[12:14])[0]
    if num_tables == 0:
        raise Rejected("%s: woff2 declares zero tables" % name)
    total_sfnt = struct.unpack(">I", body[16:20])[0]
    return {"tables": num_tables, "sfnt_bytes": total_sfnt,
            "flavor": body[4:8].decode("latin-1")}


def check_licence(body, spec):
    if len(body) < MIN_LICENCE_BYTES:
        raise Rejected("%s: %d bytes is too short to be the OFL text (floor %d)"
                       % (spec["name"], len(body), MIN_LICENCE_BYTES))
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise Rejected("%s: not UTF-8 text (%s)" % (spec["name"], exc))
    for needle in spec["must_contain"]:
        if needle not in text:
            raise Rejected("%s: licence text does not contain %r; this is not "
                           "the OFL for this family" % (spec["name"], needle))
    return {"lines": text.count("\n") + 1}


# --- transfer -------------------------------------------------------------

def fetch(url):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "*/*",
    })
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        if resp.status != 200:
            raise Rejected("%s: HTTP %s" % (url, resp.status))
        return resp.read(), resp.headers.get("Content-Type", "")


def fetch_first(urls, validate, label):
    """Try each mirror in turn. Returns (body, url, extra) or raises Rejected."""
    problems = []
    for url in urls:
        for attempt in range(1, RETRIES + 1):
            try:
                body, ctype = fetch(url)
            except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
                problems.append("%s attempt %d: %s" % (url, attempt, exc))
                if attempt < RETRIES:
                    time.sleep(BACKOFF * attempt)
                continue
            try:
                extra = validate(body)
            except Rejected as exc:
                # A bad body is not worth retrying against the same mirror.
                problems.append("%s: %s (content-type %s)" % (url, exc, ctype))
                break
            return body, url, extra
    raise Rejected("%s: every mirror failed\n    %s"
                   % (label, "\n    ".join(problems)))


def sha256(body):
    return hashlib.sha256(body).hexdigest()


def read_if_present(path):
    try:
        with open(path, "rb") as fh:
            return fh.read()
    except OSError:
        return None


def write_atomic(path, body):
    """Write through a temp file in the same directory, then rename.

    An interrupted run must never leave half a font where a whole one was.
    """
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".partial"
    with open(tmp, "wb") as fh:
        fh.write(body)
    os.replace(tmp, path)


# --- the run --------------------------------------------------------------

def load_lock(path):
    body = read_if_present(path)
    if body is None:
        return {}
    try:
        doc = json.loads(body.decode("utf-8"))
    except ValueError:
        return {}
    return {f["name"]: f for f in doc.get("files", [])}


def dump_lock(path, figtree, records):
    """Deterministic JSON: sorted keys, fixed separators, trailing newline.

    No timestamp. A lock that changed every run would defeat the point of an
    idempotent script, and the sha256 is the only fact worth pinning.
    """
    doc = {
        "note": ("Vendored fonts under web/fonts/. Regenerate with "
                 "python3 scripts/fetch_fonts.py; verify offline with --check."),
        "figtree": figtree,
        "licence": "OFL-1.1",
        "files": sorted(records, key=lambda r: r["name"]),
    }
    blob = (json.dumps(doc, indent=2, sort_keys=True,
                       separators=(",", ": "), ensure_ascii=False)
            + "\n").encode("utf-8")
    existing = read_if_present(path)
    if existing == blob:
        return False
    write_atomic(path, blob)
    return True


def do_check(out, lock_path):
    """Verify the tree against the lock. No network, no writes."""
    locked = load_lock(lock_path)
    if not locked:
        sys.stderr.write("no lock file at %s; run without --check first\n"
                         % lock_path)
        return 2
    rc = 0
    print("%-32s %9s  %s" % ("file", "bytes", "state"))
    for name in sorted(locked):
        rec = locked[name]
        path = os.path.join(out, name)
        body = read_if_present(path)
        if body is None:
            print("%-32s %9s  MISSING" % (name, "-"))
            rc = 1
            continue
        got = sha256(body)
        if got != rec["sha256"]:
            print("%-32s %9d  SHA MISMATCH (locked %s…, on disk %s…)"
                  % (name, len(body), rec["sha256"][:12], got[:12]))
            rc = 1
            continue
        if name.endswith(".woff2"):
            try:
                check_woff2(body, name)
            except Rejected as exc:
                print("%-32s %9d  NOT WOFF2: %s" % (name, len(body), exc))
                rc = 1
                continue
        print("%-32s %9d  ok" % (name, len(body)))
    return rc


def do_fetch(out, lock_path, figtree, force):
    locked = load_lock(lock_path)
    fonts = plan(figtree)
    records = []
    failures = []

    print("%-32s %9s  %s" % ("file", "bytes", "state"))

    for spec in fonts + LICENCES:
        name = spec["name"]
        path = os.path.join(out, name)
        is_font = name.endswith(".woff2")
        validate = ((lambda b: check_woff2(b, name)) if is_font
                    else (lambda b, s=spec: check_licence(b, s)))

        on_disk = read_if_present(path)
        rec = locked.get(name)

        # Idempotence: bytes already on disk that hash to the locked digest are
        # accepted without a request. Everything else is re-fetched.
        if on_disk is not None and rec and not force and sha256(on_disk) == rec["sha256"]:
            try:
                extra = validate(on_disk)
            except Rejected as exc:
                failures.append("%s: on-disk copy matches the lock but is "
                                "invalid: %s" % (name, exc))
                print("%-32s %9d  INVALID" % (name, len(on_disk)))
                continue
            keep = dict(rec)
            keep.update(_describe(spec, on_disk, rec.get("url", ""), extra))
            records.append(keep)
            print("%-32s %9d  unchanged" % (name, len(on_disk)))
            continue

        try:
            body, url, extra = fetch_first(spec["urls"], validate, name)
        except Rejected as exc:
            failures.append(str(exc))
            if on_disk is not None:
                # Refuse to replace a good file with nothing. The old bytes stay.
                print("%-32s %9d  KEPT (download failed)" % (name, len(on_disk)))
                if rec:
                    records.append(rec)
            else:
                print("%-32s %9s  FAILED" % (name, "-"))
            continue

        if on_disk == body:
            print("%-32s %9d  unchanged" % (name, len(body)))
        else:
            write_atomic(path, body)
            print("%-32s %9d  %s" % (name, len(body),
                                     "written" if on_disk is None else "replaced"))
        records.append(_describe(spec, body, url, extra))

    changed = dump_lock(lock_path, figtree, records)
    total = sum(r["bytes"] for r in records if r["name"].endswith(".woff2"))
    print("\n%d woff2, %d B on the wire, in %s"
          % (sum(1 for r in records if r["name"].endswith(".woff2")), total, out))
    print("lock %s %s" % (os.path.relpath(lock_path, _REPO),
                          "rewritten" if changed else "unchanged"))

    if failures:
        sys.stderr.write("\n%d failure(s):\n" % len(failures))
        for f in failures:
            sys.stderr.write("  %s\n" % f)
        return 1
    return 0


def _describe(spec, body, url, extra):
    rec = {
        "name": spec["name"],
        "bytes": len(body),
        "sha256": sha256(body),
        "url": url,
        "mirrors": list(spec["urls"]),
        "family": spec["family"],
    }
    if spec["name"].endswith(".woff2"):
        rec["subset"] = spec["subset"]
        rec["axis"] = spec["axis"]
        rec["weight"] = spec["weight"]
        rec["unicode_range"] = UNICODE_RANGE[spec["subset"]]
        rec["woff2"] = {"tables": extra["tables"],
                        "sfnt_bytes": extra["sfnt_bytes"]}
    else:
        rec["kind"] = "licence"
    return rec


def main(argv=None):
    ap = argparse.ArgumentParser(
        description=__doc__.splitlines()[0],
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=DEFAULT_OUT,
                    help="directory to vendor into (default web/fonts)")
    ap.add_argument("--lock", default=DEFAULT_LOCK,
                    help="sha256 manifest (default scripts/fonts.lock.json)")
    ap.add_argument("--figtree", choices=("variable", "static"), default="variable",
                    help="variable wght 300..900 (default, what tokens.css "
                         "declares) or static 400/600/700")
    ap.add_argument("--force", action="store_true",
                    help="re-download even when the on-disk hash matches the lock")
    ap.add_argument("--check", action="store_true",
                    help="verify the tree against the lock offline; no writes")
    a = ap.parse_args(argv)

    out = os.path.abspath(a.out)
    lock_path = os.path.abspath(a.lock)

    if a.check:
        return do_check(out, lock_path)
    return do_fetch(out, lock_path, a.figtree, a.force)


if __name__ == "__main__":
    sys.exit(main())
