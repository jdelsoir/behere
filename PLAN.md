# BeHERE

**A location-first Belgian civic and tourist app. Static PWA, GitHub Pages, no backend.**

Build brief for Claude Code. Self-contained: everything needed is in this file. All figures were measured against live endpoints on **14 August 2026**. Counts drift, so re-verify before relying on any number (see Appendix A).

---

## 1. What BeHERE is

One screen that answers four questions about the ground you are standing on, in the order a person actually asks them:

| Band | Question | What it shows |
|---|---|---|
| **Here** | Where am I? | Address, neighbourhood (statistical sector), municipality with its official names, province, region |
| **Around** | What is around me? | Heritage, tourism, parks, playgrounds, markets, recycling, charging points, sorted by real distance in metres |
| **Go** | How do I get there? | Nearest stops from four operator feeds, with live departures and realtime delays |
| **Now** | What can I do? | Time-filtered opportunities: open today, market this morning, collection tomorrow, event this weekend |

Audience is both residents and visitors. Three UI languages: **NL, FR, EN** (DE in the label resolver, not in the UI switcher).

### Non-goals

- **Not a municipality comparator.** No league tables, no rankings, no "your town versus theirs". Zooming out to province and country replaces comparison with context.
- **No backend, no proxy, no API keys, no secrets.** GitHub Pages serves static files only, and the repo is public. Every runtime source must be keyless and CORS-permissive, or it gets baked at build time.
- **No machine translation of street or place names.** A translated street name is a wrong street name when you ask a local for directions.

---

## 2. Hard constraints

| Constraint | Value |
|---|---|
| Hosting | GitHub Pages, project page at `/behere/` |
| Published site size | 1 GB hard limit |
| Single file size | 100 MB hard limit (Git rejects above this) |
| Bandwidth | 100 GB per month, soft |
| Server-side code | None available |
| Response headers | Cannot be set. CSP must go in a `<meta>` tag |
| Secrets | None may exist in the repo |

`start_url`, `scope` and manifest `id` must all equal the base path `/behere/`.

---

## 3. Verified data inventory

The decisive property of each source is whether a browser on a `github.io` origin can call it. Every row below was tested by sending `Origin: https://example.github.io` and reading the `Access-Control-Allow-Origin` response header.

### 3.1 Runtime sources (call live from the browser)

| Source | Endpoint | ACAO | Notes |
|---|---|---|---|
| **Transit GTFS static, all 4 operators** | `https://api-management-discovery-production.azure-api.net/api/gtfs/feed/{delijn\|tec\|stibmivb\|nmbssncb}/static` | `*` | **No key, no registration.** De Lijn 175,963,748 B, TEC 85,001,105 B, STIB 17,532,729 B, NMBS 8,776,192 B |
| **Transit GTFS realtime** | `.../api/gtfs/feed/{op}/rt/{trip-update\|alert\|vehicle-position}` | `*` | protobuf. De Lijn trip-update 2.8 MB, NMBS trip-update 116,628 B, TEC vehicle-position 68,052 B. TEC is the only operator publishing vehicle positions |
| **Train stations and live departures** | `https://api.irail.be/v1/stations?format=json&lang=en` | echoes origin | 714 stations. `lang` accepts `nl`, `fr`, `en`, `de`. Rate limit 3 requests per second, send a descriptive User-Agent |
| **Statistics per municipality** | `https://opendata-api.statbel.fgov.be/tf_hvd_*` | echoes origin | PostgREST 11.2.2, OpenAPI at root. 11 tables, 202,650 rows. Exact counts via `Prefer: count=exact` + `Range: 0-0`, read `content-range` |
| **Walloon tourism POI** | `https://geoservices.wallonie.be/arcgis/rest/services/TOURISME/OFFRES_TOURISTIQUES/MapServer` | echoes origin | CC BY 4.0. 13 layers, `maxRecordCount` 2000 |
| **Flemish heritage, point in polygon** | `https://geo.onroerenderfgoed.be/zoekdiensten/afbakeningen?geometrie={GeoJSON point}&crs=EPSG:4326` | `*` | Returns protected monuments, landscapes, archaeological zones, UNESCO core and buffer, with geometry |
| **City place datasets** | `https://{www.odwb.be\|data.stad.gent\|opendata.brussels.be}/api/explore/v2.1/catalog/datasets` | `*` | Opendatasoft Explore v2.1, no key, 20,000 calls per day per client (`x-ratelimit-limit` header) |
| **Brussels regional catalogue** | `https://catalog.datastore.brussels/geonetwork/srv/eng/q?_content_type=json` | `*` | 544 records. The `/api/search` path returns 403, use this one |

> **Trap:** a `HEAD` request to any NAP `/static` feed returns HTTP 404 with a JSON body, while `GET` on the same URL returns HTTP 200 and a real ZIP. Never health-check those endpoints with HEAD.

### 3.2 Bake-time sources (fetch in CI, ship as shards)

No CORS header, so the browser cannot fetch these directly.

| Source | URL | Size | Contents |
|---|---|---|---|
| **BeSt Address** | `https://opendata.bosa.be/download/best/openaddress-be{bru,vlg,wal}.zip` | 17.9 + 152.6 + 61.3 MB | 7,139,126 addresses. Columns include `address_id`, `street_id`, `municipality_id` (NIS), `postcode`, `streetname_nl/fr/de`, `EPSG:31370_x/y`, `EPSG:4326_lat/lon`, `status` |
| **Statbel address to sector** | `https://doc.statbel.fgov.be/publications/OpenData/TF_RGN_ADDRESSES_STAT_SECTORS_20250401.txt.zip` | 212.4 MB zip, 926.4 MB CSV | 4,490,779 rows. Pipe-delimited. See section 4 for the columns that matter |
| **Statistical sector geometry** | Statbel, `sh_statbel_statistical_sectors_31370_20260101` | 52.3 MB zip | Also available in EPSG:3812 and GeoJSON |
| **Flemish tourist products** | `https://linked.toerismevlaanderen.be` bulk CSV | 10.5 MB, 35,496 rows | NL labels only. 91% carry lat/long. No NIS code, join via `main_city_name` or coordinates. Also forces `content-disposition: attachment` |
| **Walloon tourism bulk (offline fallback)** | `OFFRES_TOURISTIQUES_GEOPACKAGE_31370.zip` / `OFFRES_TOURISTIQUES_CSV.zip` | 2.0 MB / 1.4 MB | Same content as the live ArcGIS service |
| **TEC GTFS direct (fallback only)** | `https://opendata.tec-wl.be/GTFSV3/TEC-GTFSV3.zip` | 80,557,824 B | Keep as a bake-time fallback if the NAP changes its terms |

### 3.3 Blocked, do not use

| Source | Why |
|---|---|
| `data.delijn.be` | Mandatory self-service registration, personal `api-key`, custom Dutch licence PDF. **Unnecessary:** the same feed is keyless on the NAP |
| `linked.toerismevlaanderen.be/sparql` | No CORS, and it returns nginx 504 on non-trivial queries |
| CBE / KBO open data | Registration wall plus a ban on direct-marketing reuse. Out of scope for this app |

---

## 4. The join spine

The Statbel address-to-sector file is the backbone. Its useful columns:

| Column | Role in BeHERE |
|---|---|
| `CD_REFNIS` | Municipality identity (NIS code). Joins to every statistic and to the province and region hierarchy |
| `CD_SECTOR_2024` | Neighbourhood identity. The polygon behind "your area". Example `11001A20-` |
| `CD_STR` | Street identity. Joins to BeSt `street_id` for trilingual street names |
| `CD_ZIP` | Postcode. **Never** use as a municipality key, see the trap below |
| `GRD_NEWID` | **1 km spatial bucket**, example `1kmN3126E3927` |
| `XY_LON_WGS84`, `XY_LAT_WGS84` | Direct browser use, no reprojection |
| `XY_X_LB72`, `XY_Y_LB72` | EPSG:31370 metric maths, joins to every Belgian WFS layer |
| `TX_REFNIS_DESCR_NL/FR/DE` | Official municipality names in three languages |

### Use GRD_NEWID as the spatial index

Do not add a quadtree, an R-tree, or a WASM spatial library. Shard the baked data by 1 km grid cell. Nearest-neighbour lookup is then:

1. Compute the user's cell from their coordinates.
2. Load that cell plus its 8 neighbours (9 small JSON files, all cacheable).
3. Sort candidates by haversine distance.

This works fully offline and has no dependencies.

### Trap 1: municipal mergers

The April 2025 vintage contains **565 municipalities, not 581**. Belgium had 581 until the Flemish merger wave of 1 January 2025.

- Pin **one vintage** across the whole app (2025 or 2026), and record it in every shard's metadata.
- Create `data/nis_history.json` with `{old_nis, new_nis, valid_from}` from day one, covering at least the 2019 and 2025 waves.
- Never join a statistic to a geometry from a different vintage without passing through that table.

### Trap 2: postcode is not a municipality

City of Brussels (NIS 21004) spans **10 postcodes**, including 1000, 1020, 1120 and 1130. Postcode 1000 is a subset of the municipality, not a synonym. Resolve a position to NIS through the address record or the sector polygon, never through the postcode.

---

## 5. Language

### What actually exists at record level

| Layer | NL | FR | DE | EN |
|---|---|---|---|---|
| Municipality names (Statbel) | yes | yes | yes | **no** |
| Street names (BeSt Address) | yes | yes | yes | **no** |
| Train stations (iRail) | yes | yes | yes | **yes** |
| Walloon tourism POI | no | yes | no | no |
| Flemish tourist products | yes | no | no | no |
| Flemish heritage | yes | no | no | no |
| GTFS `stop_name` | single string, in the operator's own language | | | |

English exists nowhere except iRail. Plan around that fact.

### The label resolver

One function, used for every user-visible label:

```
label(entity, ui_lang):
  1. entity.name[ui_lang]                  // authored, e.g. streetname_fr
  2. curated_override[entity.id][ui_lang]  // our own list, see below
  3. entity.name[region_default]           // nl in Flanders, fr in Wallonia
  4. entity.name[any]                      // last resort, never blank
     + flag the string as untranslated so the UI can mark it
```

The curated override is small enough to hand-write and review: 565 municipality names in EN, roughly 40 category labels, plus app chrome. **Under 700 strings total.** Street names and POI names stay in their authored language on purpose.

### Regional language rules that shape the UI

Flanders communicates officially in Dutch only. Brussels is bilingual FR and NL. Wallonia is French, with a German-speaking Community in the east.

- Default the UI language from the **municipality the user is standing in**, not from the browser locale. Let the user override, and remember the override.
- In Brussels, show both official names together.
- Arlon sits near the German-speaking area and Luxembourg, which is why DE stays in the resolver.

---

## 6. Architecture

```
BUILD TIME (GitHub Actions, scheduled)
  fetch  BeSt Address zips ............... 232 MB
  fetch  Statbel address+sector .......... 212 MB
  fetch  Statbel sector geometry ......... 52 MB
  fetch  Flemish tourism CSV ............. 10.5 MB
  fetch  4x GTFS static .................. 287 MB  (stops.txt only is kept)
  fetch  Walloon tourism GeoPackage ...... 2.0 MB
  emit   web/data/<nis>/*.json + web/data/grid/<cell>.json
  NOTHING above ships to the browser raw

RUNTIME (browser on github.io, no proxy)
  Statbel HVD API ......... context statistics per NIS
  Opendatasoft v2.1 ....... city place datasets
  Walloon ArcGIS REST ..... tourism POI, live
  Onroerend Erfgoed ....... heritage at this exact point
  NAP GTFS-RT ............. delays, protobuf
  iRail ................... live departures

SERVICE WORKER
  cache-first .............. hashed shards, sector geometry, app shell
  network-first ............ navigations, statistics, live departures
  stale-while-revalidate ... POI layers
  offline fallback ......... last-known departures with an explicit "as of" timestamp
```

### Repo layout

```
/
  PLAN.md                   this file
  .github/workflows/
    deploy.yml              Pages deploy, publish path ./web, concurrency: pages
    refresh-data.yml        scheduled bake, opens a PR or commits shards
  scripts/
    bake.py                 idempotent, byte-identical output for identical input
    gen_icons.py            192 / 512 / maskable 512 / apple / favicon
  web/
    index.html
    manifest.webmanifest    start_url, scope, id all = /behere/
    sw.js                   never rename this file
    offline.html
    404.html
    .nojekyll
    app/                    js modules: here, around, go, now, i18n, geo
    data/
      meta.json             vintage, build date, source list
      nis_history.json      {old_nis, new_nis, valid_from}
      i18n/en.json          the curated override
      <nis>/streets.json
      <nis>/meta.json
      <nis>/sector.geojson  simplified, target < 150 KB
      grid/<GRD_NEWID>.json addresses + stops + baked POI for one 1 km cell
```

### Screen model

Four bands stacked on one screen. No tabs, no dashboard.

| Band | Source | Offline behaviour |
|---|---|---|
| Here | baked shards | full |
| Around | baked plus live | baked subset |
| Go | stops baked, departures live | stops and timetable only |
| Now | live plus calendar rules | calendar rules only |
| Zoom out (province, country) | Statbel HVD API | last fetched |

**Never render an empty panel.** A missing layer collapses. Say "no market data published for this municipality" rather than showing a blank card. That copy is honest and doubles as a nudge toward the municipality.

---

## 7. Pilot cities

Seven municipalities for human testing. Address and sector counts read from the official Statbel file; tourism counts from live queries.

| City | NIS | Addresses | Sectors | Postcodes | Tourism records | Local portal | Expect |
|---|---|---|---|---|---|---|---|
| Ghent | `44021` | 137,119 | 199 | 10 | 889 | data.stad.gent, 307 datasets | richest |
| Liège | `62063` | 68,895 | 185 | 5 | 560 | ODWB, 94 + 6 datasets | rich |
| City of Brussels | `21004` | 36,425 | 118 | 10 | 1 | opendata.brussels.be, 207 datasets | rich |
| Ostend | `35013` | 23,986 | 71 | 1 | **2,962** | none | tourism-heavy, civic-thin |
| Arlon | `81001` | 11,053 | 70 | 1 | 195 | ODWB, 3 datasets | thin |
| Ottignies-Louvain-la-Neuve | `25121` | 10,079 | 60 | 4 | 76 | **zero datasets** | thinnest |
| Andenne | `92003` | 9,825 | 74 | 1 | 38 | ODWB, 19 datasets | thin |

Official names, from Statbel: Gent / Gand, Luik / Liège / Lüttich, Brussel / Bruxelles / Brüssel, Oostende / Ostende, Aarlen / Arlon, Ottignies-Louvain-la-Neuve, Andenne.

### The architectural rule these cities force

**National layers first, local layers as enrichment.** Two of the seven publish almost nothing locally. That is why they are in the set. Every city gets addresses, sector polygons, statistics, transit stops and tourism or heritage from national or regional sources. City portals only add texture.

Ottignies-Louvain-la-Neuve, with 0 local datasets, still gets 10,079 addresses, 60 sectors, 76 tourism records, live train and TEC departures, and full Statbel context. If it feels empty, the architecture is wrong, not the city.

---

## 8. Byte budget

Measured by extracting each city from the Statbel file, serialising minified JSON, and gzipping.

| Scope | Raw | Gzipped |
|---|---|---|
| Ghent | 6.9 MB | 893 KB |
| Liège | 3.6 MB | 551 KB |
| City of Brussels | 1.8 MB | 297 KB |
| Ostend | 1.2 MB | 195 KB |
| Arlon | 590 KB | 95 KB |
| Ottignies-LLN | 548 KB | 88 KB |
| Andenne | 528 KB | 86 KB |
| **Seven cities total** | **15.3 MB** | **2.15 MB** |
| All 565 municipalities | ~230 MB | ~33 MB |

Density is flat at 6.7 to 9.0 gzipped bytes per address, so the budget scales linearly.

**Do not commit the national bundle in the MVP.** Ship the seven cities and lazy-load per municipality later. Keep generated data out of Git history where possible, so the repo does not accumulate a copy of every vintage. If the national bundle is wanted later, store shards pre-compressed and decode with `DecompressionStream("gzip")` in the browser.

---

## 9. Build phases

Sequential. Each phase gates the next.

### Phase 0: shippability pre-flight

Run the `static-pwa-ghpages` skill's pre-flight before promising a deploy.

```bash
python3 scripts/ghpages_preflight.py ./web --repo-name behere
```

**Exit criteria:** GO or GO-WITH-FIXES. No absolute asset paths, `.nojekyll` present, no file over 100 MB, no secrets. This app has no secrets by design, which is worth verifying rather than assuming.

### Phase 1: data pipeline, seven cities

One idempotent script producing byte-identical output for identical input, so a scheduled rebuild yields a clean diff.

- Fetch BeSt Address and the Statbel address-to-sector file, filter to the 7 NIS codes
- Emit `web/data/<nis>/streets.json`, `web/data/<nis>/meta.json`, `web/data/grid/<GRD_NEWID>.json`
- Simplify sector polygons per municipality, target under 150 KB each
- Extract `stops.txt` from the four NAP GTFS zips, shard by 1 km cell
- Build `nis_history.json` and the 565-row EN name override

**Exit criteria:** all seven cities resolve offline from a cold cache. Total shipped data under 3 MB gzipped.

### Phase 2: the four bands, unstyled

Build against real shards and real live endpoints. Unstyled but complete, so data gaps surface before design is layered on top.

- **Here:** geolocation, 9-cell grid read, nearest address, sector, NIS, hierarchy
- **Around:** merge baked POI with live Opendatasoft and Walloon ArcGIS calls, sort by haversine
- **Go:** nearest stops from the baked index, live departures from iRail and NAP realtime
- **Now:** time filter over opening hours, market days, collection calendars
- Language resolver with the four-step fallback and the untranslated marker

**Exit criteria:** all seven cities render all four bands with no blank panels, Ottignies-Louvain-la-Neuve included.

### Phase 3: PWA shell

Hand-rolled static lane (no framework build to hook into). Use the `static-pwa-ghpages` templates.

- `manifest.webmanifest` with `start_url`, `scope` and `id` all set to `/behere/`
- Icons at 192, 512 and a padded maskable 512 via `gen_icons.py`
- Service worker per the caching table in section 6. **Never rename `sw.js`**
- Offline page that still answers Here and the baked part of Around
- CSP `<meta>` tag listing exactly the runtime hosts from section 3.1, since Pages cannot send headers

**Exit criteria:** installable per Chrome DevTools, Application panel. Airplane mode still answers "where am I".

### Phase 4: deploy and verify

```bash
cp -r assets/templates/.github .github
python3 scripts/stamp_cache_version.py ./web
gh repo create behere --public --source . --push
bash scripts/smoke_test.sh https://<user>.github.io/behere/
```

Set the workflow publish path to `./web`, keep `concurrency: pages`, add the scheduled data rebuild. Keep `kill-sw.js` on hand: a bad service worker serves stale HTML forever, and the fix is to overwrite `sw.js` at the same URL.

**Exit criteria:** smoke test green, every asset 200 with the correct content type, install prompt appears.

### Phase 5: human testing

Test for contrast, not uniformity.

| City | The question the tester answers |
|---|---|
| Ghent, Brussels City | Does the richest case overwhelm the screen? |
| Ostend | Tourist-heavy and civic-thin. Does it read as useful to a resident? |
| Liège | Does the FR default with NL and DE names displayed feel right? |
| Ottignies-LLN, Andenne | Does thin data read as honest, or as broken? |
| Arlon | Does the DE fallback matter this close to the border? |

**Exit criteria:** a tester in the thinnest city can still answer all four questions and does not describe the app as empty.

---

## 10. Acceptance tests

1. Cold start, airplane mode, in each of the 7 cities: Here resolves to an address, sector and municipality.
2. Postcode 1000 never resolves to "the municipality of Brussels" on its own.
3. A statistic from a pre-2025 vintage either passes through `nis_history.json` or is refused, never silently dropped.
4. No UI string is ever blank. Untranslated strings are visibly marked.
5. UI language defaults from the municipality, not the browser, and the user override persists.
6. Around returns results in Ottignies-Louvain-la-Neuve.
7. No network call carries a key, token or credential. `grep` the built output to prove it.
8. Every layer displays its source and its vintage date.
9. Geolocation is debounced. Live results are cached 30 to 60 seconds. No polling loops.
10. Total shipped data under 3 MB gzipped for the seven cities.

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| The NAP is a single point of failure for all four transit feeds | Keep the direct TEC URL and the iRail GTFS mirror as bake-time fallbacks. Pin the last good stop index in the repo |
| NAP keyless access is undocumented, verified by request rather than by published policy | Show a source and date line per layer from day one. Cache politely, respect observed rate ceilings |
| Flemish tourism content is coast-skewed and is an accommodation register, not an attraction index | Do not lean on it for Ghent. Use heritage point queries and city datasets there |
| No English at source | The curated ~700-string override, plus visible honesty when a label is untranslated |
| Vintage drift: 565 versus 581 municipalities, sector codes dated 2024 inside a 2025 file, Statbel period labels disagreeing with filenames | Pin one vintage per release, store it in shard metadata, show it in the footer |
| Rate limits: iRail 3 req/s, Opendatasoft 20,000/day | Debounce, cache, never poll |
| iOS evicts caches and IndexedDB after 7 days in a plain tab (installed PWAs exempt) | Prompt installation early. A cold start must work with no cache |

### Not verified, do not plan around these yet

The research run that produced this brief hit a session limit before finishing. These were never adversarially checked:

- Onroerend Erfgoed **bulk download** sizes (the point-query API itself was verified live, with permissive CORS)
- Brussels regional POI licence terms on `datastore.brussels`
- Whether a `visit.brussels` open API exists at all
- Walloon cycling and walking node network endpoints, including RAVeL
- Blue-bike, Villo and Donkey Republic station feeds
- The De Lijn licence PDF text
- Country-wide layers for defibrillators, pharmacies on duty and EV charging

None of them block Phase 0 or Phase 1. Resolve them during Phase 2, when Around is being built.

---

## Appendix A: reproduce every number

```bash
# Opendatasoft catalogue size and per-dataset row counts
curl -s "https://www.odwb.be/api/explore/v2.1/catalog/datasets?limit=100&offset=0"
# read total_count and metas.default.records_count, page until offset >= total_count

# Statbel high value datasets, exact row counts
curl -s -D - -o /dev/null -H "Prefer: count=exact" -H "Range: 0-0" \
  "https://opendata-api.statbel.fgov.be/tf_hvd_demo_population?limit=1"
# read the content-range header -> 0-0/30322

# BeSt Address national row count
for r in bru vlg wal; do
  curl -sO "https://opendata.bosa.be/download/best/openaddress-be$r.zip"
done
unzip -p 'openaddress-be*.zip' | wc -l    # 846,971 + 4,211,714 + 2,080,441

# CORS check on any candidate source
curl -sI -H 'Origin: https://example.github.io' <url> | grep -i access-control-allow-origin

# NAP GTFS: use GET, not HEAD (HEAD returns 404)
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' \
  "https://api-management-discovery-production.azure-api.net/api/gtfs/feed/tec/static"

# Walloon tourism POI count for one commune
curl -s "https://geoservices.wallonie.be/arcgis/rest/services/TOURISME/OFFRES_TOURISTIQUES/MapServer/11/query?where=COMMUNE='Arlon'&returnCountOnly=true&f=json"

# Flemish heritage at a point
curl -s -G 'https://geo.onroerenderfgoed.be/zoekdiensten/afbakeningen' \
  --data-urlencode 'geometrie={"type":"Point","coordinates":[3.7255,51.0536]}' \
  --data-urlencode 'crs=EPSG:4326'
```

## Appendix B: source of this brief

Two research passes over Belgian open data, August 2026. Sources: `opendata.bosa.be`, `doc.statbel.fgov.be`, `opendata-api.statbel.fgov.be`, `geoservices.wallonie.be`, `geo.onroerenderfgoed.be`, `linked.toerismevlaanderen.be`, `api-management-discovery-production.azure-api.net`, `api.irail.be`, `opendata.tec-wl.be`, `www.odwb.be`, `data.stad.gent`, `opendata.brussels.be`, `catalog.datastore.brussels`, `metadata.vlaanderen.be`, `data.gov.be`, `github.com/Fedict/dcattools`.

Related skill: `static-pwa-ghpages` (pre-flight, PWA templates, deploy workflow, smoke test).
