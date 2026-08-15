# BeHERE

**Where you are standing in Belgium.** Your address, your statistical sector, your
municipality, what is around you, how to leave, and what is open now. It works
with the network switched off, because the parts that answer "where am I" are
already on the device.

A static progressive web app on GitHub Pages under the base path `/behere/`.
No backend, no proxy, no API key, no bundler, no framework, no build step and no
dependency of any kind. The Python that builds the data is stdlib only; the
JavaScript that runs it is plain ES modules the browser loads directly, and the
fonts and icons are vendored into the repo rather than pulled from a CDN.

**One exception, and it is deliberate:** the OpenStreetMap raster basemap is
fetched live from `tile.openstreetmap.org`. It is the only byte the app does not
either ship or bake, it is attributed on screen as ODbL requires, it is never
precached, and everything still works without it. The full accounting is under
*What leaves the device*.

---

## The screen: a map, and five bands under it

**Revised 15 August 2026.** The app used to be five bands stacked down one
scrolling column. It is now map-first: a full-bleed map *is* the page, and the
five bands live in a dock of pills along the bottom, one of which may be
expanded into a panel over the map.

The pills are a disclosure, not a tab strip, and the difference matters: *no
panel open at all* is a real and common state, and it is the one a tab strip has
no name for. The map is the answer drawn, never a second source of truth. Every
marker, polygon and outline on it has a text equivalent in a band, `here.js`
resolves the statistical sector and the map is *told*, and where the two ever
disagree the text is the one that has to be right.

There is no routing and no framework. Everything is plain ES modules the browser
loads directly.

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

## The look

The interface follows **Organic**: warm, rounded and a little playful, rather
than the grey chrome a civic app usually gets. Cream and sand ground
(`--color-bg` `#f5ead8`, `--color-surface` `#ebddc5`), a terracotta accent
(`#c67139`) with sage as the second accent (`#7a8a5e`), **Caprasimo** display
headings over **Figtree** body text, 16 px radii that grow into 999 px pills,
soft circular shapes, generous air, left-aligned and asymmetric. Icons are
Lucide geometry at stroke-width 2.75.

Three rules hold it together, and they are enforced rather than hoped for:

- **Every colour, font, space, radius and shadow comes from a token.**
  `web/app/tokens.css` is the only file in the app that contains a colour
  literal: 80 hex values, 40 of them distinct, plus 13 `rgba()` for the dividers,
  scrims and shadows that genuinely need an alpha. `app.css` and `map.css`
  contain **zero** colour literals between them (`grep -E '#[0-9a-f]{3,8}|rgba?\('`
  finds only prose in comments) and reach the palette through role tokens only.
- **Dark mode is warm, never grey.** The dark theme is derived from the system's
  own ramps into a deep brown ground, because desaturating the palette into
  greys would throw away the one thing the palette is for. It follows
  `prefers-color-scheme`; there is no in-app toggle yet.
- **Nothing is fetched from a CDN.** The Organic stylesheet ships with a Google
  Fonts `@import` and the prototype loaded React from unpkg. Neither survived:
  see *Vendored assets* below.

`docs/DESIGN_TOKENS.md` documents every token and how the dark ramp was derived;
`docs/UI_SPEC.md` documents the shell, the dock, the map layers, the focus order
and the empty states.

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
  index.html             the shell: the map, the two chrome clusters, the dock
  sw.js                  service worker. NEVER RENAME THIS FILE.
  manifest.webmanifest   id / start_url / scope are all exactly /behere/
  offline.html           served from cache with no network at all
  app/
    main.js              the shell: one geolocation watcher, the position -> NIS
                         spine, the 9-cell read, band mounting, the dock
                         (openBand / wireDock / watchPillState), the source lines
    map.js               the map: raster tiles, vector layers, markers, gestures,
                         keyboard panning. Told where it is, never re-derives it
    mercator.js          Web Mercator, tile arithmetic and the viewport maths
    geo.js               fetch + cache, distance, shard decode, the 9-cell read,
                         point-in-polygon, the debounced position watcher
    grid.js              EPSG:3035 LAEA and the GRD_NEWID cell. Exact twin of
                         scripts/grid.py.
    i18n.js              the four-step label resolver and the language policy
    stats.js             the cross-vintage join guard every Statbel figure
                         passes through before it reaches a pixel
    icons.js             six Lucide glyphs as inline path data, with both
                         upstream notices reproduced in the header
    here.js around.js go.js now.js zoom.js    the five bands
    gtfsrt.js            vendored GTFS-realtime protobuf decoder (no dependency)
    tokens.css           the design system: the ONLY file with a colour literal
    app.css              the shell, the dock, the bands
    map.css              the map layers and their states. Sole owner of .map*
  fonts/                 self-hosted Caprasimo and Figtree woff2 + their OFL text
  data/                  baked output plus three hand-curated inputs
    precache.json        the manifest sw.js stores at install, emitted by the
                         bake so it can never drift from what was baked

scripts/
  bake.py                the whole bake. Stdlib only, idempotent.
  build_municipalities.py  rebuilds municipalities.json and nis_history.json
  gen_precache.py        rewrites (or --check) web/data/precache.json, and
                         carries the tile gate that keeps OSM out of it
  check_i18n.py          fails the build on a chrome key missing from any language
  grid.py geo31370.py    the projection maths, with a validator
  gen_icons.py           writes the PNG icons with zlib and struct
  fetch_fonts.py         vendors the two OFL faces, sha256-pinned, --check
  fonts.lock.json        the pins fetch_fonts.py --check verifies with no network
  stamp_sw.py            rotates the service worker's shell-cache version
  ghpages_preflight.py   the shippability pre-flight. Must say GO before a deploy
  domstub.mjs            the DOM the browserless tests share
  test_stats.mjs         acceptance test 3, against the 55 shipped history records
  test_zoom.mjs          the Zoom out band's guard, with an optional --live pass
  test_sw_offline.mjs    acceptance test 1: installs sw.js, cuts the network,
                         resolves every pilot city from the cache alone
  test_i18n_marker.mjs   acceptance test 4, both clauses
  test_map.mjs           the projection, the layers, the gestures, the markers
  test_tiles.mjs         the basemap is runtime-only, bounded, LRU, unprecacheable
  test_integration.mjs   boots the real index.html + main.js and drives a fix
                         through shell -> bands -> map, as one app

docs/CONTRACT.md         the wire format of every baked file. Authoritative.
docs/UI_SPEC.md          the shell, the dock, the map, focus order, empty states.
docs/DESIGN_TOKENS.md    every token, and how the warm dark ramp was derived.
PLAN.md                  the build brief: verified endpoints, budget, phases.
CLAUDE.md                the rules that must never be violated in this repo.
design/*.zip             the design prototype this was built from, kept as the
                         export of record. NOT deployed and NOT on the module
                         graph: it loads React from unpkg and @imports Google
                         Fonts, and neither survived into web/. The extracted
                         copy is gitignored so that `grep -rn react` over this
                         repo stays a real regression check.
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
| `web/data/<nis>/` (9 cities, 0.8 MB) | no | bake output |
| `web/fonts/*.woff2` and their `OFL-*.txt` | **yes** | vendored, not generated at deploy. `fetch_fonts.py --check` verifies them against `scripts/fonts.lock.json` with no network |

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
cities' files and the shared documents, 707 files, 6.46 MB raw and 1,553,038 B
gzipped. That is what makes airplane mode work in a city you have never opened
before, which a cache-first fetch rule alone cannot do. The list comes from
`web/data/precache.json`, which the bake emits, and the app sheet behind the
menu button prints how much of it is actually stored rather than assuming.

The app shell is precached alongside it, and that now includes the four `.woff2`
files: a shell that cached `tokens.css` but not its faces would install happily
and then render offline in `system-ui`, which is not the product.

**The basemap is not in either list and never will be.** OSM tiles are cached
only after the user has actually looked at them, in their own cache, capped at
300 entries. Cut the network and the tiles are simply absent while every band
still answers. Prove that too:

```bash
node scripts/test_tiles.mjs        # runtime-only, bounded, LRU, unprecacheable
```

Prove it without a browser:

```bash
node scripts/test_sw_offline.mjs   # installs sw.js, cuts the network,
                                   # resolves every pilot city from cache
```

### Checks that gate a deploy

```bash
python3 scripts/gen_precache.py --check   # the manifest matches the baked tree,
                                          # AND the tile gate: no OSM host in it
python3 scripts/check_i18n.py             # no chrome key missing from any language
python3 scripts/fetch_fonts.py --check    # the four woff2 match their sha256 pins
python3 scripts/ghpages_preflight.py ./web --repo-name behere   # must say GO
node scripts/test_i18n_marker.mjs         # nothing blank, fallbacks are marked
node scripts/test_stats.mjs               # the pre-2025 vintage join guard
node scripts/test_zoom.mjs                # add --live to call Statbel for real
node scripts/test_sw_offline.mjs          # cold cache, airplane mode
node scripts/test_map.mjs                 # projection, layers, gestures, markers
node scripts/test_tiles.mjs               # the basemap stays runtime-only
node scripts/test_integration.mjs         # the whole app boots as one thing
```

Node is used only as a test runner, and only for scripts that are plain files
with no `package.json` and nothing to install, exactly like `scripts/*.py`.

`test_integration.mjs` exists because the six unit suites can all be green while
the app is broken: they each test one file, and nobody was testing the six
together. On its first run it found a shell that shipped `chrome-left` against a
stylesheet that styled `chrome--tl`, a `#map-scale` whose class no rule matched,
and a `main.js` that dynamically imported a module that does not exist. None of
those were visible to any unit test. It boots the real `index.html` and the real
`main.js` over `scripts/domstub.mjs` and drives a Brussels fix through
shell → bands → map.

**What no test here proves:** there is no real browser in this loop. The DOM is
a stub, so it can show that the wires connect and nothing throws, and it cannot
show that the map *looks* right. Layout, font rendering, real tile fetching,
touch gestures and the dark theme are verified by eye, not by machine.

### Before deploying

Nothing, if you are pushing to `main`: `.github/workflows/deploy.yml` bakes,
runs every gate above, stamps the worker and deploys. **Do not stamp by hand
before pushing** — the placeholder is what CI expects to find.

`web/sw.js` keeps the literal `__CACHE_VERSION__` placeholder in Git on purpose,
so the source tree stays byte-stable between releases. Stamping is a deploy
step, and CI does it with:

```bash
python3 scripts/stamp_cache_version.py ./web    # what deploy.yml runs
```

Without it the shell cache name never changes, the activate handler never sees a
stale name to delete, and every deploy after the first serves the previous HTML
out of cache. Given that renaming `sw.js` is forbidden, that is a problem you
would have to fix by overwriting that exact URL.

> **Two scripts do this job and only one of them is wired up.**
> `scripts/stamp_sw.py` does the same replacement, hashes the *path* as well as
> the bytes (so moving a file rotates the cache, which is the better behaviour)
> and adds a `--check` mode. `deploy.yml` calls `stamp_cache_version.py`
> instead, so the two compute different hashes and `stamp_sw.py --check` reports
> a stale stamp against any tree the other one stamped. Nothing is broken —
> any 12-hex value busts the cache correctly — but do not read a `stamp_sw.py
> --check` failure as a deploy problem. On a clean checkout it fails by design,
> because the placeholder is still there.

---

## Sources and licences

Fourteen data sources, all keyless and public. Every one of them is listed with
its vintage, its retrieval date and its licence in `web/data/meta.json`, and the
app prints the relevant ones under each band. **Baked** means it was read at
build time and its bytes are in `web/data/`. **Runtime** means the browser calls
it directly, which is only possible because it is CORS-permissive and needs no
credential.

There is a fifteenth source, the **OpenStreetMap raster basemap**, and it is
deliberately absent from `meta.json`: `bake.py` never reads it, so putting it in
a file the bake emits would be a claim about a build step that does not happen.
It is credited where it is actually used, on the map itself, and documented
under *Vendored assets* below.

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
list cannot be called, by construction. There is a tenth host,
`tile.openstreetmap.org`, and it is deliberately **not** in `connect-src`: the
basemap is `<img>` elements, not `fetch()`, so it lives in `img-src` and in no
other directive. `img-src` is `'self' https://tile.openstreetmap.org` and
nothing else.

### What leaves the device, and what does not

**There is no analytics, no telemetry, no account and no server of ours.** Every
band answers from files already on the device or from a public open-data host,
and `geo.js` throws rather than issue a request carrying an `api_key`, `token`,
`Authorization` header or any other credential shape, because the repo is public
and no BeHERE source has one.

**Your exact position never leaves the device**, and that is a stronger claim
than it sounds: the GPS fix is used locally to pick a 1 km grid cell out of
files already stored, and the coordinate itself is never sent anywhere.

**One thing does leave, and it was not true of this app before 15 August 2026.**
The basemap makes the browser request `tile.openstreetmap.org/{z}/{x}/{y}.png`,
and a tile coordinate at z15 is a position to roughly 1 km, paired with an IP
address, arriving at a third party. That request is made by the browser directly
from an `<img>`, so nothing in this app can intercept, delay or anonymise it.
This was a deliberate choice, taken with the cost on the table, and it is
recorded as a risk in PLAN section 11 rather than buried. The request carries no
query string, no cookie and no identifier of any kind.

**The basemap turns itself off** when the browser reports `Save-Data` or
`prefers-reduced-data: reduce`, and after three consecutive tile errors; the app
then draws the baked vector layers alone and still answers every question. But
be straight about the gap: **there is no user-facing switch for it yet.**
`map.js` exposes `setTilesEnabled()` on its handle and nothing calls it, so a
user who simply does not want to talk to OSM has no control in the interface,
only a browser setting. The three chips on the map toggle the *vector* layers
(cell, sector, stops), not the raster. That is the honest state of it, and it is
the first thing to fix.

### Vendored assets: fonts, icons and the basemap

Nothing here is fetched from a CDN at runtime. The app makes no request to
`fonts.googleapis.com`, `fonts.gstatic.com`, `unpkg.com` or `jsdelivr.net`; the
Organic design system's own stylesheet opens with a Google Fonts `@import` and
that line is deliberately absent from `web/app/tokens.css`. Two consequences:
the app works in airplane mode, and the `Content-Security-Policy`
`default-src 'self'` needs no `font-src` or `style-src` exception.

| Asset | Author | Licence | Where it lives |
|---|---|---|---|
| **Caprasimo** (display face, headings) | Copyright 2023 The Caprasimo Project Authors (<https://github.com/docrepair-fonts/caprasimo-fonts>) | SIL Open Font License 1.1 | `web/fonts/caprasimo-400-latin*.woff2`, licence in `web/fonts/OFL-Caprasimo.txt` |
| **Figtree** (body face, variable `wght` 300 to 900) | Copyright 2022 The Figtree Project Authors (<https://github.com/erikdkennedy/figtree>) | SIL Open Font License 1.1 | `web/fonts/figtree-var-latin*.woff2`, licence in `web/fonts/OFL-Figtree.txt` |
| **Lucide** icon geometry (6 glyphs) | Lucide Icons and Contributors; `chevron-right` and `x` derive from Feather by Cole Bemis | ISC, plus MIT for the two Feather-derived glyphs | path data inlined in `web/app/icons.js`, both notices reproduced verbatim in its header |
| **OpenStreetMap** raster tiles | OpenStreetMap contributors | ODbL 1.0 | not vendored: fetched at runtime, runtime-cached only, never precached |

Both faces are OFL-1.1, which permits redistribution provided the licence text
travels with the fonts. It does: `OFL-Caprasimo.txt` and `OFL-Figtree.txt` ship
next to the `.woff2` files, each one that family's own upstream `OFL.txt` with
its own copyright line, not a shared copy. Neither font is renamed and neither
is sold on its own, so both reserved-name and bundling conditions are met.

`python3 scripts/fetch_fonts.py` is what puts the fonts there. It is standard
library only, idempotent, checks the woff2 magic bytes and the woff2 header's
own length field before writing, and refuses to replace a good font with a
short or non-woff2 body. Every file is pinned by sha256 in
`scripts/fonts.lock.json`; `python3 scripts/fetch_fonts.py --check` re-verifies
the tree against that lock with no network.

`latin-ext` ships too, though not for the reason usually given: the French,
Dutch and German diacritics in Belgian place names are all Latin-1, so `Liège`
and `Büllingen` are covered by the `latin` subset, and a scan of all 708 files
under `web/data` finds no character above U+00FF outside the punctuation block.
`latin-ext` is there for the runtime strings that are not baked and not under
our control: stop names, realtime headsigns and event titles of Polish, Turkish
or Romanian origin reach past Latin-1, and `CLAUDE.md` forbids rewriting a name
to suit a font. Because each `@font-face` carries a `unicode-range`, the browser
only fetches `latin-ext` when a character in that range actually renders, so it
costs nothing until it is needed.

**OpenStreetMap tiles are the one runtime asset**, and the terms that come with
them are not optional either: the `© OpenStreetMap contributors` attribution is
visible on any frame where a tile has been drawn and links to
<https://www.openstreetmap.org/copyright>; tiles are cached at runtime only, in
their own `behere-tiles-v1` cache, and **never** enter `precache.json` or the
install-time shell precache, because bulk-downloading tiles across 674 cells
would breach the OSM tile usage policy. There is no prefetching and no
speculative loading: only tiles intersecting the current viewport are requested.
When tiles fail or are switched off, the map degrades to the baked vector
layers and still answers "where am I" offline.

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
- **The tile gate lives in `gen_precache.py`, not in a workflow step**, so it
  cannot be skipped by editing YAML and it fails on a laptop before it fails in
  Actions. It scans the **raw** service worker, not a comment-stripped copy, for
  every forbidden string: over-stripping would make the gate *laxer*, because a
  shell entry `"https://tile.openstreetmap.org/…"` would have its own URL blanked
  as a `//` comment and sail through. Comments are stripped only for the
  "named exactly once" count.
- **`web/app/map.css` is the sole owner of every `.map*` selector.** Both
  stylesheets used to define all 22 of them with different colour values;
  `map.css` won on load order and `app.css`'s copy was dead weight waiting to
  drift. One of those dead rules, `.map-tiles[data-state="failed"]{display:none}`,
  actively contradicted `map.js`, which deliberately *keeps* already-loaded tiles
  after a failure: the CSS deleted them and left an ODbL credit sitting over an
  invisible basemap. If you add a `.map*` rule, add it to `map.css`.
- **Never `git mv` or rename `web/fonts/*.woff2`.** They are in `SHELL_REQUIRED`,
  where a rename fails the service worker install outright, which is the correct
  loud outcome but an obscure one to debug. `scripts/fonts.lock.json` pins each
  one by sha256; run `python3 scripts/fetch_fonts.py --check` before blaming
  anything else.
- The design prototype in `design/*.zip` loads **React from unpkg** and
  `@import`s **Google Fonts**. Neither is in `web/`, and neither may ever be. If
  you are copying markup out of the prototype, copy the structure, not the
  `<script>` and not the `@import`. Unzip it somewhere untracked; the extracted
  path `design/prototype/` is gitignored on purpose, so that a `react` or
  `googleapis` hit anywhere in this repo means a real regression.
