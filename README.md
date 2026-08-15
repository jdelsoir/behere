# BeHERE

**Where you are standing in Belgium.** Your address, your statistical sector, your
municipality, what is around you, how to leave, and what is open now. It works
with the network switched off, because the parts that answer "where am I" are
already on the device.

A static progressive web app on GitHub Pages under the base path `/behere/`.
No backend, no proxy, no API key, no bundler, no CDN, no dependency of any kind.
The Python that builds the data is stdlib only; the JavaScript that runs it is
plain ES modules the browser loads directly.

---

## The five bands

One screen, five stacked bands, no tabs and no routing.

| Band | Question | Answered from |
|---|---|---|
| **Here** | Where am I? | baked shards only, works offline |
| **Around** | What is around me? | baked POI plus five live regional and city sources |
| **Go** | How do I get there? | baked stops offline, live departures when there is a network |
| **Now** | What can I do? | markets, waste collection and events from city portals |
| **Zoom out** | How does this fit in? | Statbel HVD statistics for your arrondissement and for Belgium, keyed on `nuts3` and `dstr`, never on the municipality NIS |

A band that cannot answer never renders an empty panel. It collapses with copy
that names exactly what is missing, and it distinguishes *published nothing
here* from *out of scope for this region by design* from *could not be reached*.
Those are three different sentences, and only the last one is a fault.

---

## The pinned 2025 vintage

Every baked byte in this release comes from one frozen data vintage, and every
shard records it. Nothing is mixed.

| What | File | Vintage |
|---|---|---|
| Addresses joined to statistical sectors | `TF_RGN_ADDRESSES_STAT_SECTORS_20250401.txt` | **2025-04-01** |
| Statistical sector geometry | `sh_statbel_statistical_sectors_31370_20250101.geojson` | **2025-01-01** |
| Municipality code list | `TU_COM_REFNIS-20250101` | **2025-01-01** |

The `20260101` address-to-sector file **does not exist**. That URL is a 404.
Do not "update" the pin to it.

### Source mirror

`statbel.fgov.be` has been observed blackholing a GitHub runner's IPv4 SYN: no
RST, no ICMP, and because a job's egress IP is fixed, retrying can only outlast
the block, never route around it. The pinned sector geometry is therefore
mirrored as a release asset on this repo:

    https://github.com/jdelsoir/behere/releases/download/data-2025/

`bake.py` tries the mirror **first** and enforces its sha256 strictly against
the `MIRRORED` pin; a mismatch means a tampered or badly uploaded asset, so the
bake discards it and falls through to upstream rather than baking unknown bytes.
Upstream remains authoritative for provenance: `meta.json` always credits
Statbel, never the mirror, because a mirror is a transport detail and not a
source. If upstream ever republishes the file, the bake logs a loud warning and
proceeds on the upstream bytes; refresh the release asset and the pin when that
happens.

To re-verify the mirror by hand:

```bash
curl -sL -o /tmp/m.zip https://github.com/jdelsoir/behere/releases/download/data-2025/sh_statbel_statistical_sectors_31370_20250101.geojson.zip
shasum -a 256 /tmp/m.zip   # 93e87cf818ed649b9b478c3613104c9945dc6a2c449da7efb0d69224b2f08606
```

Belgium went from 581 to 565 municipalities on 1 January 2025. Any join that
crosses that boundary must pass through `web/data/nis_history.json`, which maps
retired 2024 NIS codes to their 2025 successors. `municipalities.json` carries
the current 565 only.

**A postcode is not a municipality.** The City of Brussels, NIS 21004, spans ten
postcodes (1000, 1020, 1031, 1040, 1041, 1050, 1051, 1071, 1120, 1130). Position
resolves to NIS through the address record or the sector polygon, never through
a postcode, and the Here band says so on screen when it shows them.

**Street and place names are never machine-translated.** They resolve to the
local official name and the panel carries one endonym note. The only English
that exists anywhere in this app is the hand-curated override in
`web/data/i18n/en.json`, which supplies seven genuine exonyms (Antwerp, City of
Brussels, Bruges, Ypres, Ostend, Ghent, Liege) and marks the other 558
municipalities `"="`, meaning *reviewed, English keeps the local name*.

---

## Layout

```
web/                     everything that is deployed, and nothing else
  index.html             the shell: five band sections, one screen
  sw.js                  service worker. NEVER RENAME THIS FILE.
  manifest.webmanifest   id / start_url / scope are all exactly /behere/
  offline.html           served from cache with no network at all
  app/
    main.js              the shell: one geolocation watcher, the position -> NIS
                         spine, the 9-cell read, band mounting, the source lines
    geo.js               fetch + cache, distance, shard decode, the 9-cell read,
                         point-in-polygon, the debounced position watcher
    grid.js              EPSG:3035 LAEA and the GRD_NEWID cell. Exact twin of
                         scripts/grid.py.
    i18n.js              the four-step label resolver and the language policy
    stats.js             the cross-vintage join guard every Statbel figure
                         passes through before it reaches a pixel
    here.js around.js go.js now.js zoom.js    the five bands
    gtfsrt.js            vendored GTFS-realtime protobuf decoder (no dependency)
    app.css              all of the CSS
  data/                  baked output plus three hand-curated inputs
    precache.json        the manifest sw.js stores at install, emitted by the
                         bake so it can never drift from what was baked

scripts/
  bake.py                the whole bake. Stdlib only, idempotent.
  build_municipalities.py  rebuilds municipalities.json and nis_history.json
  gen_precache.py        rewrites (or --check) web/data/precache.json
  check_i18n.py          fails the build on a chrome key missing from any language
  grid.py geo31370.py    the projection maths, with a validator
  gen_icons.py           writes the PNG icons with zlib and struct
  stamp_sw.py            rotates the service worker's shell-cache version
  test_stats.mjs         acceptance test 3, against the 55 shipped history records
  test_zoom.mjs          the Zoom out band's guard, with an optional --live pass
  test_sw_offline.mjs    acceptance test 1: installs sw.js, cuts the network,
                         resolves every pilot city from the cache alone
  test_i18n_marker.mjs   acceptance test 4, both clauses

docs/CONTRACT.md         the wire format of every baked file. Authoritative.
PLAN.md                  the build brief: verified endpoints, budget, phases.
CLAUDE.md                the rules that must never be violated in this repo.
```

---

## Baking the data

```bash
python3 scripts/bake.py
```

That is the whole command. It writes `web/data/`, needs no arguments, and
installs nothing. On a warm cache it takes about twelve seconds and peaks around
230 MB of RSS for 4,490,779 address rows and 20,781 sector polygons, because
nothing is ever held whole in memory.

Useful flags:

```bash
python3 scripts/bake.py --cache-dir .cache/bake     # where the 546 MB of sources live
python3 scripts/bake.py --offline                   # fail loudly rather than download
python3 scripts/bake.py --cities 44021,21004        # a subset, for a fast loop
python3 scripts/bake.py --sample sample.txt         # a sampled address file
python3 scripts/bake.py --out /tmp/bake-check       # somewhere other than web/data
python3 scripts/bake.py --with-optional             # also fetch BeSt Address and
                                                    # the two tourism bulk files
```

**The bake is idempotent.** Identical input produces byte-identical output: keys
sorted, floats at fixed precision, LF newlines, no timestamp anywhere in a shard
body. That is what makes a scheduled monthly rebuild produce a clean diff instead
of 708 changed files. Prove it any time:

```bash
python3 scripts/bake.py --offline --out /tmp/a
python3 scripts/bake.py --offline --out /tmp/b
diff -r /tmp/a /tmp/b && echo identical
```

The bake refuses to write a partial result. A missing source, a city with zero
addresses, or a tree over the gzipped byte budget exits non-zero and leaves the
previous output untouched.

### What is in Git and what is not

| Path | In Git? | Why |
|---|---|---|
| `web/data/municipalities.json` | **yes** | a bake *input*; rebuilding it needs the 212 MB sector file |
| `web/data/nis_history.json` | **yes** | same, and it is the only 2024→2025 merger map |
| `web/data/i18n/{en,nl,fr}.json` | **yes** | hand-curated. Never generated by anything. |
| `web/data/meta.json` | no | bake output |
| `web/data/precache.json` | no | bake output: the list `sw.js` stores at install |
| `web/data/grid/` (674 shards, 6.5 MB) | no | bake output |
| `web/data/<nis>/` (7 cities, 0.8 MB) | no | bake output |

CI regenerates everything in the "no" rows on every push and monthly
(`.github/workflows/pages.yml`). **A fresh clone therefore has no shards**: run
the bake once before serving, or every band will correctly report that nothing
is stored on this device.

---

## Running it locally

The app is served under `/behere/`, so serve a parent directory that contains a
`behere` entry. Serving `web/` directly at the root will half-work and then mislead
you about the manifest scope.

```bash
mkdir -p /tmp/serve && ln -s "$PWD/web" /tmp/serve/behere
python3 -m http.server 8000 --directory /tmp/serve
# http://127.0.0.1:8000/behere/
```

Geolocation is refused by browsers on plain `http://` except on `localhost`, so
use `127.0.0.1` or `localhost`, not your LAN address.

### Testing the pilot cities from a desk in another country

The shell exposes a manual position injector once locating has started. Press
**Find where I am** (or grant permission once), then in the console:

```js
behere.at(50.8465, 4.3524);   // Grand-Place, City of Brussels
behere.at(51.0536, 3.7255);   // Sint-Baafsplein, Ghent
behere.at(51.2304, 2.9195);   // Ostend
behere.at(50.6450, 5.5736);   // Place Saint-Lambert, Liege
behere.at(49.6839, 5.8163);   // Arlon
behere.at(50.6690, 4.6150);   // Louvain-la-Neuve
behere.at(50.4890, 5.0960);   // Andenne
behere.at(50.8080, 4.9380);   // a field outside the release: everything collapses honestly

behere.lang("nl");            // nl | fr | en | auto
```

`behere.at` deliberately bypasses the movement debounce, because a typed
coordinate is not a noisy sensor.

### Offline, from a cold cache

`sw.js` precaches the whole release at install: 674 grid shards, the nine
cities' files and the shared documents, 6.2 MB raw and about 1.48 MB gzipped.
That is what makes airplane mode work in a city you have never opened before,
which a cache-first fetch rule alone cannot do. The list comes from
`web/data/precache.json`, which the bake emits, and the footer prints how much
of it is actually stored rather than assuming.

Prove it without a browser:

```bash
node scripts/test_sw_offline.mjs   # installs sw.js, cuts the network,
                                   # resolves every pilot city from cache
```

### Checks that gate a deploy

```bash
python3 scripts/gen_precache.py --check   # the manifest matches the baked tree
python3 scripts/check_i18n.py             # no chrome key missing from any language
node scripts/test_i18n_marker.mjs         # nothing blank, fallbacks are marked
node scripts/test_stats.mjs               # the pre-2025 vintage join guard
node scripts/test_zoom.mjs                # add --live to call Statbel for real
node scripts/test_sw_offline.mjs          # cold cache, airplane mode
```

Node is used only as a test runner, and only for scripts that are plain files
with no `package.json` and nothing to install, exactly like `scripts/*.py`.

### Before deploying

```bash
python3 scripts/stamp_sw.py web      # rotate the shell cache version
python3 scripts/stamp_sw.py --check web
```

`web/sw.js` keeps the literal `__CACHE_VERSION__` placeholder in Git on purpose,
so the source tree stays byte-stable between releases. Stamping is a deploy
step. Without it the shell cache name never changes and every deploy after the
first serves the previous HTML out of cache. Given that renaming `sw.js`
is forbidden, that is a problem you would have to fix by overwriting that exact URL.

---

## Sources and licences

Fourteen sources, all keyless and public. Every one of them is listed with its
vintage, its retrieval date and its licence in `web/data/meta.json`, and the app
prints the relevant ones under each band. **Baked** means it was read at build
time and its bytes are in `web/data/`. **Runtime** means the browser calls it
directly, which is only possible because it is CORS-permissive and needs no
credential.

### Baked at build time

| Source | Publisher | Vintage | Licence |
|---|---|---|---|
| Addresses and statistical sectors | Statbel (Statistics Belgium) | 2025-04-01 | Statbel open data |
| Statistical sectors (geometry) | Statbel | 2025-01-01 | Statbel open data |
| REFNIS municipality code list | Statbel | 2025-01-01 | Statbel open data |
| GTFS static, four operators | FPS Mobility and Transport (NAP) | 2026-08-15 | keyless open access via the Belgian NAP |
| BeSt Address *(optional, off by default)* | BOSA and the three regional address authorities | 2025-01-01 | open data, free reuse with attribution |
| Toerisme Vlaanderen bulk CSV *(optional)* | Toerisme Vlaanderen | live | Open data Vlaanderen |
| Offres touristiques de Wallonie bulk CSV *(optional)* | Service public de Wallonie | live | Open data Wallonie |

### Called live from the browser

| Source | Publisher | Licence |
|---|---|---|
| iRail API v1 (train liveboards) | iRail / Open Knowledge Belgium | open data, attribution requested |
| GTFS realtime, four operators | FPS Mobility and Transport (NAP) | keyless open access via the Belgian NAP |
| Statbel high-value datasets API | Statbel | Statbel open data |
| Walloon tourism offer (ArcGIS REST) | Service public de Wallonie | Open data Wallonie |
| Flemish heritage boundaries | Agentschap Onroerend Erfgoed | open data, attribution requested |
| Opendatasoft Explore v2.1 (three portals) | Stad Gent, ODWB, City of Brussels | per portal, open data |
| Brussels regional catalogue (GeoNetwork) | Brussels-Capital Region | unverified, discovery only |

Those nine runtime hosts, and only those nine, are listed in the
`Content-Security-Policy` `connect-src` in `index.html`. Anything not on that
list cannot be called, by construction.

**BeHERE itself sends nothing anywhere.** There is no analytics, no telemetry and
no account. Your position never leaves the device: it is used to pick a 1 km grid
cell out of files that are already stored locally. `geo.js` throws rather than
issue a request carrying an `api_key`, `token`, `Authorization` header or any
other credential shape, because the repo is public and no BeHERE source has one.

Licence of the code in this repository: see `LICENSE` if present; the data
remains under the licences of its publishers, listed above and in `meta.json`.

---

## Things that will waste an hour if you forget them

- The NAP `/static` endpoints return **404 to `HEAD`** and **200 to `GET`**, and
  they ignore `Range:` (a range request pulls the whole 86 MB). Never
  health-check them with `HEAD`.
- `doc.statbel.fgov.be` serves its Turtle catalogue as `application/octet-stream`.
  Tell the parser the format.
- The Flemish GRB WFS caps `numberMatched` at exactly 10000. That is a server
  limit, not a count.
- `opendata.brussels.be` is the **City** of Brussels. The **Region** is
  `catalog.datastore.brussels`, whose `/api/search` path returns 403, so use
  `/geonetwork/srv/eng/q?_content_type=json`, and pass `fast=index` or every
  field comes back null.
- Onroerend Erfgoed returns **HTTP 400** for a point outside Flanders, not an
  empty list, and its output geometry is EPSG:31370 whatever `crs` you ask for.
- The Walloon tourism layers publish `LON` and `LAT` columns that are whole
  degrees (`5`, `51`) for every record. Use the geometry.
- Rate limits: iRail 3 requests per second, Opendatasoft 20,000 per day on ODWB.
- `User-Agent` is a forbidden header name in the Fetch spec. A browser cannot
  send iRail the descriptive UA its documentation asks for. `go.js` passes an
  identifying `&client=` parameter instead and says so on screen rather than
  claiming compliance.
