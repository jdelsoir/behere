# BeHERE

**A location-first Belgian civic and tourist app. Static PWA, GitHub Pages, no backend.**

Build brief for Claude Code. Self-contained: everything needed is in this file. All figures were measured against live endpoints on **14 August 2026**. Counts drift, so re-verify before relying on any number (see Appendix A).

> **Revised 15 August 2026, after the build.** Six claims in the original brief did not survive contact with the data and have been corrected in place: the sector join in section 4, the sector counts in section 7, the Statbel HVD granularity and Opendatasoft rate limits in section 3.1, the GTFS stop-name language claim in section 5, and the byte budget in section 8. Each correction is marked **Corrected** and states what was measured. `docs/CONTRACT.md` carries the underlying evidence.
>
> **The pilot is nine municipalities, not seven.** Court-Saint-Etienne (`25023`) and Mont-Saint-Guibert (`25068`) were added the same day. The list lives in one place, `PILOTS` in `scripts/bake.py`; the CI gates and the offline test import it rather than repeating it, so counts in prose are descriptive and never authoritative.

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
| **Statistics per arrondissement** | `https://opendata-api.statbel.fgov.be/tf_hvd_*` | echoes origin | PostgREST 11.2.2, OpenAPI at root. 11 tables, 202,650 rows. Exact counts via `Prefer: count=exact` + `Range: 0-0`, read `content-range`. **Corrected:** this API never reaches municipality level. `CD_NUTS_LEVEL` maxes at 3, so the finest granularity is the arrondissement (NUTS 3). Column names are **UPPERCASE**; a lowercase filter returns HTTP 400. The schema differs per table. Zoom-out keys on `nuts3`, verified: `CD_NUTS_LVL3=eq.BE234` returns 495 rows |
| **Walloon tourism POI** | `https://geoservices.wallonie.be/arcgis/rest/services/TOURISME/OFFRES_TOURISTIQUES/MapServer` | echoes origin | CC BY 4.0. 13 layers, `maxRecordCount` 2000 |
| **Flemish heritage, point in polygon** | `https://geo.onroerenderfgoed.be/zoekdiensten/afbakeningen?geometrie={GeoJSON point}&crs=EPSG:4326` | `*` | Returns protected monuments, landscapes, archaeological zones, UNESCO core and buffer, with geometry |
| **City place datasets** | `https://{www.odwb.be\|data.stad.gent\|opendata.brussels.be}/api/explore/v2.1/catalog/datasets` | `*` | Opendatasoft Explore v2.1, no key. **Corrected:** the daily quota is **per portal, not a flat 20,000**. Measured: `data.stad.gent` 250,000, `opendata.brussels.be` 100,000, `www.odwb.be` 20,000. Always read the `x-ratelimit-limit` header rather than assuming |
| **Brussels regional catalogue** | `https://catalog.datastore.brussels/geonetwork/srv/eng/q?_content_type=json` | `*` | 544 records. The `/api/search` path returns 403, use this one |
| **OpenStreetMap raster basemap** *(added 15 August 2026)* | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` | n/a, it is an `<img>` | ODbL 1.0. The **only** runtime source that is not fetched with `fetch()`, so CORS does not apply and it is in `img-src`, never `connect-src`. Terms below are conditions of use, not preferences |

#### The basemap, and the five conditions attached to it

Added on 15 August 2026 with the map-first revamp (section 6). It is the one
layer in this app that is neither ours nor baked, and it is the one layer that
tells a third party roughly where the user is standing. That was a deliberate
choice, taken with the costs on the table, and it is paid for as follows.

1. **Attribution is visible, not buried.** `© OpenStreetMap contributors` is
   drawn on the map itself, linking to <https://www.openstreetmap.org/copyright>,
   on any frame where a tile has been drawn. ODbL 1.0 requires the credit; the
   OSM Foundation's attribution guidelines require that it be legible on the map
   rather than hidden behind an info button. It is a keyboard tab stop.
2. **Tiles are runtime-cached only, and never precached.** They live in their own
   `behere-tiles-v1` cache, capped at 300 entries and evicted least recently
   *used*, with a 7-day TTL. They are categorically barred from `precache.json`
   and from the install-time shell precache. Pre-fetching a basemap over the 674
   pilot cells is bulk downloading, which the OSM tile usage policy forbids in
   terms. `scripts/gen_precache.py` carries a **tile gate** that fails the build
   if the host reaches the manifest, any `sw.js` shell list, or any line calling
   `cache.add`/`addAll`; it runs inside `--check`, so CI cannot skip it by
   editing YAML.
3. **No prefetching, no speculation, no scraping.** Only tiles intersecting the
   current viewport are requested, one zoom level at a time. There is no
   pre-warm, no adjacent-tile lookahead, no background refresh loop.
4. **Failure degrades to the vector map.** After three consecutive tile errors
   the raster layer switches itself off and the app keeps drawing the baked
   sector polygons, streets and stops. In airplane mode the tiles simply never
   arrive, and acceptance test 1 is unaffected because it never depended on
   them. Already-loaded tiles are kept and stay attributed.
5. **The user can refuse it, and the refusal sticks.** *(Added 15 August 2026,
   closing the one gap the revamp shipped with.)* A fourth chip in the map
   legend toggles the raster underlay. It ships **on**, which is the decision
   that was taken, but a cost that cannot be declined is not a cost, it is a
   condition. The choice persists in `localStorage` under `behere.tiles`, so a
   reload honours it. The chip repaints from the map's own tile state rather
   than from the click, so it can never claim "on" while nothing is drawn, and
   `basemap` is deliberately kept out of the vector-layer object that
   `map.setLayers()` consumes. Covered by `scripts/test_integration.mjs` §10a.

The honest cost is recorded in section 11: a tile request tells OSM's CDN a
1 km-ish position and an IP address, and that request is made by the browser
directly, so no promise of ours can intercept it. It is the single reason the
sentence "your position never leaves the device" is now qualified rather than
absolute.

> **Trap:** a `HEAD` request to any NAP `/static` feed returns HTTP 404 with a JSON body, while `GET` on the same URL returns HTTP 200 and a real ZIP. Never health-check those endpoints with HEAD.
>
> **Trap, added 15 August 2026:** those endpoints also **ignore `Range:`**. A 100 KB range request to the De Lijn feed returned all 175,832,410 bytes with HTTP 200, not 206. Any fetcher that assumes a partial response, or that resumes a download by byte offset, will silently splice a second full body onto the first. The Walloon SPW download service behaves the same way. Treat a 200 in reply to a `Range` request as "start over from zero".

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
| `CD_SECTOR_2024` | ~~Neighbourhood identity. The polygon behind "your area".~~ **Corrected: do not use as a join key.** See below |
| `CD_STR` | Street identity. Joins to BeSt `street_id` for trilingual street names |
| `CD_ZIP` | Postcode. **Never** use as a municipality key, see the trap below |
| `GRD_NEWID` | **1 km spatial bucket**, example `1kmN3126E3927` |
| `XY_LON_WGS84`, `XY_LAT_WGS84` | Direct browser use, no reprojection |
| `XY_X_LB72`, `XY_Y_LB72` | EPSG:31370 metric maths, joins to every Belgian WFS layer |
| `TX_REFNIS_DESCR_NL/FR/DE` | Official municipality names in three languages |

### Corrected: the `CD_SECTOR_2024` join is dead, resolve sectors by geometry

The original brief assumed an address could be joined to its statistical sector by matching `CD_SECTOR_2024` against the sector geometry's code. **That join does not work.** The 2024/25 sector reform re-coded the sectors, and the address file's codes no longer correspond to the 2025 geometry. Measured match rates against `sh_statbel_statistical_sectors_31370_20250101`:

| City | Addresses joined by `CD_SECTOR_2024` |
|---|---|
| Ghent | 30.7% |
| Andenne | 14.2% |
| Liège | **2.58%** |

A 2.58% join is not a join. **Address-to-sector must be resolved at bake time by point-in-polygon** against the pinned sector geometry, using each address's `XY_LON_WGS84` / `XY_LAT_WGS84`. That is what `scripts/bake.py` does, and it is why `scripts/geo31370.py` exists.

Two consequences worth stating plainly:

- The sector counts in section 7 were derived from the dead join and were therefore wrong. They are corrected there.
- Point-in-polygon is the authority for a sector, so a sector code in the address file is evidence of nothing and must never be shown to a user.

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
| GTFS `translations.txt` **(corrected)** | yes | yes | yes | no |

English exists nowhere except iRail. Plan around that fact.

**Corrected 15 August 2026:** the claim that GTFS carries only a single-language `stop_name` is wrong. The NAP feeds ship a `translations.txt` with **authored** stop-name translations: STIB/MIVB 1,088 rows, NMBS/SNCB 654. These are official translations published by the operator, not machine output, so using them is fully compatible with the no-machine-translation rule and they should be preferred over the raw `stop_name` wherever they exist. De Lijn and TEC publish no translations, which is consistent with Flanders and Wallonia being monolingual regions.

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
  OSM raster tiles ........ the basemap, <img> not fetch, ODbL, §3.1

SERVICE WORKER
  cache-first .............. hashed shards, sector geometry, app shell, fonts
  network-first ............ navigations, statistics, live departures
  stale-while-revalidate ... POI layers
  runtime-only, never precached ... OSM tiles, own cache, 300 entries, LRU, 7d TTL
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
    fetch_fonts.py          vendors the two OFL faces, sha256-pinned, --check
  web/
    index.html
    manifest.webmanifest    start_url, scope, id all = /behere/
    sw.js                   never rename this file
    offline.html
    404.html
    .nojekyll
    app/                    js modules: here, around, go, now, zoom, i18n, geo,
                            map + mercator (the map), icons (inlined Lucide),
                            tokens.css + app.css + map.css
    fonts/                  self-hosted Caprasimo and Figtree woff2, plus each
                            family's own OFL text. No Google Fonts request.
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

**Corrected 15 August 2026, and this one is a reversal, not a measurement.**
The brief said *"Four bands stacked on one screen. No tabs, no dashboard."* The
app now ships map-first: a full-bleed map is the page, and the five bands live
in a dock of five pills along the bottom, one of which may be expanded into a
panel over the map. The original line stood against a *dashboard* — five cards
of equal weight, none of them the answer — and that objection is still right and
still honoured. What changed is the answer to "where am I": a stacked column of
text answered it in words while the screen showed nothing of the ground, and the
one question the app exists to answer is a spatial one.

What survives the change, unaltered, because it was never about layout:

- **One question per band, in the reader's own words.** The pills are a
  disclosure, not a tab strip: "no panel open at all" is a real and common
  state, which is exactly what the tabs pattern has no name for.
- **The band is the answer; the map is the answer drawn.** Every marker,
  polygon and outline on the map has a text equivalent in a band, and where the
  two disagree the text is the one that has to be right. `#map` is a single
  labelled tab stop (`role="group"`, arrow keys pan, `+`/`-` zoom, `Home`
  recentres) placed straight after the skip link, and each drawn layer inside it
  carries its own `aria-hidden`, so 49 stops in one Brussels shard are read once
  as the Go band's list and never a second time as 49 loose labels. A layer that
  is hidden is one that holds nothing focusable, so nothing becomes unreachable.
- **One authority per fact.** here.js resolves the statistical sector and the
  map is *told*; it never re-derives geometry.

| Band | Source | Offline behaviour |
|---|---|---|
| Here | baked shards | full |
| Around | baked plus live | baked subset |
| Go | stops baked, departures live | stops and timetable only |
| Now | live plus calendar rules | calendar rules only |
| Zoom out (province, country) | Statbel HVD API | last fetched |

The map adds one layer to that table, and it is the only one that is not ours:

| Layer | Source | Offline behaviour |
|---|---|---|
| Basemap raster | tile.openstreetmap.org, runtime only | **absent, and the vector map answers** |

Tiles are **never precached** — pre-fetching a basemap across 674 cells is bulk
downloading and an explicit breach of the OSM tile usage policy — so they live
in their own runtime cache, capped at 300 entries and evicted
least-recently-used. Attribution is visible on every frame where a tile has been
drawn, which is an ODbL term rather than a design choice. Acceptance test 1 is
unaffected: in airplane mode the raster layer simply never arrives and "where am
I" is still answered from the baked shards, on the ground colour.

**Never render an empty panel.** A missing layer collapses. Say "no market data
published for this municipality" rather than showing a blank card. That copy is
honest and doubles as a nudge toward the municipality. The revamp sharpened this
into three distinct silences, because they are three different claims: *published
nothing here*, *out of scope for this region by design*, and *could not be
reached*. Only the last is a fault, and only the last is styled like one.

---

## 7. Pilot cities

Nine municipalities for human testing. Address and sector counts read from the official Statbel file; tourism counts from live queries.

**Corrected 15 August 2026.** Address and postcode counts held exactly. The **Sectors** column did not: it was derived from the dead `CD_SECTOR_2024` join, and every figure was wrong. The values below are the real counts from point-in-polygon against the pinned 2025 geometry, with the original brief's claim in brackets. The `Stops` and `Cells` columns are new, measured from the shipped shards.

| City | NIS | Addresses | Sectors | Cells | Stops | Postcodes | Tourism records | Local portal | Expect |
|---|---|---|---|---|---|---|---|---|---|
| Ghent | `44021` | 137,119 | **254** (was 199) | 188 | 1,152 | 10 | 889 | data.stad.gent, 307 datasets | richest |
| Liège | `62063` | 68,895 | **217** (was 185) | 95 | 1,219 | 5 | 560 | ODWB, 94 + 6 datasets | rich |
| City of Brussels | `21004` | 36,425 | **112** (was 118) | 60 | 1,377 | 10 | 1 | opendata.brussels.be, 207 datasets | rich |
| Ostend | `35013` | 23,986 | **88** (was 71) | 52 | 233 | 1 | **2,962** | none | tourism-heavy, civic-thin |
| Arlon | `81001` | 11,053 | **71** (was 70) | 96 | 265 | 1 | 195 | ODWB, 3 datasets | thin |
| Ottignies-Louvain-la-Neuve | `25121` | 10,079 | **68** (was 60) | 42 | 166 | 4 | 76 | **zero datasets** | thin |
| Andenne | `92003` | 9,825 | **91** (was 74) | 98 | 259 | 1 | 38 | ODWB, 19 datasets | thin |
| Court-Saint-Etienne | `25023` | 3,770 | 25 | 34 | 94 | 1 | — | none | village |
| Mont-Saint-Guibert | `25068` | 2,648 | 21 | 22 | 92 | 1 | — | none | **thinnest** |

**Added 15 August 2026: Court-Saint-Etienne and Mont-Saint-Guibert.** Both sit in Walloon Brabant on `nuts3` BE310, the same arrondissement as Ottignies-Louvain-la-Neuve, and both are roughly a quarter of its size. They extend the thin end of the set: Mont-Saint-Guibert is now the smallest municipality in the pilot at 2,648 addresses, a fifty-second of Ghent. If the app reads as broken anywhere, it will read as broken here first.

Both are spelled as Statbel authors them. Statbel writes **Court-Saint-Etienne without the acute accent**, while preserving it in `Liège` in the same file, so the unaccented form is the authored name rather than an encoding fault on our side. It is left alone under the never-rewrite-authored-names rule. Supplying the accented form is a curated-override decision for `web/data/i18n/`, not something the bake may do.

Note that Andenne and Arlon span more 1 km cells than Ghent despite having a fourteenth of its addresses. They are rural municipalities with sparse addresses spread over a wide area, which is why they also carry more sector polygons than the original brief expected.

Official names, from Statbel: Gent / Gand, Luik / Liège / Lüttich, Brussel / Bruxelles / Brüssel, Oostende / Ostende, Aarlen / Arlon, Ottignies-Louvain-la-Neuve, Andenne.

### The architectural rule these cities force

**National layers first, local layers as enrichment.** Four of the nine publish nothing locally at all. That is why they are in the set. Every city gets addresses, sector polygons, statistics, transit stops and tourism or heritage from national or regional sources. City portals only add texture.

Ottignies-Louvain-la-Neuve, with 0 local datasets, still gets 10,079 addresses, 60 sectors, 76 tourism records, live train and TEC departures, and full Statbel context. If it feels empty, the architecture is wrong, not the city.

---

## 8. Byte budget

The original estimate assumed an array of verbose JSON objects. **Corrected 15 August 2026** against what the bake actually ships: parallel arrays with delta-encoded integers, no floating-point numbers in the grid shards, and empty language arrays omitted. That is 30% smaller than the estimate. The estimate is kept in brackets for comparison; the estimate itself was validated first by rebuilding the verbose layout and reproducing its numbers, so this is a fair comparison and not a change of measurement method.

| Scope | Raw | Gzipped | Original estimate |
|---|---|---|---|
| Ghent | 2,485,848 | **545,350** | (893 KB) |
| Liège | 1,416,035 | **336,568** | (551 KB) |
| City of Brussels | 839,444 | **199,811** | (297 KB) |
| Ostend | 470,205 | **118,596** | (195 KB) |
| Arlon | 317,615 | **94,925** | (95 KB) |
| Andenne | 303,821 | **91,598** | (86 KB) |
| Ottignies-LLN | 271,400 | **74,449** | (88 KB) |
| Court-Saint-Etienne | 144,777 | **42,644** | not in the original set |
| Mont-Saint-Guibert | 95,573 | **28,413** | not in the original set |
| Shared root + i18n | 115,438 | **24,231** | not counted |
| **Nine cities, whole shipped tree** | **6,464,673** | **1,553,038 B = 1.48 MB** | (2.15 MB for seven) |
| All 565 municipalities | ~150 MB | ~23 MB | (~33 MB) |

**49.4% of the 3 MB acceptance ceiling**, across 708 files and 674 grid shards. CI fails the build if this figure ever exceeds 3,145,728 B.

**Re-measured 15 August 2026 after the map-first revamp: 1,550,736 → 1,553,038 B, up 2,302.** Every one of those bytes is chrome copy in `web/data/i18n/{en,nl,fr}.json` (en +708, nl +782, fr +812) for the dock, the map controls, the tile note and the three distinct silences. **The revamp baked nothing**, and CI proves it rather than asserting it: the deploy run rebakes with `--offline` into a second directory and `diff -r`s the two, and it printed `byte-identical` on this release. The city rows above are unchanged and are an *attribution* of shared 1 km cells rather than a partition, so they do not sum to the total; only the total is a measured fact about the shipped tree.

Adding the two Walloon Brabant villages cost **56,354 gzipped bytes**, 1.8% of the ceiling for a 29% larger pilot set. Ottignies-LLN's own figure rose from 70,529 to 74,449 because its neighbours are now baked: addresses that were previously counted as foreign in its shared 1 km cells are real entries today.

Andenne is the one city that came in above its estimate, by 6%, because the original figure counted addresses only and Andenne ships 91 rural sector polygons. Density is no longer flat per address for exactly that reason: rural municipalities carry disproportionate polygon and cell overhead.

**Do not commit the national bundle in the MVP.** Ship the pilot cities and lazy-load per municipality later. Keep generated data out of Git history where possible, so the repo does not accumulate a copy of every vintage. If the national bundle is wanted later, store shards pre-compressed and decode with `DecompressionStream("gzip")` in the browser.

---

## 9. Build phases

Sequential. Each phase gates the next.

### Phase 0: shippability pre-flight

Run the `static-pwa-ghpages` skill's pre-flight before promising a deploy.

```bash
python3 scripts/ghpages_preflight.py ./web --repo-name behere
```

**Exit criteria:** GO or GO-WITH-FIXES. No absolute asset paths, `.nojekyll` present, no file over 100 MB, no secrets. This app has no secrets by design, which is worth verifying rather than assuming.

### Phase 1: data pipeline, the pilot cities

One idempotent script producing byte-identical output for identical input, so a scheduled rebuild yields a clean diff.

- Fetch BeSt Address and the Statbel address-to-sector file, filter to the pilot NIS codes in `bake.py`'s `PILOTS`
- Emit `web/data/<nis>/streets.json`, `web/data/<nis>/meta.json`, `web/data/grid/<GRD_NEWID>.json`
- Simplify sector polygons per municipality, target under 150 KB each
- Extract `stops.txt` from the four NAP GTFS zips, shard by 1 km cell
- Build `nis_history.json` and the 565-row EN name override

**Exit criteria:** every pilot city resolves offline from a cold cache. Total shipped data under 3 MB gzipped.

### Phase 2: the four bands, unstyled

Build against real shards and real live endpoints. Unstyled but complete, so data gaps surface before design is layered on top.

- **Here:** geolocation, 9-cell grid read, nearest address, sector, NIS, hierarchy
- **Around:** merge baked POI with live Opendatasoft and Walloon ArcGIS calls, sort by haversine
- **Go:** nearest stops from the baked index, live departures from iRail and NAP realtime
- **Now:** time filter over opening hours, market days, collection calendars
- Language resolver with the four-step fallback and the untranslated marker

**Exit criteria:** every pilot city renders all four bands with no blank panels, Mont-Saint-Guibert included.

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

1. Cold start, airplane mode, in each pilot city: Here resolves to an address, sector and municipality.
2. Postcode 1000 never resolves to "the municipality of Brussels" on its own.
3. A statistic from a pre-2025 vintage either passes through `nis_history.json` or is refused, never silently dropped.
4. No UI string is ever blank. Untranslated strings are visibly marked.
5. UI language defaults from the municipality, not the browser, and the user override persists.
6. Around returns results in Ottignies-Louvain-la-Neuve.
7. No network call carries a key, token or credential. `grep` the built output to prove it.
8. Every layer displays its source and its vintage date.
9. Geolocation is debounced. Live results are cached 30 to 60 seconds. No polling loops.
10. Total shipped data under 3 MB gzipped for the whole pilot set.

**All ten survive the map-first revamp unchanged, and three are worth reading against it explicitly.** Test 1 does not touch the basemap: in airplane mode no tile is ever requested, and Here resolves from the baked shards on the ground colour, which is why the raster layer had to be decoration over an answer rather than the answer. Test 7 holds because the tile URL is `{z}/{x}/{y}.png` with no query string, no header and no cookie, and because `img-src` admits exactly one host. Test 8 holds for the basemap too, by the ODbL credit on the map itself: a rolling live service has no vintage date to print, so it prints its source and says it is live, rather than inventing a date.

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| The NAP is a single point of failure for all four transit feeds | Keep the direct TEC URL and the iRail GTFS mirror as bake-time fallbacks. Pin the last good stop index in the repo |
| **A bulk source host is unreachable from a CI runner's egress IP.** Observed 15 August 2026: `statbel.fgov.be` blackholed a runner's IPv4 SYN, no RST and no ICMP. The egress IP is fixed for the whole job, so retrying cannot find another route, only outlast the block | The pinned 2025 sector geometry is mirrored as a release asset on this repo (`data-2025` tag) and tried **first**, with its sha256 enforced strictly and upstream as fallback. `Fetcher._probe` also caps a dead path at 15 s instead of the kernel's 127 s SYN-retry, and names the real errno instead of a misleading IPv6 `ENETUNREACH` |
| NAP keyless access is undocumented, verified by request rather than by published policy | Show a source and date line per layer from day one. Cache politely, respect observed rate ceilings |
| Flemish tourism content is coast-skewed and is an accommodation register, not an attraction index | Do not lean on it for Ghent. Use heritage point queries and city datasets there |
| No English at source | The curated ~700-string override, plus visible honesty when a label is untranslated |
| Vintage drift: 565 versus 581 municipalities, sector codes dated 2024 inside a 2025 file, Statbel period labels disagreeing with filenames | Pin one vintage per release, store it in shard metadata, show it in the footer |
| Rate limits: iRail 3 req/s, Opendatasoft 20,000/day | Debounce, cache, never poll |
| iOS evicts caches and IndexedDB after 7 days in a plain tab (installed PWAs exempt) | Prompt installation early. A cold start must work with no cache |
| **The basemap is an external dependency, and the only one that leaks position.** *(added 15 August 2026, with the map-first revamp.)* Every `tile.openstreetmap.org` request tells a third-party CDN an IP address and a tile coordinate, which is a position to about 1 km at z15. The browser issues it directly from an `<img>`, so nothing in this app can intercept or anonymise it. The tiles also **disappear entirely offline**, and they depend on a volunteer-funded service that owes us no availability and can change its terms without notice | **The vector layers always render, and they are the map.** Sector polygons, streets and stops come from the baked shards and are drawn whether or not a single tile arrives, so the raster is decoration over an answer rather than the answer itself. Three consecutive tile errors switch the layer off and the app carries on; airplane mode never sees a request at all, and acceptance test 1 does not touch tiles. The leak is bounded and disclosed: no query string, no identifier, no cookie, one host, declared in `img-src` and nowhere else, named in the README under "what leaves the device", and the attribution link on screen tells the user whose service they are talking to. Tiles are runtime-cached only (§3.1), so a revoked service degrades to the vector map instead of breaking the app |

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
