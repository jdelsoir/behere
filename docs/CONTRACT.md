# BeHERE data contract, v1

**Status: frozen.** Every schema below is measured against real bytes, not sketched. Code may be written against it.

**Authority.** This file outranks `PLAN.md` wherever the two disagree. `PLAN.md` remains the build brief; this file is the wire format. Section 12 lists every correction and why it was made.

**Vintage pin: `2025-01-01`.** One vintage for the whole release, recorded in every file that ships.

Measured 15 August 2026 against the live Statbel address file (all 4,490,779 rows), the 2025 sector geometry (20,781 features), all four NAP GTFS feeds, and the six live runtime APIs.

---

## 1. Global rules

These apply to **every** JSON file in `web/data/`. They are what make `bake.py` byte-identical across runs.

### 1.1 Serialisation

```python
BLOB = json.dumps(obj, sort_keys=True, ensure_ascii=False,
                  separators=(",", ":")).encode("utf-8") + b"\n"
```

| Rule | Value | Why |
|---|---|---|
| Key order | `sort_keys=True`, recursive, byte order of the UTF-8 key | Dict insertion order is not stable across Python versions |
| Separators | `(",", ":")` , no spaces | Minified |
| Encoding | UTF-8, **no BOM** | Matches the source file |
| Escaping | `ensure_ascii=False`, so `Brüssel` ships as literal UTF-8 | Smaller, and gzip likes it better |
| Newlines | LF only, exactly **one** trailing `\n`, none inside | CRLF in the source must be stripped |
| Arrays | Order is explicitly specified per file below. Never rely on set iteration order | `set` order varies per run under hash randomisation |

**`PYTHONHASHSEED` must not matter.** Every set is passed through `sorted()` before it reaches the serialiser. CI runs the bake twice and diffs, in the same job.

### 1.2 Floats: there are almost none, by design

Float formatting is the main idempotency hazard. The contract removes it rather than managing it.

| File | Floats allowed? | Rule |
|---|---|---|
| `grid/<cell>.json` | **None.** Zero floating-point numbers | All coordinates are integers in units of 1e-5 degrees |
| `<nis>/meta.json` | **None** | `bbox` is integers in units of 1e-5 degrees |
| `<nis>/sector.geojson` | Yes, unavoidable (must stay valid GeoJSON) | Exactly `round(v, 5)`, never more |
| `meta.json`, `streets.json`, `i18n/en.json` | **None** | No numeric coordinates |

Rounding is `round(v, 5)` (banker's rounding, deterministic in CPython). CI asserts with a regex that no number in any `.geojson` carries more than 5 decimal places:

```
-?[0-9]+\.[0-9]{6,}
```

**5 decimal places is ~1.1 m of latitude and ~0.70 m of longitude at 50.6 N. Do not ship more.** The source carries 9 to 11 decimals; shipping them would roughly double the geometry payload for sub-millimetre precision that no phone GPS can use.

### 1.3 Build date does not come from the clock

`meta.json` carries a build date, and a wall-clock date would break byte-identity on every rebuild. Therefore:

```
built = max(retrieved) over all entries in meta.json.sources
```

It is a **property of the inputs**, not of the run. Re-baking the same inputs next month produces the same byte. `SOURCE_DATE_EPOCH`, if set, overrides it for reproducible-build testing.

No other file carries a date other than the pinned `vintage` string.

### 1.4 Integer coordinate encoding (used by grid shards and bbox)

```
lat_deg = (origin_lat_u + delta_sum_y) / 100000
lon_deg = (origin_lon_u + delta_sum_x) / 100000
```

All values are integers. `origin_*_u` is the shard origin in the same 1e-5-degree units.

---

## 2. `web/data/meta.json`

Root manifest. Fetched once at startup, before anything else.

**Schema**

| Key | Type | Meaning |
|---|---|---|
| `contract` | int | Schema version of this document. `1`. Bump on any breaking change |
| `vintage` | string | The pinned data vintage, `"2025-01-01"` |
| `built` | string | `YYYY-MM-DD`, derived per 1.3, never from the clock |
| `municipalities` | string[] | NIS codes shipped in this release, ascending |
| `coord_dp` | int | `5`. The precision contract in one number |
| `grid` | object | `srs`, `size_m`, `cells` (total shard count) |
| `sources` | object[] | One entry per source, sorted by `id` |

Each `sources` entry: `id`, `title`, `publisher`, `url`, `retrieved` (`YYYY-MM-DD`), `vintage`, `licence`, `role`, and `runtime` (bool: true = called live by the browser, false = baked in CI).

**Worked example** (abridged to 4 of the 14 sources; shipped minified on one line)

```json
{
  "built": "2026-08-15",
  "contract": 1,
  "coord_dp": 5,
  "grid": {"cells": 674, "size_m": 1000, "srs": "EPSG:3035"},
  "municipalities": ["21004","25023","25068","25121","35013","44021","62063","81001","92003"],
  "sources": [
    {
      "id": "irail_liveboard",
      "licence": "Open Data, attribution requested",
      "publisher": "iRail / Open Knowledge Belgium",
      "retrieved": "2026-08-15",
      "role": "Live train departures for the Go band.",
      "runtime": true,
      "title": "iRail API v1",
      "url": "https://api.irail.be/v1/",
      "vintage": "live"
    },
    {
      "id": "nap_gtfs_static",
      "licence": "Keyless open access via the Belgian NAP",
      "publisher": "FPS Mobility and Transport (NAP)",
      "retrieved": "2026-08-15",
      "role": "stops.txt and translations.txt for all four operators. Baked, never fetched at runtime (287 MB).",
      "runtime": false,
      "title": "GTFS static, De Lijn / TEC / STIB-MIVB / NMBS-SNCB",
      "url": "https://api-management-discovery-production.azure-api.net/api/gtfs/feed/{operator}/static",
      "vintage": "2026-08-15"
    },
    {
      "id": "statbel_addr_sector_2025",
      "licence": "Statbel open data",
      "publisher": "Statbel (Statistics Belgium)",
      "retrieved": "2026-08-15",
      "role": "The join spine: 4,490,779 addresses with NIS, street, postcode, WGS84 and the GRD_NEWID 1 km cell.",
      "runtime": false,
      "title": "Addresses and statistical sectors, 2025-04-01",
      "url": "https://doc.statbel.fgov.be/publications/OpenData/TF_RGN_ADDRESSES_STAT_SECTORS_20250401.txt.zip",
      "vintage": "2025-04-01"
    },
    {
      "id": "statbel_sectors_2025",
      "licence": "Statbel open data",
      "publisher": "Statbel (Statistics Belgium)",
      "retrieved": "2026-08-15",
      "role": "Sector polygons, and the point-in-polygon authority for every address's 2025 sector.",
      "runtime": false,
      "title": "Statistical sectors, situation 2025-01-01",
      "url": "https://statbel.fgov.be/sites/default/files/files/opendata/Statistische%20sectoren/sh_statbel_statistical_sectors_31370_20250101.geojson.zip",
      "vintage": "2025-01-01"
    }
  ],
  "vintage": "2025-01-01"
}
```

The full file carries 14 sources. **Acceptance test 8 ("every layer displays its source and its vintage date") is satisfied by joining a layer's `source_id` to this list**, so no other file repeats source text.

### 2.1 `web/data/precache.json`

The list `web/sw.js` stores in the DATA cache at **install**, before any of it is
asked for.

This file exists because a cache-first *fetch rule* cannot satisfy PLAN phase 1's
exit criterion. Cache-first only ever fills the cache with squares the user has
already stood in while online, so a device warmed in Brussels and then carried to
Ghent in airplane mode has nothing for Ghent, and the Here band correctly reports
"no baked address near this position" while failing acceptance test 1. The whole
release is 6.2 MB raw and about 1.49 MB gzipped, which is half the section 11
budget, so it is stored up front.

`scripts/bake.py` writes it **last**, from `Writer.files`, so it cannot drift from
what was actually baked. `scripts/gen_precache.py` regenerates or `--check`s it
against a tree already on disk, sharing the same `precache_doc()` and the same
serialiser.

```json
{
  "cells": {"44021": ["grid/1kmN3116E3879.json", "…188 entries…"], "…8 cities…": []},
  "cities": ["21004","25023","25068","25121","35013","44021","62063","81001","92003"],
  "count": 707,
  "files": ["21004/meta.json", "…", "grid/1kmN2955E4015.json", "…", "nis_history.json"],
  "vintage": "2025-01-01"
}
```

> `count` was **658** when this section was written, for the seven original
> pilots. Court-Saint-Etienne and Mont-Saint-Guibert took it to **707** across
> **674** grid shards; the schema did not change. The map-first revamp of
> 15 August 2026 changed neither, because it baked nothing: the only data files
> it touched are the three hand-curated `i18n/*.json`, which were already in
> `files`.

| Field | Meaning |
|---|---|
| `files` | Every baked file, as a path relative to `web/data/`, sorted. **Never lists `precache.json` itself.** |
| `count` | `files.length`. A cheap integrity check for the worker |
| `cities` | The NIS codes in this release, sorted |
| `cells` | `nis -> [grid file, …]`. Shards are shared between neighbouring cities, so these lists deliberately overlap and do not sum to `count` |
| `vintage` | The pin. Verification gate 6 requires it, and the worker stamps its status message with it |

Rules the worker depends on:

- **Every entry resolves.** Gate 7 already proves each cell in `<nis>/meta.json.cells` has a shard; `files` is generated from the bytes actually written, so a 404 during the precache means the deployed tree and the manifest disagree.
- **The install may never fail because of it.** `precacheData()` is wrapped in `try/catch`, batches through `Promise.allSettled`, and skips what is already cached. A quota error, an offline install or a single missing shard degrades to the pre-existing lazy behaviour.
- **It is served network-first**, not cache-first: a stale manifest would precache the previous release's shard list.
- **The page never assumes it worked.** `{type:"DATA_STATUS"}` returns `{total, stored, cities, vintage, ready}` counted from the cache's own keys, and the app sheet prints that instead of a promise.
- **No entry may be absolute, and the OSM tile host may never appear.** Every `files` entry is a path relative to `web/data/`; a leading `/`, a `//`, a `://` or a `..` fails the build. `bake.py`'s `assert_baked_relpath()` makes one impossible to *write*; `gen_precache.py`'s **tile gate** (gate 13) re-checks the bytes actually shipped, so a hand-edited or merge-mangled manifest is caught too. The reason is not tidiness: `sw.js` precaches every entry of this file at install for all nine cities at once, so a tile URL here would be bulk downloading, which the OSM tile usage policy forbids in terms.

### 2.2 The app shell precache list

`precache.json` covers `web/data/` only. The shell is a separate, hand-maintained
list inside `web/sw.js`, in three tiers, and the tiers are a contract of their own:

| Tier | Failure mode | What belongs in it |
|---|---|---|
| `SHELL_REQUIRED` (23 entries) | `cache.addAll`, so **one 404 fails the whole install** and the user gets no worker | Everything without which the app is not the app: 4 document entries (`./`, `index.html`, `offline.html`, `manifest.webmanifest`), 3 stylesheets (`tokens.css`, `app.css`, `map.css`), 10 core modules (`main`, `map`, `mercator`, `grid`, `geo`, `i18n`, `icons`, `stats`, `sw-register`, `offline`), **the 4 `.woff2` faces**, and the 2 core PNG icons |
| `SHELL_EXPECTED` (0 entries) | added one at a time, a miss is logged and skipped | A module that has landed in the deploy but may not be in every build. **Currently empty, and that is the finished state, not an oversight.** It held `./app/dock.js` while the revamp was in flight; the dock ended up inside `main.js` (`openBand` / `wireDock` / `watchPillState`), so nothing on disk carries that name and listing it would make every install log a warning about a file the app does not want. The tier is kept for the *next* module that ships mid-flight |
| `SHELL_OPTIONAL` (10 entries) | added one at a time, a miss is ignored silently | The 5 band modules, `gtfsrt.js`, `404.html` and the 3 decorative icons: a missing band collapses its own panel and must never take the worker down with it |

Two rules that are easy to get wrong:

- **The fonts are `REQUIRED`, not `OPTIONAL`.** A shell that precaches `tokens.css` but not its faces installs happily and then renders offline in `system-ui`. They cost about 53 kB once, they are already Brotli-compressed, and they never touch the 3 MB budget, which walks `web/data/` only.
- **No shell entry may contain a scheme.** All are relative (`"./app/map.js"`), because the site is a project page under `/behere/` where a leading slash 404s. The tile gate enforces this too: a `://` anywhere in any of the three lists fails the build.

Renaming any `SHELL_REQUIRED` entry is a breaking change that fails the install
loudly, which is correct but obscure to debug. `scripts/test_sw_offline.mjs`
turns red first.

---

## 3. `web/data/municipalities.json` and `web/data/nis_history.json`

**Both already exist and are frozen as written.** 66,392 B and 13,473 B as currently on disk, byte-identical across reruns, regenerated by `scripts/build_municipalities.py`. (`municipalities.json` grows by about 6 KB when `nuts3` is added, per the note below.)

They already comply with section 1. Two properties that the rest of the contract depends on:

- `municipalities[nis].prov` is **`null`** for the 19 Brussels municipalities. Consumers must handle null, not empty string.
- `nis_history.records[].kind` is `"merger"` or `"recode"`. **Acceptance test 3** is: a pre-2025 statistic either passes through this table or is refused. A `recode` may be followed silently; a `merger` means the old boundary is gone and any per-municipality figure crossing it is an aggregate, which the UI must say out loud.

One field is **added** by this contract, because the Statbel HVD runtime API needs it (see 9.4):

```json
"44021": {"de":"Gent","dstr":"44000","fr":"Gand","nl":"Gent","nuts3":"BE234","prov":"40000","rgn":"02000"}
```

`nuts3` comes from `cd_nuts_lvl3` in the sector geometry. Verified for all nine pilots: 44021→BE234, 62063→BE332, 21004→BE100, 35013→BE255, 81001→BE341, 25121→BE310, 92003→BE352, 25023→BE310, 25068→BE310. The three Walloon Brabant pilots share BE310, which is why the zoom-out band must key on `nuts3` and never assume it identifies a municipality.

---

## 4. `web/data/<nis>/meta.json`

One per municipality. Small, fetched as soon as position resolves to a NIS.

**Schema**

| Key | Type | Meaning |
|---|---|---|
| `nis` | string | 5 digits, the 2025 code |
| `name` | object | `nl`, `fr`, `de`. Official Statbel names. **No `en`**, that comes from the override |
| `rgn`, `prov`, `dstr`, `nuts3` | string / null | Hierarchy keys into `municipalities.json`. `prov` is null in Brussels |
| `lang` | object | `default` (one of `nl`/`fr`/`de`) and `official` (array). See 4.1 |
| `counts` | object | `addresses`, `streets`, `sectors`, `cells`, `stops` |
| `zips` | string[] | Every postcode in the municipality, ascending. **Not a key, a display list** |
| `cells` | string[] | Every `GRD_NEWID` shard for this municipality, ascending. Lets the SW precache a whole city |
| `bbox` | int[4] | `[min_lat, min_lon, max_lat, max_lon]` in 1e-5-degree units |
| `sector_tolerance_m` | int | The simplification tolerance actually used (see 6.2) |
| `vintage` | string | `"2025-01-01"` |

### 4.1 Default UI language for a municipality

PLAN section 5 requires the UI language to default from **the municipality the user is standing in**, not the browser. The rule is fully determined by `rgn` plus one fixed list:

| Condition | `lang.default` | `lang.official` |
|---|---|---|
| `rgn == "02000"` (Flanders, 285 municipalities) | `"nl"` | `["nl"]` |
| `rgn == "04000"` (Brussels, 19) | browser lang if it is `fr` or `nl`, else `"fr"` | `["fr","nl"]` |
| `rgn == "03000"` **and** NIS in the German-speaking Community (9) | `"de"` | `["de"]` |
| `rgn == "03000"` otherwise (252) | `"fr"` | `["fr"]` |

The German-speaking Community is exactly these nine, verified from the shipped data (all in Liège province, all carrying German as the primary name):

```
63001 Amel · 63012 Büllingen · 63013 Bütgenbach · 63023 Eupen · 63040 Kelmis
63048 Lontzen · 63061 Raeren · 63067 Sankt Vith · 63087 Burg-Reuland
```

`official` is an **array** specifically so the 27 language-facility municipalities can be added later without a schema change. They are out of scope for v1.

**When `official.length > 1`, the UI shows both names together** (PLAN section 5). This is why Brussels ships `["fr","nl"]` rather than a single default.

**Worked example, City of Brussels** (real values, shipped minified)

```json
{
  "bbox": [5079668, 431448, 5091141, 443477],
  "cells": ["1kmN3091E3924","1kmN3091E3925","1kmN3091E3926"],
  "counts": {"addresses": 36425, "cells": 60, "sectors": 112, "stops": 1377, "streets": 1091},
  "dstr": "21000",
  "lang": {"default": "fr", "official": ["fr","nl"]},
  "name": {"de": "Brüssel", "fr": "Bruxelles", "nl": "Brussel"},
  "nis": "21004",
  "nuts3": "BE100",
  "prov": null,
  "rgn": "04000",
  "sector_tolerance_m": 8,
  "vintage": "2025-01-01",
  "zips": ["1000","1020","1031","1040","1041","1050","1051","1071","1120","1130"]
}
```

(`cells` is abridged to 3 of 60 above; the shipped file lists all 60.)

Those ten postcodes are the live proof of PLAN's Trap 2, verified against the source file. **`zips` exists to be displayed, never to be joined on.** Postcode 1000 maps only to NIS 21004, so the danger runs strictly the other way: NIS 21004 cannot be recovered from a postcode.

---

## 5. `web/data/<nis>/streets.json`

Street id to trilingual names.

### 5.1 Compaction scheme

Parallel arrays with a delta-encoded id column. Three decisions, each settled by measurement rather than taste:

1. **Parallel arrays, not an array of objects.** Ghent: 136,914 B raw / 24,573 gz as objects, versus 78,928 B raw / 22,905 gz as parallel arrays. The raw file is **42% smaller**, which is what the JSON parser actually walks.

2. **`id` is delta-encoded**, ascending. Street ids are national and sparse (Ghent's start at 69,498, Brussels' at 1), so deltas are small integers.

3. **No "same as `nl`" sentinel.** I tested collapsing `fr == nl` to a sentinel: it saved 15,836 raw bytes on Ghent but only **161 gzipped bytes (0.7%)**, and it destroys the difference between "authored in French, identical to Dutch" and "not authored in French". That difference is exactly what the untranslated flag in section 8 depends on. **Rejected: the clever encoding was measured and it did not pay.**

`""` therefore means one thing only: **not authored in this language.** A language array that is empty for every street is omitted from the file entirely (Ghent ships no `de` key).

Arrays are index-aligned. `n` is the length, so a consumer can validate before use.

**Worked example** (real Brussels rows, abridged to the first 4 of 1,091)

```json
{
  "fr": ["Rue du Persil","Rue aux Laines","Laskouter","Chaussée de Waterloo"],
  "id": [1,2,5,5],
  "n": 1091,
  "nis": "21004",
  "nl": ["Peterseliestraat","Wolstraat","Laskouter","Waterloosesteenweg"],
  "vintage": "2025-01-01"
}
```

`id` decodes by running sum to the real street ids `1, 3, 8, 13`. Street 8 (`Laskouter`) is authored **identically** in NL and FR: both are present, so it is *not* untranslated, and decision 3 above is what preserves that.

**There is no `de` key**, because German is authored on 0 of Brussels' 1,091 streets. Measured coverage across the pilots shows how sharply this cuts:

| City | `nl` | `fr` | `de` | Keys shipped |
|---|---|---|---|---|
| City of Brussels | 1091/1091 | 1091/1091 | 0/1091 | `nl`, `fr` |
| Ghent | 2637/2637 | 0/2637 | 0/2637 | `nl` only |
| Arlon | 0/394 | 394/394 | 0/394 | `fr` only |

Street names are authored in the region's own language, not translated. A consumer must therefore treat a missing key as normal and go through the resolver, never assume all three arrays exist.

Reading it:

```js
const ids = []; let acc = 0;
for (const d of s.id) ids.push(acc += d);
const nameOf = (i, lang) => (s[lang] && s[lang][i]) || "";
```

Ghent's file is **16,342 B gzipped** (2,637 streets). This is not the biggest shard; see section 11.

---

## 6. `web/data/<nis>/sector.geojson`

Simplified sector polygons. A real `FeatureCollection`, valid GeoJSON, so it can be handed to any map component unchanged.

### 6.1 Source and the join that had to be abandoned

Geometry comes from `sh_statbel_statistical_sectors_31370_20250101` (EPSG:31370, easting/northing in metres), reprojected to WGS84 with `scripts/geo31370.py` (verified to 1.8 mm against Statbel's own published coordinates over 2,245 points).

**`CD_SECTOR_2024` from the address file must not be joined to `cd_sector` in this geometry.** The 2024/25 sector reform broke that join. Measured, per pilot, as the share of the city's addresses whose 2024 sector code exists in the 2025 geometry:

| City | Address rows that join by code |
|---|---|
| City of Brussels | 90.59% |
| Ottignies-LLN | 37.34% |
| Ghent | 30.72% |
| Ostend | 26.26% |
| Arlon | 21.09% |
| Andenne | 14.21% |
| **Liège** | **2.58%** |

A join that works for 2.58% of Liège is not a join. **Address to sector is resolved by point-in-polygon against the 2025 geometry at bake time**, and the result is stored in the grid shard (section 7). The runtime never does point-in-polygon, and `CD_SECTOR_2024` never ships.

Because of the same reform, sector counts differ from PLAN section 7. The geometry is authoritative: Ghent 254 (not 199), Liège 217 (not 185), Andenne 91 (not 74), Ostend 88 (not 71), Arlon 71 (not 70), Ottignies-LLN 68 (not 60), Brussels 112 (not 118).

### 6.2 Precision and simplification

- **Coordinate precision: exactly 5 decimal places.** Not 6, not 9.
- **Consecutive duplicate points after rounding are dropped**, then the ring is re-closed. Rounding to 5 dp collapses neighbouring vertices, and leaving them in wastes bytes and can produce zero-length segments.
- **Simplification: `simplify_ring_lonlat(ring, tolerance_m, min_points=4)`** from `scripts/geo31370.py`. Iterative Douglas-Peucker (no recursion limit), longitude scaled by `cos(lat)` so the tolerance means the same in both axes, rings always re-closed, never below 4 vertices so a small sector degrades to a coarse quadrilateral instead of vanishing.

**Tolerance is not a constant. It is the first rung of a fixed ladder that fits the budget:**

```
for tol in [8, 10, 12, 15, 20, 25, 35, 50]:
    blob = serialise(tol)
    if len(blob) <= 150000: break
```

This is deterministic (same input, same rung, same bytes), it guarantees PLAN's "under 150 KB each", and it spends the byte budget where the detail actually is. The rung used is recorded in `<nis>/meta.json.sector_tolerance_m` and in the file's own `properties`, so the map can honestly state its own accuracy.

Measured outcome: **Ghent needs rung 12 m (145,733 B). All six other pilots fit at 8 m.** Ghent at 8 m would be 162,803 B, over budget. At 8 m a Ghent sector keeps 6,414 of 41,194 source vertices (84% dropped) with no visible change at city zoom.

Features are sorted by `properties.s` ascending.

**Worked example** (structure exact, one feature, ring abridged)

```json
{
  "features": [
    {
      "geometry": {
        "coordinates": [[[[4.34331,50.84772],[4.34512,50.84698],[4.34489,50.84601],[4.34331,50.84772]]]],
        "type": "MultiPolygon"
      },
      "properties": {
        "de": "GRAND-PLACE",
        "fr": "GRAND-PLACE",
        "nl": "GROTE MARKT",
        "s": "21004A001"
      },
      "type": "Feature"
    }
  ],
  "properties": {"dp": 5, "nis": "21004", "tolerance_m": 8, "vintage": "2025-01-01"},
  "type": "FeatureCollection"
}
```

`s` is `cd_sector`, always exactly 9 characters, 5-char prefix plus a 4-char suffix padded with `-`. **The 5-char prefix is the *historic* NIS and disagrees with the current municipality on 1,751 of 20,781 features nationally. Never slice `s[:5]` to get a NIS.** Use the folder the file lives in.

All geometries are `MultiPolygon`, including single-part sectors, matching the source. Consumers need one code path.

---

## 7. `web/data/grid/<GRD_NEWID>.json`

**The hot path.** Nine of these are read on every position fix, so this is the one schema where size and parse cost outrank readability.

### 7.1 The cell

`GRD_NEWID` is the INSPIRE 1 km cell in EPSG:3035, confirmed against all 4,490,779 rows:

```
"1kmN" + floor(northing_m / 1000) + "E" + floor(easting_m / 1000)
```

`scripts/grid.py` and `web/app/grid.js` compute it identically (249,487 rows sampled nationally, 100.0000000% agreement). The bake reads the column verbatim; the function is used only on the live device position.

`neighbours(cell)` returns 9 ids, **self first**, then the ring in reading order. Fetch all 9, but see 7.5.

### 7.2 Schema

Top level:

| Key | Type | Meaning |
|---|---|---|
| `c` | string | The cell id, so a detached shard is self-identifying |
| `v` | string | Vintage, `"2025-01-01"` |
| `o` | int[2] | Shard origin `[lat, lon]` in 1e-5-degree units. See 7.3 |
| `m` | string[] | NIS codes present, ascending |
| `a` | object | Addresses. Omitted entirely if none |
| `t` | object[] | Transit stops. Omitted entirely if none |
| `p` | object[] | Baked POI. Omitted entirely if none |
| `fm` | object | Foreign municipalities knowingly omitted. See 7.4 |

**A key is absent rather than empty.** `"t": []` never ships. This is what makes "never render an empty panel" mechanical: the UI branches on key presence and writes copy that names the missing layer.

`a` (addresses), all arrays index-aligned and `n` long:

| Key | Type | Meaning |
|---|---|---|
| `n` | int | Address count |
| `st` | int[] | Street id, **delta-encoded**. Join to `<nis>/streets.json` |
| `h` | (int\|string)[] | House number. Integer when purely numeric without a leading zero, else string (`"2B"`, `"12A"`) |
| `y`, `x` | int[] | Latitude/longitude offsets from `o`, **delta-encoded**, units of 1e-5 degrees |
| `sc` | string[] | Sector code table for this shard, ascending. **2025 codes, from bake-time point-in-polygon** |
| `s` | int[] | Index into `sc`, delta-encoded |
| `zt` | string[] | Postcode table, ascending |
| `z` | int[] | Index into `zt`, delta-encoded |
| `mi` | int[] | Index into `m`, delta-encoded. **Omitted when `m` has one entry** |

Rows are sorted by `(street_id, len(house_number), house_number)`. That ordering is what makes the delta columns compress: `st` becomes long runs of `0`, and consecutive addresses on a street are spatially adjacent so `y`/`x` deltas stay tiny.

`t` (stops), array of objects because counts are small (across the 674 pilot cells: median **4**, max **78**, and **166 cells have none at all**, so the key is absent there):

| Key | Meaning |
|---|---|
| `o` | Operator: `delijn`, `tec`, `stibmivb`, `nmbssncb` |
| `i` | `stop_id` verbatim, the key for GTFS realtime |
| `n` | `stop_name` verbatim, in the operator's authored language |
| `t` | Optional. Authored translations, `{"fr":…,"nl":…,"de":…}`. Omitted when the feed has none |
| `ps` | Optional. `parent_station`. **For NMBS this is the iRail station key.** Omitted when absent |
| `y`, `x` | Offsets from `o`, **absolute, not delta-encoded** |

### 7.3 The origin rule

```
o = [ floor(min_lat_over_all_features * 100) * 1000,
      floor(min_lon_over_all_features * 100) * 1000 ]   # 1e-5-degree units
```

Three properties, all deliberate:

1. **The minimum spans addresses, stops and POI**, not just addresses. My first draft used the address bounding box and produced negative stop offsets (`"x": -666`) because stops sit outside it.
2. **Floored to 2 decimal places (~1.1 km).** A 1 km cell almost always sits in one 0.01-degree bucket, so adding or removing an address does not move the origin and therefore does not rewrite every offset in the shard. Scheduled rebuilds give clean diffs, which is the whole point of idempotency.
3. **Integers only.** No float appears anywhere in a grid shard.

Measured cost of the floored origin versus a content-tight one: **669 bytes smaller** across the original seven cities. It is free.

Decoding:

```js
let ay = 0, ax = 0, as = 0;
const lat = [], lon = [], sec = [];
for (let i = 0; i < a.n; i++) {
  ay += a.y[i]; ax += a.x[i]; as += a.s[i];
  lat.push((o[0] + ay) / 1e5);
  lon.push((o[1] + ax) / 1e5);
  sec.push(a.sc[as]);
}
```

### 7.4 Cells that straddle an unshipped municipality

The 674 pilot cells also contain **95,500 addresses belonging to other municipalities** that this release does not ship. Baking them would add roughly 32% to the grid payload and break the byte budget.

**They are not baked. They are counted.** Each shard carries:

```json
"fm": {"21015": 1204, "21009": 87}
```

so the UI can say, precisely and by name (via `municipalities.json`), *"1,204 addresses in this square are in Schaerbeek, which is not in this release."* That is the honest version of a thin panel, and it is auditable. `fm` is omitted when the cell is wholly inside shipped territory.

### 7.5 Parse cost, measured

| | Value |
|---|---|
| Median shard, raw | **4,047 B** |
| Largest single shard, raw | **89,301 B** (central Ghent) |
| Worst 9-cell read, raw | **643,894 B** (629 KB, centred on `1kmN3122E3881`) |
| Worst 9-cell read, gzipped | **110,411 B** (108 KB) |

(Measured on the address block. Stops add under 2%: 4,804 stops across all 674 pilot cells.)

629 KB of JSON in the worst case is chunky, so the fetch order is part of the contract:

**Render from the centre cell first, then correct.** The centre shard alone (at most 89 KB) answers "where am I". The 8 neighbours are fetched in parallel and only change the answer within ~50 m of a cell edge. First paint must never block on all nine.

### 7.6 Worked example, verbatim

Real cell `1kmN3056E3964` (Andenne, 6 addresses, 2 TEC stops). Source rows, verbatim from the Statbel file (middle coordinate columns elided for width, everything else exact):

```
92003|Andenne|Andenne|Andenne|5300|7751600||Rue de Ville-en-Waret||225|0|92003H290|…|4.9725619355|50.507405459|1kmN3056E3964
92003|Andenne|Andenne|Andenne|5300|7751600||Rue de Ville-en-Waret||226|1|92003H20-|…|4.9744946666|50.50729654|1kmN3056E3964
92003|Andenne|Andenne|Andenne|5300|7751600||Rue de Ville-en-Waret||228|1|92003H20-|…|4.9765023101|50.507505012|1kmN3056E3964
92003|Andenne|Andenne|Andenne|5300|7751600||Rue de Ville-en-Waret||229|0|92003H20-|…|4.9765420116|50.507790351|1kmN3056E3964
92003|Andenne|Andenne|Andenne|5300|7751600||Rue de Ville-en-Waret||230|1|92003H20-|…|4.9769203393|50.507799378|1kmN3056E3964
92003|Andenne|Andenne|Andenne|5300|7751600||Rue de Ville-en-Waret||225A|0|92003H290|…|4.9727052772|50.50764557|1kmN3056E3964
```

Shipped shard, **exactly as written to disk** (one line plus LF):

```json
{"a":{"h":[225,226,228,229,230,"225A"],"n":6,"s":[1,-1,0,0,0,1],"sc":["92003H20-","92003H290"],"st":[7751600,0,0,0,0,0],"x":[1256,193,201,4,38,-421],"y":[741,-11,21,28,1,-15],"z":[0,0,0,0,0,0],"zt":["5300"]},"c":"1kmN3056E3964","m":["92003"],"o":[5050000,496000],"t":[{"i":"gs:tec:N509aka","n":"GELBRESSEE Blanches barrières","o":"tec","ps":"tec:s-gelbresseeblanchesbarrires","x":877,"y":815},{"i":"gs:tec:N509akb","n":"GELBRESSEE Blanches barrières","o":"tec","ps":"tec:s-gelbresseeblanchesbarrires","x":844,"y":823}],"v":"2025-01-01"}
```

Reading it back, every claim checkable against the rows above:

- **Address 0**: lat `(5050000 + 741) / 1e5 = 50.50741` (source `50.507405459`), lon `(496000 + 1256) / 1e5 = 4.97256` (source `4.9725619355`). Rounded to 5 dp, as contracted.
- **`st` is `[7751600,0,0,0,0,0]`**: one street, six addresses. This is exactly what the sort order buys, and it is why the delta columns compress.
- **`h` mixes types on purpose**: five integers and the string `"225A"`. House numbers are not numbers.
- **`s` is `[1,-1,0,0,0,1]`**, a delta over the `sc` index: sector `92003H290`, then `92003H20-` for four addresses, then back to `92003H290`. **A 1 km cell routinely spans several sectors**, which is why the sector is per address and not per shard.
- **`ps`** points both TEC platforms at one parent station, so the UI groups them into a single boarding point.

`mi` and `fm` are both absent: this cell is wholly inside Andenne and Andenne is shipped.

### 7.7 GTFS extraction rules

Three traps, all hit in practice:

1. **Column order differs between operators.** NMBS ships `stops.txt` with alphabetically ordered columns, STIB with the conventional order. **Parse by header name, never by position.**
2. **`stops.txt` is UTF-8 with a BOM.** Decode as `utf-8-sig`.
3. **Only `location_type=0` is kept.** Every `location_type=1` station in all four feeds has children (measured: 0 childless stations across 82,126 records), so keeping stations as well would duplicate 16,420 stops with no new information. The station is not lost: it is carried on each child as `ps`.

| Operator | Raw `stops.txt` | Kept (`location_type=0`) | Dropped as parent stations |
|---|---|---|---|
| TEC | 46,674 | **30,978** | 15,696 |
| De Lijn | 30,081 | **30,081** | 0 |
| STIB-MIVB | 2,514 | **2,444** | 70 |
| NMBS-SNCB | 2,857 | **2,203** | 654 |

**`translations.txt` exists and carries authored NL/FR/DE stop names.** This contradicts PLAN section 5, which claims GTFS `stop_name` is "a single string, in the operator's own language". Measured:

| Operator | Names with authored translations |
|---|---|
| STIB-MIVB | 1,088 |
| NMBS-SNCB | 654 |
| TEC | 0 |
| De Lijn | 0 |

Both feeds that have them key translations by `field_value` (the string itself), not by `record_id`. These are **authored** translations from the operator, so using them does not breach the no-machine-translation rule. They populate `t[].t` and feed step 1 of the resolver.

---

## 8. `web/data/i18n/en.json`

The curated English override. **Hand-written and human-reviewed. Never machine-generated, never machine-translated.**

### 8.1 Budget

| Group | Count |
|---|---|
| Municipality names (all 565) | 565 |
| Category labels | ~40 |
| App chrome | ~45 |
| **Total** | **~650**, under PLAN's 700 |

### 8.2 The `"="` assertion

Most of the 565 municipalities have no English exonym: "Andenne" is already the English name. Only about 25 differ (Ghent, Bruges, Antwerp, Brussels, Liege, Ostend, Ypres, Louvain, Malines, Namur, Mons, Tournai and a few more).

Leaving the other 540 out would make the resolver flag "Andenne" as untranslated, which is false and would sprinkle warning markers over correct names. So the file distinguishes three states:

| Value | Meaning | Flagged untranslated? |
|---|---|---|
| key absent | **Not reviewed** | **Yes** |
| `"="` | Reviewed. English is identical to the authored name | No |
| `"Ghent"` | Reviewed. A real English exonym | No |

`"="` costs about 14 bytes each, roughly 1.5 KB gzipped for all 540. It buys an honest untranslated flag, which acceptance test 4 depends on.

### 8.3 Schema and worked example

```json
{
  "cat": {
    "charging": "EV charging",
    "heritage": "Heritage",
    "market": "Market",
    "playground": "Playground",
    "recycling": "Recycling"
  },
  "meta": {"n": 650, "reviewed": "2026-08-15", "vintage": "2025-01-01"},
  "munty": {
    "21004": "City of Brussels",
    "25121": "=",
    "35013": "Ostend",
    "44021": "Ghent",
    "62063": "Liege",
    "81001": "=",
    "92003": "="
  },
  "ui": {
    "band.around": "Around",
    "band.go": "Go",
    "band.here": "Here",
    "band.now": "Now",
    "empty.market": "No market data published for this municipality.",
    "flag.endonym": "Street and place names are shown in their official local language.",
    "flag.untranslated": "Not available in English"
  }
}
```

Note `81001` is `"="`: the municipality's French name is Arlon and English uses Arlon, even though the Dutch is Aarlen. The `"="` means "identical to the resolved authored name", and which authored name that is comes from the region default (section 4.1).

**There is no `nl.json` or `fr.json` for data labels.** NL and FR are authored at source. Only app chrome needs NL/FR files, and those are UI strings, not data.

---

## 9. The label resolver

One function, used for **every** user-visible label. This is PLAN section 5's four-step fallback, made exact.

### 9.1 Signature

```js
/**
 * @param {Object}  entity              The thing being labelled.
 * @param {Object}  entity.name         Authored names: {nl?, fr?, de?, en?}. "" and
 *                                      undefined both mean "not authored".
 * @param {string} [entity.id]          Key into the curated override, when the kind has one.
 * @param {string}  kind                "munty" | "street" | "sector" | "stop" | "poi" | "ui" | "cat"
 * @param {"nl"|"fr"|"en"} uiLang       The active UI language.
 * @param {Object}  ctx
 * @param {Object}  ctx.override        Parsed web/data/i18n/en.json.
 * @param {"nl"|"fr"|"de"} ctx.regionDefault   From <nis>/meta.json lang.default.
 *
 * @returns {{text: string, lang: string, translated: boolean, step: 1|2|3|4}}
 */
function resolveLabel(entity, kind, uiLang, ctx)
```

**It never returns a blank `text`.** That is acceptance test 4.

### 9.2 The four steps

```
1. entity.name[uiLang]  is a non-empty string
      -> { text: it, lang: uiLang, translated: true, step: 1 }

2. ctx.override[kind][entity.id][uiLang]  exists            (in practice uiLang === "en")
      -> value "="  : resolve step 3/4 for the text, but report translated: true
      -> otherwise  : { text: value, lang: uiLang, translated: true, step: 2 }

3. entity.name[ctx.regionDefault]  is a non-empty string
      -> { text: it, lang: regionDefault, translated: false, step: 3 }

4. first non-empty of entity.name in the fixed order  nl, fr, de, en
      -> { text: it, lang: thatLang, translated: false, step: 4 }

   If all are empty: the baker must never have emitted this record. At runtime,
   return { text: "[" + (entity.id ?? "?") + "]", lang: "?", translated: false, step: 4 }
   and count it. CI fails the bake if any shipped record has no name in any language.
```

The fixed order in step 4 is what makes the resolver deterministic. `nl, fr, de, en` is not arbitrary: it matches source coverage (NL missing on 32.92% of streets, FR on 61.70%, DE on 99.24%), so it reaches a real string soonest.

**Step 1 before step 2 means the curated override can never shadow an authored name.** The override only ever fills a genuine hole.

**Step 4 always succeeds for streets:** zero rows in the 4,490,779-row source lack a name in all three languages.

### 9.3 How the UI marks an untranslated string

`translated: false` is the signal, but rendering a marker on every string is not the same as being honest. The rule is per `kind`:

| Kind | Policy on `translated: false` |
|---|---|
| `munty`, `cat`, `ui` | **Inline marker.** These should have been curated, so a fallback is a real gap. Marker: superscript, `title` = `ui["flag.untranslated"]` |
| `street`, `stop`, `poi`, `sector` | **No inline marker.** Show a single note per panel: `ui["flag.endonym"]`, "Street and place names are shown in their official local language." |

This is deliberate. In English, *every* Ghent street name falls to step 3, and 2,637 inline markers would be noise rather than information. The endonym note says the true thing once. Untranslated street names are policy (PLAN section 1: "a translated street name is a wrong street name"), not a defect, and the UI should not cry wolf about its own policy. Both paths still carry `translated: false` in the data, so acceptance test 4 is testable either way.

**Chrome strings (`kind: "ui"`) are marked too, and they are marked as text.** Entity labels are rendered as DOM nodes, so they carry `<sup class="untranslated">`. A chrome string is consumed as a plain string by five band modules with five different renderers, so the marker is the same asterisk appended to the text: `i18n.js` exports `UNTRANSLATED_MARK = " *"` and `markUntranslated()`, and `createI18n().tBand()` / `.tChrome()` apply it whenever the resolver returns step 3 or 4.

There are two distinct fallbacks here and both must be marked:

| Situation | Who marks it |
|---|---|
| The key exists, but not in the active language | `i18n.tBand` / `i18n.tChrome`, from `translated: false` |
| The key exists in **no** i18n file, so the band renders its own hardcoded English (`HERE_UI_DEFAULTS`, `COPY`, `ZOOM_UI_DEFAULTS`, the `t(key, fallback)` second argument) | the band module itself, which appends the same `UNTRANSLATED_MARK` when its active language is not `en` |

The second row is why gate 10 exists: without it, an English sentence rendered inside a Dutch interface is indistinguishable from a Dutch one, which fails acceptance test 4's second clause silently.

### 9.4 Worked traces

| Entity | uiLang | Result |
|---|---|---|
| Municipality 44021, `{nl:"Gent",fr:"Gand",de:"Gent"}` | `nl` | step 1, `"Gent"`, translated |
| Municipality 44021 | `en` | step 2, override `"Ghent"`, translated |
| Municipality 92003, `{nl:"Andenne",fr:"Andenne",de:"Andenne"}` | `en` | step 2 sees `"="`, text from step 3 = `"Andenne"`, **translated: true** |
| Street 8 Brussels, `{nl:"Laskouter",fr:"Laskouter"}` | `fr` | step 1, `"Laskouter"`, translated (authored, not a fallback) |
| Street 7751444 Andenne, `{nl:"",fr:"Ferme Bialy"}` | `nl` | step 3, regionDefault `fr` = `"Ferme Bialy"`, not translated, endonym note |
| Street 69498 Ghent, `{nl:"Aaigemstraat"}` | `en` | step 3, regionDefault `nl`, not translated, endonym note |
| STIB stop `0089`, `n:"MONTGOMERY"`, `t:{fr:"Montgomery"}` | `fr` | step 1 on `t`, `"Montgomery"`, translated |

---

## 10. Runtime fetch contract

Every source PLAN section 3.1 calls live. **All eight `fetch()` sources were re-verified on 15 August 2026** by sending `Origin: https://example.github.io` and reading `access-control-allow-origin`. Section 10.8 adds a ninth runtime source, the OSM basemap, which is fetched as an `<img>` and so has no CORS story to verify at all.

### 10.0 Rules that bind all of them

- **No key, no token, no credential, ever.** Acceptance test 7 greps the build to prove it.
- **Debounce geolocation.** No polling loops (acceptance test 9).
- Every response is cached in the SW with the TTL below. On expiry, serve stale immediately and revalidate.
- **Every failure shows the layer's source and the age of what is displayed**, never a spinner and never a blank card.
- The CSP `<meta>` tag lists exactly these hosts and nothing else (Pages cannot send headers). **Updated 15 August 2026** for the basemap:

```
default-src 'self';
connect-src 'self'
  https://api-management-discovery-production.azure-api.net
  https://api.irail.be
  https://opendata-api.statbel.fgov.be
  https://geoservices.wallonie.be
  https://geo.onroerenderfgoed.be
  https://www.odwb.be https://data.stad.gent https://opendata.brussels.be
  https://catalog.datastore.brussels;
img-src 'self' https://tile.openstreetmap.org;
style-src 'self' 'unsafe-inline'; script-src 'self';
base-uri 'none'; object-src 'none'; form-action 'none'
```

Three things about that policy are load-bearing rather than cosmetic:

1. **The tile host is in `img-src` and in no other directive.** The basemap is `<img>` elements, not `fetch()`, so CORS never applies to it and it must not be in `connect-src`. Putting it there would be both useless and a false statement about what the app calls.
2. **`data:` was dropped from `img-src`.** Nothing in the app uses a data URI image any more; icons are inline SVG path data from `icons.js`. Narrowing a directive that nothing needs is free.
3. **There is no `font-src` and no `style-src` exception**, because the fonts are same-origin under `web/fonts/`. The Organic design system's own stylesheet opens with an `@import` from `fonts.googleapis.com`; that line is deliberately absent from `tokens.css`, which is what lets `default-src 'self'` stand unqualified.

### 10.1 iRail, live train departures

| | |
|---|---|
| URL | `https://api.irail.be/v1/liveboard/?station={stop_id}&format=json&lang={nl\|fr\|en\|de}` |
| Stations | `https://api.irail.be/v1/stations/?format=json&lang={lang}` (714 stations, baked, not runtime) |
| Headers | **`User-Agent: BeHERE/1.0 (https://<user>.github.io/behere/; <contact>)` is required.** Descriptive, with a contact |
| CORS | Echoes the request origin. `access-control-allow-methods: GET, OPTIONS`, `access-control-max-age: 86400` |
| Rate limit | **3 requests per second, hard.** No rate-limit headers are exposed, so the client enforces it: a single global queue, minimum 334 ms between requests, maximum 3 in flight |
| Cache TTL | **30 s** for a liveboard. `cache-control: private` is returned, so the SW must cache deliberately rather than rely on the header |
| Language | `lang` is a real parameter. **iRail is the one runtime source with authored English**, so station names come from here, not from the override |
| On failure | Show the **baked** timetable for the stop with an explicit "as of" timestamp: *"Live departures unavailable. Showing the timetable, last updated {date}."* Never an empty Go band |

### 10.2 NAP GTFS realtime

| | |
|---|---|
| URL | `https://api-management-discovery-production.azure-api.net/api/gtfs/feed/{delijn\|tec\|stibmivb\|nmbssncb}/rt/{trip-update\|alert\|vehicle-position}` |
| CORS | `access-control-allow-origin: *`. Verified |
| Headers | None. No key, no registration |
| Rate limit | None published. Self-impose **1 request per feed per 30 s** and never poll in the background |
| Cache TTL | **30 s** |
| Payload | GTFS-RT protobuf. **No CDN is allowed, so a minimal protobuf decoder must be vendored into `web/app/` as a static file.** Only `trip_update.stop_time_update` (delays) and `alert` are decoded; nothing else is needed |
| Coverage | TEC is the only operator publishing `vehicle-position` |
| On failure | Show scheduled times with no delay badge, plus *"Realtime unavailable, times are scheduled."* |

> **`/static` is bake-time only and must never be called at runtime.** It is 287 MB across the four operators. PLAN section 3.1 lists it as a runtime source; that is wrong and section 12 records the correction.
>
> **Two traps, both re-verified today.** `HEAD` on a `/static` URL returns **404** while `GET` returns **200**, so never health-check with HEAD. And `Range:` is **ignored**: a request for bytes 0-102399 of the De Lijn feed returned the full **175,832,410 bytes**. There is no partial fetch.

### 10.3 Statbel HVD statistics, the "Zoom out" band

| | |
|---|---|
| URL | `https://opendata-api.statbel.fgov.be/{table}?{COLUMN}=eq.{value}&limit=…` |
| CORS | Echoes the request origin. Verified |
| Headers | Exact counts via `Prefer: count=exact` and `Range: 0-0`, then read `content-range` |
| Rate limit | None published. Cache hard, this data changes yearly |
| Cache TTL | **24 h**, and it is a legitimate offline-stale layer |
| On failure | Show the last fetched values with their date: *"Statistics as of {date}."* |

Three things that will cost an hour if missed:

1. **Column names are UPPERCASE.** `cd_refnis=eq.44021` returns HTTP 400. It is `CD_REFNIS`.
2. **The schema differs per table.** `tf_hvd_demo_fertility` and `tf_hvd_demo_mortality` have `CD_REFNIS` and `CD_NUTS_LEVEL`; `tf_hvd_demo_population` has neither and uses `CD_NUTS_LVL3`. Discover columns with `/rpc/get_tables_columns`, never assume.
3. **No table reaches municipality level.** `CD_NUTS_LEVEL` maxes out at **3**, which is the arrondissement, and `CD_REFNIS` there is an integer like `1000` (Belgium) or `2000` (Flemish Region), not a municipality NIS.

**Therefore the Zoom out band keys on `nuts3` from `<nis>/meta.json`, never on the municipality NIS.** Verified working:

```
GET https://opendata-api.statbel.fgov.be/tf_hvd_demo_population?CD_NUTS_LVL3=eq.BE234
-> 206, content-range: 0-0/495
```

These tables also carry `TX_*_DESCR_EN`, so this band is genuinely available in English without the override.

### 10.4 Opendatasoft city datasets

| | |
|---|---|
| URL | `https://{host}/api/explore/v2.1/catalog/datasets/{dataset}/records?where=…&limit=…` |
| Hosts | `data.stad.gent`, `www.odwb.be`, `opendata.brussels.be` |
| CORS | `access-control-allow-origin: *`. Verified on all three |
| Rate limit | **Per portal, and they are not equal.** Measured today: `data.stad.gent` **250,000/day**, `opendata.brussels.be` **100,000/day**, `www.odwb.be` **20,000/day**. Resets at `00:00:00+00:00` |
| Enforcement | **Read `x-ratelimit-limit` and `x-ratelimit-remaining` from the response and adapt. Never hardcode a number.** Both are listed in `access-control-expose-headers`, so the browser can read them |
| Cache TTL | **1 h**, stale-while-revalidate |
| On failure | Collapse the panel with the specific copy, for example *"No local dataset published for this municipality."* Ottignies-LLN has zero local datasets by design, and that must read as honest, not broken |

PLAN quotes a flat 20,000/day. That is only correct for ODWB.

### 10.5 Walloon tourism, ArcGIS REST

| | |
|---|---|
| URL | `https://geoservices.wallonie.be/arcgis/rest/services/TOURISME/OFFRES_TOURISTIQUES/MapServer/{layer}/query?where=…&outFields=*&f=geojson&resultRecordCount=2000` |
| CORS | Echoes the request origin. Verified |
| Limits | 13 layers, `maxRecordCount` **2000**. Page with `resultOffset` |
| Cache TTL | **6 h** |
| Language | **FR only.** Do not translate. Names resolve at step 3/4 with the endonym note |
| On failure | Fall back to the baked GeoPackage subset, labelled with its bake date |

### 10.6 Flemish heritage, point in polygon

| | |
|---|---|
| URL | `https://geo.onroerenderfgoed.be/zoekdiensten/afbakeningen?geometrie={GeoJSON point}&crs=EPSG:4326` |
| CORS | `access-control-allow-origin: *`. Verified |
| Cache TTL | **6 h**, keyed on the **cell id**, not the raw coordinate, so panning inside a square is one request |
| Language | **NL only** |
| On failure | Collapse with *"Heritage data unavailable."* Wallonia has no equivalent, so the panel is absent there by design, not by error |

### 10.7 Brussels regional catalogue

| | |
|---|---|
| URL | `https://catalog.datastore.brussels/geonetwork/srv/eng/q?_content_type=json` |
| CORS | `access-control-allow-origin: *`. Verified |
| Trap | **`/api/search` returns 403.** Use the `geonetwork/srv/eng/q` path |
| Cache TTL | **24 h** |
| On failure | Collapse. Licence terms here are unverified (PLAN section 11), so treat as discovery only until cleared |

### 10.8 OpenStreetMap raster basemap

**Added 15 August 2026 with the map-first revamp.** It is the odd one out in this
section and the differences are the point: it is not `fetch()`, it has no CORS
story, it has no TTL negotiated with a publisher, and its terms are licence
conditions rather than engineering preferences.

| | |
|---|---|
| URL | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` |
| Transport | **`<img>`, not `fetch()`.** Therefore `img-src`, never `connect-src`, and CORS is not involved |
| Credential | None, and none possible: no query string, no header, no cookie |
| Licence | **ODbL 1.0.** `© OpenStreetMap contributors`, linking to `https://www.openstreetmap.org/copyright`, drawn on the map on any frame where a tile has been painted, and reachable by keyboard |
| Cache | Its own `behere-tiles-v1`, **never** `precache.json` and never the shell precache |
| Cache TTL | **7 days**, long on purpose: a Belgian street changes on the order of months and every re-request is traffic on a volunteer-funded CDN |
| Cap | **300 entries**, evicted least-recently-**used**, not oldest-stored |
| Rate discipline | Only tiles intersecting the current viewport, one zoom level at a time. **No prefetch, no adjacent-tile lookahead, no background refresh, no scraping loop** |
| On failure | Three consecutive errors switch the layer to `failed`; the baked vector layers keep drawing and the app keeps answering. Already-loaded tiles are **kept** and stay attributed |
| Offline | Absent. No request is made and none is queued. Acceptance test 1 never touched tiles |

**Two timestamps per tile, and collapsing them into one is a bug that hides for
weeks.** The index stores `{tileUrl: [fetchedAtMs, lastUsedMs]}`. The TTL asks
"how old is this picture"; the LRU asks "when did anyone last want it". A cache
hit moves `[1]` only; a network store rewrites both. If a hit refreshed
`fetchedAt`, a tile on the user's own street would be looked at daily, stay
"fresh" for ever and never revalidate, so the tiles that rot would be exactly
the ones the user cares most about.

The index lives at a synthetic same-origin key **inside** the tile cache, so
purging the basemap purges its bookkeeping in one call. It is never counted
against the 300 and never served as an asset: the fetch handler 404s it
explicitly.

---

## 11. Byte budget

Measured end to end: real extraction of all 303,800 pilot addresses, real 2025 sector geometry through the real simplifier, real stops from all four GTFS feeds, serialised exactly per section 1, gzipped at level 9.

**Per city, gzipped bytes:**

| City | NIS | Addr | Streets | Sectors | Cells | Stops | meta | streets | sector | **grid** | **TOTAL** | PLAN §8 | vs PLAN |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Ghent | 44021 | 137,119 | 2,637 | 254 | 188 | 1,152 | 730 | 16,342 | 30,333 | **497,945** | **545,350** | 893 KB | **-39%** |
| Liège | 62063 | 68,895 | 1,712 | 217 | 95 | 1,219 | 524 | 11,056 | 28,821 | **296,167** | **336,568** | 551 KB | -40% |
| City of Brussels | 21004 | 36,425 | 1,091 | 112 | 60 | 1,377 | 445 | 14,451 | 13,635 | **171,280** | **199,811** | 297 KB | -34% |
| Ostend | 35013 | 23,986 | 697 | 88 | 52 | 233 | 390 | 4,490 | 9,867 | **103,849** | **118,596** | 195 KB | -41% |
| Arlon | 81001 | 11,053 | 394 | 71 | 96 | 265 | 496 | 2,876 | 19,343 | **72,210** | **94,925** | 95 KB | -2% |
| Andenne | 92003 | 9,825 | 395 | 91 | 98 | 259 | 490 | 2,804 | 18,424 | **69,880** | **91,598** | 86 KB | **+4%** |
| Ottignies-LLN | 25121 | 10,079 | 584 | 68 | 42 | 166 | 397 | 4,453 | 10,115 | **52,401** | **67,366** | 88 KB | -25% |
| Court-Saint-Etienne | 25023 | 3,770 | 162 | 25 | 34 | 94 | 359 | 1,387 | 6,439 | **26,726** | **34,911** | n/a | new |
| Mont-Saint-Guibert | 25068 | 2,648 | 120 | 21 | 22 | 92 | 333 | 1,035 | 4,619 | **18,385** | **24,372** | n/a | new |
| **Nine cities** | | **303,800** | **7,792** | **947** | **674** | **4,857** | | | | | **1,513,497** | | |
| shared (`municipalities` + `nis_history` + i18n + `meta` + `precache`) | | | | | | | | | | | 39,536 | | |
| **GRAND TOTAL** | | | | | | | | | | | **1,553,038 B = 1.48 MB** | | |

**Re-measured 15 August 2026 after the map-first revamp: 1,550,736 → 1,553,038 B, up 2,302, all of it in the shared row.** The revamp baked nothing: the entire delta is chrome copy hand-added to `i18n/{en,nl,fr}.json` (en +708, nl +782, fr +812) for the dock, the map controls, the tile note and the three distinct silences. Those three files are the only data files the revamp touched, `bake.py` does not generate them, and gates 1 and 9 both passed on the deploy run (`diff -r` against a second `--offline` bake printed `byte-identical`), so this figure will not move again until someone edits them or the pilot set changes.

Court-Saint-Etienne and Mont-Saint-Guibert were added on 15 August 2026 and cost **56,354 gzipped bytes** between them, 1.8% of the ceiling. Ottignies-LLN's grid figure *fell* from 55,398 to 52,401 despite nothing about it changing: its two new neighbours share 1 km cells with it, and a shared shard's bytes are apportioned across every city that claims it. The city totals are therefore an attribution, not a partition; only the GRAND TOTAL is a measured fact about the shipped tree.

**Against acceptance test 10 (the pilot set under 3 MB gzipped): 1,553,038 B for nine cities, 49.4% of the 3,145,728 B ceiling. Passing with 50.6% headroom.**

### 11.1 Where the saving came from

PLAN section 8's figures were measured on an array-of-verbose-objects layout. I reproduced that layout first to check calibration, and it matched PLAN almost exactly (Ghent 924,188 B against PLAN's 893 KB, Brussels 296,388 against 297 KB). So the baseline is real and the comparison is fair.

| Step | Ghent grid, gzipped |
|---|---|
| Array of objects (the PLAN baseline) | 924,188 |
| Parallel arrays, integer offsets | 572,678 (-38%) |
| **+ delta encoding (adopted)** | **495,637 (-46% total)** |
| + run-length constant columns | 452,222 (a further 0.8%) |

**The last step was rejected.** Collapsing a constant column to a scalar makes a field sometimes-array/sometimes-scalar, and 0.8% does not buy that ambiguity in the hot path.

### 11.2 Andenne is 4% over PLAN, and that is correct

Andenne is the one city above its PLAN figure. PLAN's number counted address data only; this schema also ships **91 sector polygons costing 18,424 gzipped bytes**, and Andenne is a large rural municipality with many sparse sectors. Its grid payload alone is 69,674 B, comfortably under PLAN's 86 KB. Arlon (71 rural sectors, 19,343 B) is the same story. Nothing is wrong; the two figures count different things.

### 11.3 Headroom

At 1.48 MB against a 3 MB ceiling, there is room for the baked POI layer (`p` in the grid shards), which is not yet measured because the Flemish tourism CSV and Walloon GeoPackage are Phase 2 work. Ostend alone has 2,962 tourism records. At the density observed for stops, the full national POI set for the nine pilots should land near 150 to 300 KB gzipped, leaving roughly 1.2 MB spare.

**National bundle: still do not ship it.** At the measured 4.885 gzipped bytes per address, all 4,490,779 addresses extrapolate to **20.9 MB**, plus **2.9 MB** for all 20,781 sectors, so roughly **24 MB gzipped** (PLAN estimated 33 MB on the verbose layout). Better, but still far past what belongs in Git history.

---

## 12. Corrections to PLAN.md

Everything below is measured. PLAN should be read through this list.

| # | PLAN says | Verified truth | Consequence |
|---|---|---|---|
| 1 | §3.2: address file is 926.4 MB uncompressed | **865,015,284 B** | Cosmetic |
| 2 | §4: join `CD_SECTOR_2024` to sector geometry | The 2024/25 reform broke it. **Liège joins on 2.58% of addresses** | **Structural.** Address to sector is bake-time point-in-polygon (§6.1) |
| 3 | §7: per-city sector counts | Stale for all seven originals. Ghent is **254**, not 199 | Counts corrected in `<nis>/meta.json` |
| 4 | §4: `CD_STR` "joins to BeSt `street_id` for trilingual street names" | **Street names are already in the address file** (`TX_STR_NM_NL/FR/DE`) | The BeSt join is not needed for names. 232 MB of downloads avoided |
| 5 | §3.1: GTFS `/static` is a runtime source | 287 MB. Cannot be a runtime source | Bake-time only (§10.2) |
| 6 | §5: GTFS `stop_name` is "a single string, in the operator's own language" | **`translations.txt` carries authored NL/FR/DE.** STIB 1,088 names, NMBS 654 | Feeds resolver step 1 (§7.7) |
| 7 | §5: "English exists nowhere except iRail" | Statbel HVD tables carry `TX_*_DESCR_EN` | Zoom out is natively English (§10.3) |
| 8 | §3.1: Opendatasoft is 20,000/day | Per portal: **250,000 / 100,000 / 20,000** | Read `x-ratelimit-limit`, never hardcode (§10.4) |
| 9 | §3.1: Statbel HVD gives "statistics per municipality" | Stops at **NUTS3 (arrondissement)**. Columns are UPPERCASE and differ per table | Zoom out keys on `nuts3` (§10.3) |
| 10 | §3.2 / §6: sector geometry `…_20260101` | The 2026 file is not the pinned vintage | Pinned to `…_20250101`, matching the non-negotiables |
| 11 | §8: Ghent 893 KB gzipped | **542,924 B** under this schema | 41% under budget (§11) |
| 12 | (unstated) | 674 pilot cells also hold **95,500 addresses from unshipped municipalities** | Counted in `fm`, not baked (§7.4) |
| 13 | §6: "Four bands stacked on one screen. No tabs, no dashboard." | **A reversal, not a measurement.** The app is map-first: a full-bleed map is the page, five bands in a dock of pills, one expandable over it | PLAN §6 rewritten and dated 15 August 2026. The objection to a *dashboard* still stands and is still honoured; what changed is that a stacked column answered a spatial question in words while showing nothing of the ground |
| 14 | §3.1 listed eight runtime sources, all `fetch()` | A ninth runtime source exists, the OSM basemap, and it is an `<img>` | New §10.8. It is in `img-src`, never `connect-src`, and it is the only source with licence conditions attached to *how it is displayed* |

Two more worth carrying forward, from the ground-truth passes rather than from PLAN:

- **`CD_SECTOR_2024` is empty on 65 of 4,490,779 rows.** The bake must not assume every address has a sector. Those addresses ship with their `s` index pointing at a sentinel `""` entry in `sc`.
- **The REFNIS text file is CP1252, not Latin-1.** Latin-1 silently corrupts Braine-l'Alleud and Fontaine-l'Evêque.

---

## 13. CI gates

The bake is not done until all of these pass.

1. **Idempotency.** Run `bake.py` twice into two directories; `diff -r` must be empty. Run once with `PYTHONHASHSEED=0` and once with `PYTHONHASHSEED=random`; both must match.
2. **Precision.** No number in any `.geojson` matches `-?[0-9]+\.[0-9]{6,}`. No `.json` under `grid/` contains `.` inside a number at all.
3. **Size.** No `sector.geojson` over 150,000 B. Whole-tree gzipped total under 3,145,728 B.
4. **No secrets.** Grep the built tree for `key=`, `token`, `apikey`, `Authorization`. Must be clean (acceptance test 7).
5. **Names.** No shipped record has an empty name in all of NL, FR, DE (resolver step 4 must always succeed).
6. **Vintage.** Every shipped file carries `"vintage":"2025-01-01"`; no file carries a wall-clock timestamp.
7. **Referential integrity.** Every `st` in a grid shard resolves in that municipality's `streets.json`; every `sc` entry exists in that municipality's `sector.geojson`; every cell in `<nis>/meta.json.cells` exists in `grid/`.
8. **Grid agreement.** `python3 scripts/grid.py` self-test passes, and `web/app/grid.js` returns identical cell ids over the committed fixture.
9. **Precache manifest.** `python3 scripts/gen_precache.py --check` is clean: `web/data/precache.json` lists exactly the tree that was baked.
10. **Chrome coverage.** `python3 scripts/check_i18n.py` passes: every key any band module asks for exists, non-blank and with matching `{placeholders}`, in all three of `en`, `nl`, `fr`. This is the static half of acceptance test 4; `node scripts/test_i18n_marker.mjs` is the runtime half and proves the fallback is *marked* when a key is missing.
11. **Vintage guard.** `node scripts/test_stats.mjs` and `node scripts/test_zoom.mjs` pass against the 55 records in `nis_history.json` and the 565 codes in `municipalities.json` (acceptance test 3). `--live` additionally calls the Statbel HVD API for every pilot.
12. **Cold cache.** `node scripts/test_sw_offline.mjs` passes: `web/sw.js` is installed for real, the network is cut, and every pilot city resolves address, sector and municipality from the cache alone (acceptance test 1, PLAN phase 1 exit criterion).

**Added 15 August 2026 with the map-first revamp:**

13. **The tile gate.** Runs inside gate 9, so it cannot be skipped: `gen_precache.py` fails the build if `tile.openstreetmap.org` appears in `precache.json`, in any `sw.js` shell list, on any line calling `cache.add`/`addAll`, or more than once in executable code outside the `TILE_HOST` constant; and if any shell entry or manifest path carries a scheme. It also fails if it finds **no** shell list at all, so it can never pass vacuously. `--tiles-only` runs it alone. Backed at runtime by `node scripts/test_tiles.mjs`, which proves the cache is bounded at 300 and evicted least-recently-used.
14. **The map.** `node scripts/test_map.mjs` passes: the Web Mercator projection and tile arithmetic, the vector layers, the markers, the gestures and the keyboard handlers.
15. **The app as one thing.** `node scripts/test_integration.mjs` passes: the real `index.html` and the real `main.js` boot over `scripts/domstub.mjs` and a Brussels fix is driven through shell → bands → map. This gate exists because gates 9 to 14 can all be green while the app is broken — each tests one file, and nothing was testing them together. Its first run found a shell shipping `chrome-left` against a stylesheet styling `chrome--tl`, a `#map-scale` no rule matched, and a `main.js` importing a module that does not exist.
16. **Fonts.** `python3 scripts/fetch_fonts.py --check` passes with no network: all four `.woff2` match their sha256 in `scripts/fonts.lock.json`, and each family's OFL text is present beside it.

Gates 9 to 15 need `node` only as a test runner. There is no `package.json`, no `npm install` and no dependency: they are plain files, exactly like `scripts/*.py`.

**What no gate proves.** There is no browser in this loop. `domstub.mjs` is a JavaScript DOM, so gates 14 and 15 show that the wires connect and nothing throws; they cannot show that the map *looks* right. Layout, font rendering, real tile fetching, touch gestures and the dark theme are verified by eye.
