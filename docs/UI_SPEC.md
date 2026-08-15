# BeHERE UI spec, v1: the map-first revamp

**Status: authoritative for appearance and interaction.** It does not touch data.
`docs/CONTRACT.md` stays the wire format and outranks this file on anything to do
with bytes. `PLAN.md` stays the build brief, with one correction recorded in
section 10.3 below: PLAN section 6 says "Four bands stacked on one screen. No tabs,
no dashboard." That screen model is superseded here by a full-bleed map with five
bands as pill overlays. Nothing else in PLAN changes.

Written against `design/prototype/BeHERE Map.dc.html` and the shipped app in
`web/`. Every colour, space, radius and shadow below is a token from
`design/prototype/_ds/organic-.../styles.css`. Every measured contrast ratio was
computed from the token hexes with the WCAG 2.x relative-luminance formula and is
reproducible from the snippet in section 9.

**The prototype is a design source, not a code source.** It loads React 18 from
`unpkg.com` through `support.js`, and it renders through a template runtime that
evaluates strings. None of that ships. Everything specified here is plain ES
modules, plain CSS and plain DOM, exactly like `web/app/*.js` today.

---

## 0. What changes, what does not

### 0.1 Does not change

| Thing | Why it is untouched |
|---|---|
| `scripts/bake.py`, every schema in `docs/CONTRACT.md` | The revamp is presentation only |
| `web/app/geo.js`, `web/app/i18n.js`, `web/app/stats.js`, `web/app/gtfsrt.js` | Data, resolver, vintage guard, protobuf |
| The band **logic** in `here.js`, `around.js`, `go.js`, `now.js`, `zoom.js` | Their view models, their empty-state decisions and their class vocabulary all survive |
| `main.js`'s `BAND_ADAPTER`, `makeContext()`, `setSources()`, the one watcher, the centre-first read | The five bands keep being mounted once and driven by the same context |
| The `<section class="band" id="band-*" data-band data-state>` + `div.band-body[data-role="body"]` + `p.src[data-role="src"]` contract | `main.js` and every band module query it by id and by `data-role` |
| `sw.js` filename, the DATA/LIVE/SHELL caches, `precache.json` | Renaming `sw.js` serves stale HTML forever |
| `#locate` and `#locate-status` ids | `main.js` binds them by id |

### 0.2 Changes

| File | Change |
|---|---|
| `web/index.html` | Rewritten shell: map, chrome clusters, dock, the five band sections moved inside the dock panel. CSP gains one `img-src` host. |
| `web/app/app.css` | Rewritten on Organic tokens. Keeps every existing class selector name. |
| `web/ds/organic.css` | **New.** Vendored Organic token + component sheet, Google Fonts `@import` deleted, `@font-face` added. |
| `web/fonts/*.woff2`, `web/fonts/OFL.txt` | **New.** Self-hosted Caprasimo and Figtree. |
| `web/app/map.js` | **New.** Projection, tile pyramid, viewport, vector layers, markers, position dot. Knows nothing about bands. |
| `web/app/dock.js` | **New.** The five pills, the panel shell, expand/collapse, focus management. |
| `web/app/grid.js` | Two additive exports: `laeaInverse()`, `cellRing()`. The forward path and its CI fixture are untouched. |
| `web/app/main.js` | Boots `map.js` and `dock.js`; pushes position and selection between them. Band wiring unchanged. |
| `web/sw.js` | One new cache (`behere-tiles-v1`), one new route, an LRU cap. Tiles never enter `precache.json`. |
| `web/manifest.webmanifest`, `scripts/gen_icons.py` | New theme colour and icon field. |
| `web/offline.html`, `web/404.html` | Restyled on the same tokens. |
| `web/data/i18n/{en,nl,fr}.json` | New `ui` keys, listed in section 10.2. `scripts/check_i18n.py` gates all three. |

---

## 1. THE MAP

The map is the page. It is `position: fixed; inset: 0`, beneath every other layer,
and it is never scrolled. `html, body { margin: 0; height: 100%; overflow: hidden;
background: var(--color-bg) }`.

```html
<div id="map" class="map" aria-hidden="true">
  <div class="map-tiles"   data-state="live|failed|off"><!-- <img> tiles --></div>
  <div class="map-veil"></div>
  <svg class="map-vectors" width="100%" height="100%"><!-- cell, sectors, accuracy --></svg>
  <div class="map-markers"><!-- stop and POI marks --></div>
  <div class="map-position"><!-- pulse + core --></div>
</div>
```

`#map` carries `aria-hidden="true"` and contains **no focusable element**. Its
reasoning is in section 3.6; in short, everything the map draws is also text in a
band, and 49 stop markers in one Brussels shard must never become 49 tab stops.

### 1.1 Stacking order, bottom to top

| # | Layer | Element | Stacking |
|---|---|---|---|
| 1 | OSM raster underlay | `.map-tiles` | in flow, `z-index: auto` |
| 2 | Ground veil | `.map-veil` | `z-index: 1`, `pointer-events: none` |
| 3 | GRD_NEWID 1 km cell path | `<path class="map-cell">` in `.map-vectors` | `z-index: 2`, first child of the svg |
| 4 | Sector polygons | `<g class="map-sectors">` in the same svg | same svg, after the cell |
| 5 | Accuracy circle | `<circle class="map-accuracy">` | same svg, last child |
| 6 | Stop and POI markers | `.map-markers > .map-marker` | `z-index: 4`, selected marker `z-index: 6` |
| 7 | Position dot | `.map-position` | `z-index: 5` |

Two consequences of that order are deliberate and lifted from the prototype:
the **selected** marker (6) draws over the position dot (5), so tapping a stop
never hides the stop you just tapped; every **unselected** marker (4) draws under
it, so the dot is never lost in a crowd of pins.

The whole svg is `position: absolute; inset: 0; pointer-events: none;
overflow: visible`. The cell and sector geometry are recomputed on every pan,
zoom and position change; nothing is cached between frames except the decoded
GeoJSON.

### 1.2 Layer 1: the OSM raster underlay

**This layer is always on.** The user was told the privacy, offline and
tile-policy costs and chose it. The rules below are what make it responsible;
none of them is optional.

#### Tiling

Web Mercator, 256 px tiles, integer zoom `z` in `[11, 17]`, default `15`.

```
world      = 256 * 2 ** z
pxX(lon)   = (lon + 180) / 360 * world
pxY(lat)   = (0.5 - ln((1 + sin(lat°)) / (1 - sin(lat°))) / (4π)) * world
cx, cy     = pxX(centreLon), pxY(centreLat)
tx, ty     = floor(cx / 256), floor(cy / 256)
fx, fy     = cx - tx*256, cy - ty*256
```

The tile grid is a CSS grid of 256 px cells positioned so that tile `(tx, ty)`
lands with its top-left at `(w/2 - fx, h/2 - fy)`. `X` wraps modulo `2**z`; `Y`
is clamped to `[0, 2**z - 1]`.

**Extent: exactly the tiles that intersect the viewport, and not one more.**

```
rx = ceil((w/2 - fx) / 256)   left ring
ry = ceil((h/2 - fy) / 256)   top ring
   (and the mirrored counts on the right and bottom)
```

The prototype adds `+1` ring beyond the viewport. **Do not ship that.** A ring of
speculative tiles is the beginning of bulk downloading, and the OSM tile usage
policy forbids it. New tiles are requested only as they enter the viewport during
a drag.

Each tile is a real element so that failures are observable:

```html
<img class="map-tile" src="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
     width="256" height="256" alt="" decoding="async" fetchpriority="low" draggable="false">
```

`fetchpriority="low"` matters: a tile must never compete with a grid shard.
`alt=""` and the `aria-hidden` ancestor keep them out of the accessibility tree.

#### Appearance

```css
.map-tiles { filter: var(--tile-filter); }
.map-tile  { opacity: var(--tile-alpha); }
```

| Token | Light | Dark |
|---|---|---|
| `--tile-filter` | `saturate(0.6) contrast(0.85) brightness(1.1) opacity(0.94)` | `saturate(0.55) contrast(1.05) brightness(0.55) opacity(0.94)` |
| `--tile-alpha` | `0.62` | `0.62` |

The light value is byte-identical to the design system's own `.washed` filter,
which is exactly what the prototype applies. Effective composite alpha over the
ground is `0.62 × 0.94 = 0.583`. The dark value darkens rather than inverts: an
inverted basemap is a different-looking derivative work and it reads badly.

The measured effect of this treatment on the standard OSM Carto fills is what
makes section 9's stroke numbers valid, so it is recorded here:

| OSM fill | raw | after `--tile-filter` + 0.583 α over `--color-bg` + 18% veil |
|---|---|---|
| land `#f2efe9` | | `#f6efe4` |
| wood `#add19e` | | `#dcdfc8` |
| grass `#cdebb0` | | `#e9ecd2` |
| water `#aad3df` | | `#dce1db` |
| building `#d9d0c9` | | `#eae2d6` |
| road casing `#ffffff` | | `#faf4eb` |
| motorway `#e892a2` | | `#e5c9c4` |

#### Caching, and the precache prohibition

- **A dedicated cache, `behere-tiles-v1`, added to `KEEP` in `sw.js`.** Never
  `DATA`, never `SHELL`.
- Route: `url.host === "tile.openstreetmap.org"` → cache-first, TTL **7 days**,
  stamped with the existing `x-behere-cached-at` header.
- **LRU cap of 300 entries.** After each successful put, if `cache.keys().length
  > 300`, delete the oldest by stamp until it is 300. A phone must not fill its
  quota with basemap.
- **Tiles are never precached.** `precacheData()` reads `web/data/precache.json`,
  which `bake.py` writes from `Writer.files`, which only ever holds same-origin
  baked data. Tiles cannot appear there structurally. To keep it that way, add
  two CI greps next to the existing gates:
  1. `web/data/precache.json` must not contain the string `tile.openstreetmap.org`.
  2. `web/sw.js` must not pass a tile URL to `cache.add`/`cache.addAll`; the only
     tile write is inside the runtime fetch handler.
- **No prefetch, no speculative load, no scraping loop.** Zoom changes are
  debounced 120 ms so a fast `−−−` never fetches the intermediate levels.

#### Save-data and reduced-data

If `navigator.connection && navigator.connection.saveData`, or
`matchMedia("(prefers-reduced-data: reduce)").matches`, tiles are not requested
at all. `.map-tiles[data-state="off"]`, and the tile note reads the same copy as
a failure (section 1.8), because both are true: nothing raster is being shown and
everything on screen is baked.

#### Failure degrades to the vector map

Every `<img.map-tile>` gets an `error` listener. After **three** tile errors
within one viewport, `map.js` sets `.map-tiles[data-state="failed"]`, stops
requesting tiles for 60 s, and switches the tile note. Nothing else changes: the
cell path, the sectors, the markers and the position dot are all drawn from baked
shards, so airplane mode still answers "where am I" and **acceptance test 1 is
untouched** (it is a headless test over `sw.js` and `geo.js` and never sees the
map at all).

#### CSP

`web/index.html`'s meta CSP gains exactly one host, on `img-src` only:

```
img-src 'self' data: https://tile.openstreetmap.org;
```

`connect-src` is unchanged: tiles are `<img>` loads, not `fetch`. `font-src` is
not added because `default-src 'self'` already covers the self-hosted woff2.
`script-src` stays `'self'` with no `'unsafe-inline'`.

### 1.3 Layer 2: the ground veil

One absolutely positioned div, `pointer-events: none`:

```css
.map-veil {
  position: absolute; inset: 0; z-index: 1; pointer-events: none;
  background: radial-gradient(150% 120% at 50% 42%,
      color-mix(in srgb, var(--color-bg)  0%, transparent)   0%,
      color-mix(in srgb, var(--color-bg) 18%, transparent)  72%,
      color-mix(in srgb, var(--color-bg) 42%, transparent) 100%);
}
```

The prototype hard-codes `rgba(245,234,216, α)`, which is `--color-bg` at those
alphas; expressed through the token it also works in dark mode, where it sinks
the tiles into the deep brown ground instead of lifting them into cream.

`at 50% 42%` is not arbitrary: the dock occupies the bottom of the screen, so the
optical centre of the map sits above its geometric centre.

### 1.4 Layers 3 and 4: the vector paths

All strokes below are **promoted one ramp step darker than the prototype**. The
reason is measured, not aesthetic: over the washed tile fills in section 1.2, the
`600` steps fall to 2.70–2.88:1 against the motorway pink, under the 3:1 that
WCAG 2.1 SC 1.4.11 requires of a graphic that carries meaning. The `700` steps
clear it everywhere with margin (worst case 4.15:1). Full table in section 7.3.

#### The GRD_NEWID 1 km cell

One `<path>`, the square you are standing in, projected from EPSG:3035.

| Property | Value |
|---|---|
| `fill` | `color-mix(in srgb, var(--color-accent-2) 8%, transparent)` |
| `stroke` | `var(--ink-cell)` = `--color-accent-2-700` light / `--color-accent-2-300` dark |
| `stroke-width` | `2` |
| `stroke-dasharray` | `9 6` |
| `stroke-linejoin` | `round` |
| `vector-effect` | `non-scaling-stroke` |

Geometry: `cellRing(cell)` returns the four WGS84 corners of the cell by inverse
projection of `[E·1000, N·1000+1000], [E·1000+1000, N·1000+1000],
[E·1000+1000, N·1000], [E·1000, N·1000]`, closed with `Z`. Section 1.7 adds the
inverse to `grid.js`.

#### The sector polygons

One `<path>` per feature of `web/data/<nis>/sector.geojson`, in the file's own
order (`properties.s` ascending, per CONTRACT 6). All geometries are
`MultiPolygon`, including single-part sectors, so there is one code path.

| | The sector you are in | Every other sector |
|---|---|---|
| `fill` | `color-mix(in srgb, var(--color-accent) 20%, transparent)` | `color-mix(in srgb, var(--color-accent) 5%, transparent)` |
| `stroke` | `var(--ink-sector)` | `var(--ink-sector)` |
| `stroke-width` | `3` | `1.25` |
| `stroke-linejoin` | `round` | `round` |

`--ink-sector` = `--color-accent-700` light / `--color-accent-300` dark.

**Changed from the prototype:** the prototype distinguishes the two by hue step
(`--color-accent-600` against `--color-accent-300`). `--color-accent-300` on the
cream ground measures **1.27:1**, which is not a line, it is a rumour. The
distinction is carried by **width and fill** instead, both of which are reliable
at any ground colour, and both strokes use the one contrast-safe step.

Which sector you are in is decided by `here.js`'s existing point-in-polygon
(`findSectorAt` in `geo.js`). The map asks `here.js`, it does not re-derive it.
There is one sector authority in this app.

#### The accuracy circle

| Property | Value |
|---|---|
| `cx`, `cy` | the projected position |
| `r` | `clamp(10, accuracyMetres / metresPerPixel, 0.4 * min(w, h))` |
| `fill` | `color-mix(in srgb, var(--color-accent) 10%, transparent)` |
| `stroke` | `var(--ink-sector)` |
| `stroke-width` | `1.5` |
| `stroke-dasharray` | `3 4` |

**Changed from the prototype**, which strokes it in `--color-accent-400`
(1.74:1 on cream, 1.03:1 over a darkened tile). Dashed and thin keeps it feeling
soft while the darker ink keeps it visible. The prototype also fakes the radius
as a constant 18 m; the real `fix.accuracy` is used here, and the upper clamp
stops a 5 km fix from painting the whole screen orange.

### 1.5 Layer 6: markers

One mark per **boarding point** (a `ps` parent station groups its platforms, as
`go.js` already does), plus one per baked POI once CONTRACT 7.2's `p` key ships.

```html
<span class="map-marker" data-key="…" data-op="stibmivb" role="presentation">
  <span class="map-marker__dot"></span>
  <span class="map-marker__label">Botanique</span>
</span>
```

`role="presentation"`, no `tabindex`, not a `<button>`. It is a pointer
affordance whose keyboard equivalent is the Go band list (section 3.6).

| Property | Value |
|---|---|
| container | `position: absolute; transform: translate(-50%, -50%); z-index: 4` (selected `6`) |
| shape | `display: flex; align-items: center; gap: 7px; border-radius: 999px` |
| padding | labelled `5px 11px 5px 8px`, unlabelled `5px` |
| `background` | `var(--color-bg)` |
| `color` | `var(--color-text)` |
| `border` | `2px solid transparent`, selected `2px solid var(--ink-stops)` |
| `box-shadow` | `var(--shadow-sm)`, selected `var(--shadow-lg)` |
| `transform` scale | `1`, selected `1.06`, `transition: transform .15s ease` |
| dot | `9px` circle, `background: var(--ink-stops)` |
| label | `12.5px / 600`, `white-space: nowrap`; shown when selected **or** among the 8 nearest, `display: none` otherwise |

`--ink-stops` = `--color-accent-2-800` light / `--color-accent-2-200` dark.

**Changed from the prototype:** the idle border was `var(--color-bg)`, which is
invisible against the pill's own `--color-bg` fill and does nothing in dark mode.
`transparent` plus `--shadow-sm` does the separating; the dark `--shadow-sm`
carries a hairline for exactly this reason (section 5.3).

Ordering: markers are sorted by haversine distance ascending before rendering, so
"the 8 nearest get labels" is stable and the DOM order matches the Go list order.

`transition` is suppressed under `prefers-reduced-motion: reduce`.

### 1.6 Layer 7: the position dot

```html
<div class="map-position"><span class="map-position__pulse"></span><span class="map-position__core"></span></div>
```

| Part | Value |
|---|---|
| container | `18px` square, `translate(-50%, -50%)`, `z-index: 5`, `pointer-events: none` |
| pulse | `inset: 0; border-radius: 999px; background: var(--color-accent); animation: bhPulse 2.4s ease-out infinite` |
| core | `inset: 0; border-radius: 999px; background: var(--color-accent); border: 3px solid var(--color-bg); box-shadow: var(--shadow-md)` |
| hairline | `outline: 1px solid var(--color-accent-900)` on the core, light theme only |

```css
@keyframes bhPulse { 0% { transform: scale(1); opacity: .5 } 100% { transform: scale(3.2); opacity: 0 } }
@media (prefers-reduced-motion: reduce) { .map-position__pulse { animation: none; opacity: .35 } }
```

The 1px `--color-accent-900` hairline is added to the prototype because the
`--color-bg` casing measures 1.01–2.32:1 against a washed tile, so the dot could
dissolve into a pale ground. `--color-accent-900` measures **9.20:1 at worst**
over every washed fill. In dark the core already sits on a deep ground and the
hairline is dropped.

### 1.7 Projection, viewport and the two `grid.js` additions

`web/app/map.js` owns the Web Mercator helpers (`pxX`, `pxY`, `lonAt`, `latAt`,
`screen`, `metresPerPixel`), the viewport state `{centreLat, centreLon, zoom, w, h}`
and the pan/zoom handlers. `metresPerPixel = 156543.03392 * cos(centreLat) / 2**zoom`.

`web/app/grid.js` gains two exports. Both are additive; the forward path and
`scripts/grid.py`'s CI agreement fixture (gate 8) are untouched.

```js
/** Newton inversion of laeaForward. Converges to millimetres in 4 passes. */
export function laeaInverse(x, y, seedLat, seedLon)   // 5 iterations, h = 1e-6

/** The four WGS84 corners of a GRD_NEWID cell, counter-clockwise, unclosed. */
export function cellRing(cell, seedLat, seedLon)      // -> [[lon,lat] × 4]
```

The seed is the current map centre. A cell is at most 1 km from it, so the solver
converges in three passes in practice.

**Vertex budget.** A simplified sector file is under 150 KB and Ghent carries 254
features. Rebuilding every path string on every pointer-move event is wasteful,
so: the projected path `d` strings are recomputed on `requestAnimationFrame`, at
most once per frame, and only for features whose bounding box intersects the
viewport rect expanded by 64 px. Bounding boxes are computed once per file load.

### 1.8 Attribution, scale readout and the tile note

**Attribution is a licence requirement, not a design choice.** It is visible on
every frame where a tile has been drawn, it is never inside a collapsed
disclosure, and it links out:

```html
<p class="map-attrib">
  <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a>
</p>
```

| Property | Value |
|---|---|
| position | bottom-right of the map, above the dock, `bottom: calc(var(--dock-height) + var(--space-2))`, `right: var(--space-2)`, `z-index: 15` |
| shape | `border-radius: 999px; padding: 3px 10px` |
| `background` | `color-mix(in srgb, var(--color-bg) 88%, transparent)` |
| type | `11px`, `color: var(--ink-muted)` |
| link | `color: var(--ink-accent)`, underlined |

The string is **not** an i18n key. It is an attribution required verbatim by
ODbL, and translating an attribution is how attributions get lost.

Hidden only when `.map-tiles[data-state]` is `off` or `failed` **and** no tile is
currently painted. If a cached tile is on screen, the attribution is on screen.

**Scale readout and zoom cluster** (top-right, section 3.4). The readout is
`Math.round(metresPerPixel * 100) + " m"`, i.e. metres per 100 px, in
`12px / 600`, `font-variant-numeric: tabular-nums`, `min-width: 52px`,
`color: var(--ink-muted)`. It carries
`aria-label = t("map.scale", { m })` → `"{m} m per 100 pixels"`.

**Tile note**, a pill under the layer chips:

| State | Copy (verbatim from the prototype) | Fill / ink |
|---|---|---|
| live | `Tiles: openstreetmap.org · live` | `var(--color-bg)` / `var(--ink-muted)` |
| off or failed | `No tiles. Everything drawn is baked on this device.` | `var(--fill-warn)` / `var(--ink-on-warn)` |

`border-radius: 999px; padding: 5px 12px; font-size: 11px; font-weight: 600;
box-shadow: var(--shadow-sm)`. i18n keys `map.tiles.live` and `map.tiles.none`.

---

## 2. THE FIVE BANDS AS PILL OVERLAYS

### 2.1 The dock

One element, bottom-anchored, over the map.

```html
<div class="dock" style="--dock-height: …">
  <div class="dock-panel" id="dock-panel"><!-- the five band sections --></div>
  <div class="dock-pills" role="group" aria-label="…"><!-- five pills --></div>
</div>
```

```css
.dock {
  position: absolute; left: 0; right: 0; bottom: 0; top: auto;
  max-height: 100%; z-index: 20; pointer-events: none;
  display: flex; flex-direction: column; justify-content: flex-end;
  gap: var(--space-2);
}
```

| | Narrow (`< 720px`) | Wide (`>= 720px`) |
|---|---|---|
| `.dock` `align-items` | `stretch` | `flex-start` |
| `.dock` `padding` | `0` | `var(--space-4)` |
| `.dock-panel` width | `100%` | `452px`, `max-width: calc(100vw - 48px)` |
| `.dock-panel` radius | `var(--radius-lg) var(--radius-lg) 0 0` | `var(--radius-lg)` |
| `.dock-panel` max-height | `min(56vh, calc(100dvh - 168px))` | `min(60vh, calc(100dvh - 200px))` |
| `.dock-pills` | `width: 100%`, `padding: var(--space-3) var(--space-4) calc(var(--space-3) + 4px)`, `background: var(--color-bg)` | `padding: 2px 2px 4px`, no background |

Both children set `pointer-events: auto`; the dock itself does not, so the map
stays draggable in the gap beside a narrow panel on a wide screen.

`100dvh` replaces the prototype's `100vh` so an iOS URL bar cannot push the pills
under the browser chrome. Add `padding-bottom: max(var(--space-3),
env(safe-area-inset-bottom))` to `.dock-pills` on narrow.

`--dock-height` is written by `dock.js` from a `ResizeObserver` on `.dock`. It is
what the map reads to offset its optical centre (section 3.3) and what the
attribution reads to sit above the dock.

The 720 px breakpoint is the prototype's own `isPhone()` threshold
(`this.state.w < 720`) and is expressed as a container-agnostic media query.

### 2.2 The pill: resting state

```html
<button type="button" class="pill" id="pill-here"
        aria-expanded="false" aria-controls="band-here">
  <span class="pill__state" data-state="answers|nothing|idle"></span>
  <span class="pill__text">
    <span class="pill__label">Here</span>
    <span class="pill__count">21004A32-</span>
  </span>
</button>
```

| Property | Resting | Expanded |
|---|---|---|
| layout | `display: flex; align-items: center; gap: 9px; flex: 0 0 auto` | same |
| `border` | `0` | `0` |
| `border-radius` | `999px` | `999px` |
| `padding` | `8px 15px 8px 11px` | same |
| `background` | `var(--color-bg)` | `var(--fill-accent-solid)` |
| `color` | `var(--color-text)` | `var(--ink-on-accent-solid)` |
| `box-shadow` | `var(--shadow-sm)` | `var(--shadow-md)` |
| `.pill__label` | `var(--font-heading)` 15px | same |
| `.pill__count` | 10.5px, `letter-spacing: .02em`, `color: var(--ink-muted)` | 10.5px, `color: var(--color-accent-100)` |

`--fill-accent-solid` = `--color-accent-700` light / `--color-accent-400` dark.
`--ink-on-accent-solid` = `--color-bg` in both.

**Changed from the prototype, twice, both for contrast.** The prototype fills the
expanded pill with `--color-accent` and writes `--color-bg` on it: **3.03:1**,
which is the exact pair the Organic guide warns about. `--color-accent-700`
carries the same cream at **5.72:1**. And the prototype dims both counts with
`opacity: .6` / `.85`; at 10.5 px that lands at 4.13:1 resting. Replacing opacity
with a real token gives 5.53:1 resting and 6.21:1 expanded. See section 7.4, rows F2 and F3.

Hover: resting `background: var(--color-neutral-200)`; expanded
`background: var(--color-accent-800)`. Active/pressed: one step further
(`--color-neutral-300` / `--color-accent-900`), per the Organic interaction rule.

#### The state dot, `.pill__state`

10 px, `border-radius: 999px`. It is reinforcement, never the only signal: the
same fact is in `.pill__count` as words.

| `data-state` | Meaning | Rendering |
|---|---|---|
| `answers` | this band has something to say here | filled, `background: var(--ink-cell)` |
| `nothing` | published nothing / out of scope / nothing baked | hollow, `background: transparent; box-shadow: inset 0 0 0 1.5px var(--ink-quiet)` |
| `idle` | no position yet | hollow, `opacity: .5` |
| on an expanded pill | any | filled, `background: var(--color-bg)` |

**Changed from the prototype**, which uses `--color-accent-2-500` (2.37:1) and
`--color-neutral-400` (1.68:1) against the cream pill. Neither reaches the 3:1 a
status indicator needs. `--ink-cell` measures 5.43:1 and `--ink-quiet` 3.61:1,
and the filled/hollow distinction means the state also survives a monochrome
rendering.

#### `.pill__count`, per band

All of these are new `ui` keys (section 10.2). The values are the prototype's,
generalised with placeholders.

| Band | Count string | Key |
|---|---|---|
| Here | the sector code, else `NIS {nis}` | `pill.here.nis` |
| Around | `{n} datasets` / `{n} dataset` | `pill.around` / `pill.around.one` |
| Go | `{n} stops here`, or `{n} baked` before the nine cells land | `pill.go` / `pill.go.baked` |
| Now | `{n} calendars` / `{n} calendar` / `none published` | `pill.now` / `pill.now.one` / `pill.now.none` |
| Zoom out | the `nuts3` code | `pill.zoom` |
| any, off the release | `nothing baked` | `pill.none` |
| any, before a fix | `waiting for a position` | `pill.idle` |

The band labels themselves reuse the shipped keys `band.here`, `band.around`,
`band.go`, `band.now`, `band.zoomout`. The panel kicker reuses `band.here.q`,
`band.around.q`, `band.go.q`, `band.now.q`, `band.zoomout.q`.

> The prototype writes the Go kicker as "How do I get away from here?". The
> shipped `band.go.q` is "How do I get there?". **Keep the shipped string.**
> `scripts/check_i18n.py` gates that key in all three languages and it is already
> translated; a copy change here would be a translation change in three files for
> no gain.

### 2.3 The panel: expanded state

All five `<section class="band">` elements live inside `#dock-panel`
**permanently**. Expanding does not mount and collapsing does not unmount. Only
`hidden` moves. This is what keeps `main.js`'s `app.bands` map, `BAND_ADAPTER`,
`setSources()` and the go/now `root: "section"` adapters working exactly as
written, and it is what keeps a band's fetch state from being thrown away every
time the user glances at another band.

```html
<div class="dock-panel" id="dock-panel" hidden>
  <header class="panel-head">
    <div>
      <p class="panel-kicker">Where am I?</p>
      <h2 class="panel-title" id="panel-title">Here</h2>
    </div>
    <button type="button" class="btn btn-secondary btn-icon panel-close" aria-label="Close">…×…</button>
  </header>
  <div class="panel-body bh-scroll">
    <section class="band" id="band-here"  data-band="here"  data-state="idle" aria-labelledby="panel-title">…</section>
    <section class="band" id="band-around" data-band="around" hidden>…</section>
    …
  </div>
</div>
```

The `<h2>` in the panel head is the single visible band title, driven by
`dock.js`. The per-section `<header><h2>` that `index.html` carries today is
removed from the markup: it would be a duplicate heading. `around.js` already
detects this case (`root.closest(".band")` → headerless) and `main.js` already
passes `chrome: false`, so nothing in the band modules changes.

| Element | Property | Value |
|---|---|---|
| `.dock-panel` | `background` | `var(--color-bg)` |
| | `box-shadow` | `var(--shadow-lg)` |
| | layout | `display: flex; flex-direction: column; min-height: 0` |
| `.panel-head` | layout | `display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3)` |
| | `padding` | `var(--space-4) var(--space-4) var(--space-2)` |
| `.panel-kicker` | type | `11px`, `letter-spacing: .08em`, `text-transform: uppercase` |
| | `color` | `var(--ink-accent)` |
| `.panel-title` | type | `var(--font-heading)`, `26px`, `margin: 2px 0 0` |
| `.panel-close` | | `.btn .btn-secondary .btn-icon`, `border-radius: 999px`, 16px `×` glyph at `stroke-width: 2.75` |
| `.panel-body` | | `overflow-y: auto; overflow-x: hidden; min-height: 0; display: flex; flex-direction: column; gap: var(--space-3); padding: 0 var(--space-4) var(--space-4)` |

Scrollbar, from the prototype:

```css
.bh-scroll::-webkit-scrollbar { width: 8px; height: 8px }
.bh-scroll::-webkit-scrollbar-thumb { background: var(--color-neutral-400); border-radius: 999px }
.bh-scroll { scrollbar-width: thin; scrollbar-color: var(--color-neutral-400) transparent }
```

#### The three content shapes inside the panel body

The band modules already emit exactly these three shapes. The prototype names
them notes, fields and items. The mapping is in section 4.

**Note** (`p.quiet`, `p.around-layer__missing`, `p.now-note`, `p.go-note`):

| | Quiet tone | Warn tone |
|---|---|---|
| `background` | `var(--fill-quiet)` | `var(--fill-warn)` |
| `color` | `var(--ink-on-quiet)` | `var(--ink-on-warn)` |
| `border-radius` | `var(--radius-md)` | `var(--radius-md)` |
| `padding` | `var(--space-3)` | `var(--space-3)` |
| kind label | `11px`, `.08em`, uppercase, `opacity: .72`, `margin-bottom: 4px` | same |
| body | `14px / 1.5`, `text-wrap: pretty` | same |

Warn tone is used **only** for data that is real but old (`p.asof`, `p.now-asof`,
`p.go-asof`, `.offline-bar`). It is never used for "nothing published here". That
rule is inherited from `app.css` today and it is the single most important
colour decision in the app: *old* and *absent* are different claims.

**Field row** (`dl.facts > dt + dd`, `.stats li`):

```css
.facts { display: grid; grid-template-columns: 104px 1fr; gap: var(--space-3) }
.facts dt { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-muted) }
.facts dd { font-size: 14.5px; font-weight: 600; line-height: 1.35; text-wrap: pretty; margin: 0 }
.facts dt, .facts dd { padding-bottom: var(--space-2); border-bottom: 1px solid var(--color-divider) }
```

**Changed from the prototype:** the key colour was `--color-neutral-600`
(3.61:1 at 11 px). `--ink-muted` is `--color-neutral-700`, 5.53:1.

**Item card** (`li.around-item`, `li.go-stop`, `li.now-item`, rendered as a
button where the band makes it interactive):

| Property | Resting | Selected |
|---|---|---|
| layout | `display: flex; flex-direction: column; gap: 2px; width: 100%; text-align: left` | same |
| `border-radius` | `var(--radius-md)` | same |
| `padding` | `var(--space-3)` | same |
| `background` | `var(--fill-card)` | `var(--fill-card-selected)` |
| `border` | `1px solid var(--color-divider)` | `2px solid var(--color-accent-600)` |
| name | `15px / 700 / 1.3` | same |
| distance | `11.5px`, tabular-nums, `color: var(--ink-muted)` | same |
| sub | `13px / 1.45`, `color: var(--ink-on-quiet)` | same |
| `aria-current` | absent | `"true"` |

**Changed from the prototype:** the selected border was
`--color-accent-500` at 1px, **2.52:1** against the panel, which is under the 3:1
a state indicator needs. `--color-accent-600` at 2px measures **3.77:1**.
Distance and sub were `--color-neutral-600` / `--color-neutral-800`; the first is
promoted to `--ink-muted` for the same 3.61:1 reason.

Tag row inside a card, `gap: 6px; flex-wrap: wrap; padding-top: 2px`:

| Tag | Class | Fill / ink |
|---|---|---|
| source | `.tag .tag-outline` | `transparent` / `var(--ink-accent)`, `border: 1px solid var(--color-accent)` |
| state, neutral | `.tag .tag-neutral` | `var(--fill-quiet)` / `var(--ink-muted)` |
| state, live | `.tag .tag-accent-2` | `var(--color-accent-2-200)` / `var(--color-accent-2-800)` |

**Changed from the design system:** `.tag-outline` ships as
`color: var(--color-accent)`, which is 3.03:1 and fails as 10 px text. Override
its `color` to `var(--ink-accent)` (`--color-accent-700`, 5.72:1) app-wide in
`app.css` and keep the `--color-accent` border, which is a non-text boundary and
passes at 3.03:1.

**Source line** at the foot of the panel body, `p.src[data-role="src"]`, written
by `main.js`'s `setSources()`: `padding-top: var(--space-2); font-size: 11.5px;
line-height: 1.5; color: var(--ink-muted); text-wrap: pretty`. Acceptance test 8
lives here and its mechanism is unchanged.

### 2.4 What collapses first

Screen space is taken in this order. Each row is dropped before the row below it.

| Priority | Element | Behaviour as the viewport narrows or shortens |
|---|---|---|
| 1 | Band pills | Never removed. Horizontal scroll (`overflow-x: auto`) with `scroll-snap-type: x proximity`, so the fifth pill is always reachable |
| 2 | The open panel | `max-height` shrinks to `min(56vh, 100dvh - 168px)`; the body scrolls |
| 3 | Position dot and attribution | Never removed |
| 4 | The tile note | Hidden below 400 px width **when tiles are live**. Never hidden in the `off`/`failed` state: that copy is the honest statement about what is on screen |
| 5 | The layer chips | Below 560 px they collapse into one `button.chip` labelled with the count of layers on (`{n} layers`), which opens a small popover holding the three toggles |
| 6 | The scale readout | Hidden below 400 px; the zoom `−`/`+` buttons stay |
| 7 | The place label in the brand pill | `max-width: 38vw` with `text-overflow: ellipsis`; drops out entirely below 360 px, leaving the wordmark |

Below 320 px nothing further collapses; the layout is allowed to be tight.

At `>= 1024px` the panel does not grow past 452 px. Organic is left-aligned and
asymmetric on purpose: the extra width becomes map, not a wider column of text.

### 2.5 A band that has nothing to say

**Never a blank panel, and never an error style for a non-error.** Three distinct
situations, three distinct presentations. Only the third is a fault.

| Situation | `section[data-state]` | Pill state dot | Note tone | Example copy |
|---|---|---|---|---|
| **Published nothing here.** The source answered; there is no data at this place | `empty` | `nothing` | quiet | "No local open-data portal publishes a place dataset for this municipality." |
| **Out of scope for this region by design.** The service does not cover this region and never will | `empty` | `nothing` | quiet | "The Walloon tourism service covers Wallonia only, so this layer is absent by design, not by error." |
| **Could not be reached.** The one that is a fault | `error` | `nothing` | warn | "Statbel could not be reached, and nothing from it is stored on this device yet." |

The band modules already make this distinction correctly (`around.js`'s
`around-layer--empty` / `--absent` / `--failed`, `now.js`'s `missingCopy` vs
`emptyCopy` vs `now.unreachable`, `zoom.js`'s `empty.zoom.unreachable`). The
revamp adds only the pill dot and the tone mapping.

#### The prototype's empty-state copy, verbatim

These are reproduced exactly as written in `design/prototype/BeHERE Map.dc.html`,
including punctuation. Where a sentence is already a shipped `ui` key the key is
given and **the shipped string wins**; where it is new, it becomes a new key.

**Here, off the release:**

> **Out of scope by design**: "This 1 km square is not in the 2025 release. Seven municipalities were baked; this square is not in any of them, so there is no address, sector or municipality to resolve against on this device."

> **A known divergence** (warn tone): "This is one of the four addresses in the whole 4,490,779-row Statbel file where wgs84_to_cell() and Statbel's own GRD_NEWID disagree: the point sits under a millimetre below a cell boundary and Statbel rounded up. Three of the four also diverge from Statbel's published EPSG:3035 columns, so this is Statbel rounding, not projection error."

> *Note for the builder: the first sentence says "Seven municipalities were baked". The release ships **nine** (PLAN's 15 August note). Ship it as "{n} municipalities were baked" filled from `meta.json.municipalities.length`, which is the only change permitted to this string, and the only reason it is permitted is that the alternative is shipping a false number. The second note is a prototype-only annotation about one fixture position and does **not** ship.*

**Here, foreign addresses in this square:**

> **Also in this square**: "{n} addresses in this square belong to NIS {nis}, which is not in this release."

`here.js` already ships this as `here.coverage.intro` + `here.coverage.item`
against the `fm` key of CONTRACT 7.4. Keep the shipped keys.

**Around:**

> **Nothing to ask**: "No municipality resolves here, so no local dataset is in scope. The national layers would still be queried, and would answer with nothing published within their radius."

> **Absent by design**: "The Flemish heritage register covers Flanders only. There is no equivalent point service in this region, so this layer is absent by design, not by error."  → shipped as `around.absent.heritage`

> **Absent by design**: "The Walloon tourism service covers Wallonia only, so this layer is absent by design, not by error."  → shipped as `around.absent.wallonia`

> **Absent by design**: "The Brussels regional catalogue covers the Brussels-Capital Region only."  → shipped as `around.absent.catalogue`

> **Nothing published**: "No local open-data portal publishes a place dataset for this municipality."  → shipped as `around.absent.ods`

**Go:**

> **Live departures**: "Live departures unavailable. The stop itself is stored on this device. iRail is rate-limited to 3 requests a second and go.js sends &client= — a browser cannot set User-Agent."

The shipped app splits this: `go.rt.unavailable` carries the first two sentences
and `go.src.irail` carries the User-Agent honesty in the source line, which is
where it belongs. Keep the shipped split; the prototype merely shows both at once.

> **Nothing baked here**: "No stops are baked for this square, so there is nothing to ask iRail or the NAP about."

> **Not loaded in this prototype**: "{n} stops are baked for NIS {nis} across {c} squares. This prototype loads the shard for 1kmN3097E3924 only."

*The last one is a prototype artefact and does not ship.* Its production
equivalent already exists: `go.loading` ("Checking the surrounding squares…")
while the neighbours are in flight, and `go.nostops` when they land empty.

**Now:**

> **Nothing to ask**: "No municipality resolves here, so no calendar is in scope."

> **Published nothing**: "No market data published for {city}. No event calendar is published as open data for {city} either — this municipality publishes zero local datasets, which is the thinnest case in the release."

The shipped app renders this as two group-level notes, `empty.market` and
`now.event.none`, one per group, which is better than one merged sentence because
each group states its own availability. Keep the shipped pair. The prototype's
merged form is a single-panel compression, not a copy improvement.

> **Per street**: "The collection calendar is per street. It appears once your address is known."  → shipped as `now.collection.noaddress`

**Zoom out:**

> **Why no numbers here**: "Statbel's high-value datasets are live sources, and no table in them reaches municipality level. This prototype ships no figures rather than inventing them: it shows the keys a query would carry."

*Prototype artefact.* The shipped band really does fetch and render figures. Its
own honest copy is `zoom.context` ("Context for the arrondissement you are
standing in, and for Belgium. BeHERE does not rank municipalities.") plus
`empty.zoom.novalues` when Statbel answers with none of the figures shown.

#### The source lines, verbatim

The prototype writes a per-band source paragraph. All five are true of the
shipped app once every date in them is filled from `meta.json` rather than
written into the string, and all five are worth adopting as the second line
under `p.src`:

> **here**: "Baked only: addresses 2025-04-01, sectors 2025-01-01, REFNIS 2025-01-01. No runtime source is called, so this band answers in airplane mode."

> **around**: "Runtime sources, ordered by real haversine distance — no source's own ordering is trusted. Radius searches anchor on a 0.01° box, so panning inside it is one request."

> **go**: "Stops: NAP GTFS, baked 2026-08-15. Live departures: iRail v1 and NAP GTFS-realtime, keyless."

> **now**: "Opening hours, market days and collection dates are evaluated on this device, so this band works offline."

> **zoom**: "Statbel high-value datasets. Queries key on nuts3 and dstr; no table reaches municipality level."

`setSources()` already joins source ids to `meta.json.sources` and prints title,
publisher and vintage, which is what acceptance test 8 requires. These sentences
are the **second** line, added under it as `p.src__why`, at the same 11.5 px and
`--ink-muted`. Dates come from `meta.json`, never hard-coded.

---

## 3. THE INTERACTION MODEL

### 3.1 What is tappable

| Target | Element | Behaviour |
|---|---|---|
| Band pill | `button.pill[aria-expanded][aria-controls]` | Toggles its panel. Opening one closes the other four |
| Panel close | `button.panel-close` | Collapses to no panel |
| Item card in a panel | `button.card` (band-owned) | Selects, and mirrors to the map (section 3.3) |
| Disclosure inside a band | `details > summary` | Native, unchanged |
| Brand pill | `button#app-menu[aria-expanded][aria-controls="app-sheet"]` | Opens the menu sheet |
| Locate / recentre | `button#locate` | Requests a fix, or recentres on the last one |
| Zoom | `button#zoom-out`, `button#zoom-in` | ±1 integer zoom, clamped `[11, 17]`, 120 ms debounce on the tile request |
| Layer chip | `button.chip[aria-pressed][data-layer]` | Toggles one vector layer |
| Attribution link | `a` | Opens `openstreetmap.org/copyright` in a new tab |
| The map surface | `#map` | Drag to pan, wheel/pinch to zoom. Pointer only |
| Stop / POI marker | `span.map-marker[role="presentation"]` | Pointer only. Selects the stop and opens the Go band |

Minimum hit target 44 × 44 CSS px on every control in that table. The pills are
`8px 15px 8px 11px` around a 15 px label, which lands at 40 px tall; add
`min-height: 44px`. The `.btn-icon` is 36 px in the design system; override to
`44px` for the map controls and keep 36 px inside the panel where the target sits
in a dense list and is not a primary action. (The panel close button gets 44 px:
it is primary.)

### 3.2 What expands

One panel at a time, or none. Activating the pill of the open band collapses it,
which is the prototype's behaviour and the natural disclosure semantic.

Transition: `max-height` and `transform: translateY()` over 240 ms
`cubic-bezier(.2,.8,.25,1)`, suppressed entirely under
`prefers-reduced-motion: reduce` (the panel then simply appears).

The panel is **not modal**. The map keeps rendering, the pills stay reachable,
the chrome clusters stay reachable. There is no backdrop and no focus trap.

### 3.3 What the map does when a band expands

1. **The optical centre moves up.** The projection centres the position dot at
   `(h - dockHeight) / 2` rather than `h / 2`. Animated over the same 240 ms.
   This is why `--dock-height` exists. Without it the panel covers the dot on a
   phone, which is the one thing a "where am I" app must never do.
2. **The band's own layer is switched on**, honestly: the chip's `aria-pressed`
   flips to `true` and the user can switch it back off. Nothing is force-drawn
   behind a chip that says "off".

   | Band | Layer turned on |
   |---|---|
   | Here | `cell` and `sector` |
   | Around | POI markers (once CONTRACT 7.2 `p` ships); nothing before that |
   | Go | `stops` |
   | Now | none |
   | Zoom out | none |
3. **Selection is bidirectional.** Selecting a `li.go-stop` sets
   `map.select(key)`: the marker gets `data-selected`, gains its label, scales to
   1.06 and rises to `z-index: 6`. If the marker is outside the visible map rect
   (the rect above the dock), the map **pans** to bring it in. It never zooms:
   changing zoom under someone's finger is disorienting and it costs tiles.
   Selecting a marker sets the same key on the Go list, scrolls that row into
   view within the panel, and opens the Go band if it is closed.
4. **Nothing else.** Expanding a band never changes zoom, never re-requests
   tiles, never moves the map centre except for rule 1 and rule 3.

### 3.4 The chrome clusters

Both are `position: absolute; top: 0; padding: var(--space-4); z-index: 20;
pointer-events: none`, with `pointer-events: auto` on their children. Top-left is
`align-items: flex-start`, top-right is `align-items: flex-end`, both
`display: flex; flex-direction: column; gap: var(--space-2)`.

#### Top-left: the brand pill and the menu sheet

```html
<button type="button" class="brand" id="app-menu" aria-expanded="false" aria-controls="app-sheet">
  <span class="brand__mark"><svg …lucide map-pin…></svg></span>
  <span class="brand__word">BeHERE</span>
  <span class="brand__place">Bruxelles · 21004</span>
</button>
```

| Part | Value |
|---|---|
| pill | `display: flex; align-items: center; gap: 10px; border: 0; border-radius: 999px; padding: 9px 16px 9px 13px; background: var(--color-bg); box-shadow: var(--shadow-md)` |
| `.brand__mark` | 24 px circle, `background: var(--fill-accent-solid)` |
| the glyph | Lucide `map-pin`, 14 px, `fill: none`, `stroke: var(--color-bg)`, `stroke-width: 2.75`, round caps and joins |
| `.brand__word` | `var(--font-heading)`, 17 px, `line-height: 1` |
| `.brand__place` | 12 px, `color: var(--ink-muted)`, `max-width: 38vw`, ellipsis, `white-space: nowrap` |

**Changed from the prototype:** the mark circle was `var(--color-accent)` with a
`var(--color-bg)` glyph, 3.03:1. `--fill-accent-solid` is `--color-accent-700`,
5.72:1. One rule covers every solid-accent surface in the app: **any solid accent
fill that carries a cream label or a cream glyph uses `--fill-accent-solid`.**

The sheet it opens replaces the current `<footer class="app-foot">`, which has
nowhere to live on a full-bleed map:

```html
<div class="sheet" id="app-sheet" role="group" aria-labelledby="app-sheet-title" hidden>
  <h2 class="sheet__title" id="app-sheet-title">BeHERE</h2>

  <fieldset class="field">
    <legend>Interface language</legend>
    <div class="seg langs" role="group" aria-label="Language">
      <label class="seg-opt"><input type="radio" name="lang" value="nl"><span>nl</span></label>
      <label class="seg-opt"><input type="radio" name="lang" value="fr"><span>fr</span></label>
      <label class="seg-opt"><input type="radio" name="lang" value="en"><span>en</span></label>
      <label class="seg-opt"><input type="radio" name="lang" value="auto" checked><span>auto</span></label>
    </div>
  </fieldset>

  <p class="sheet__line"><span data-i18n="foot.vintage">Data vintage</span>
     <time class="vintage" id="foot-vintage" datetime="2025-01-01">2025-01-01</time> ·
     <span data-i18n="foot.built">built</span> <span class="vintage" id="foot-built">—</span></p>
  <p class="quiet" id="offline-stored" hidden></p>

  <details id="sources">
    <summary><span data-i18n="action.sources">Sources and vintages</span><span class="count" id="sources-count"></span></summary>
    <div class="disclosure-body"><ul id="sources-list">…</ul></div>
  </details>

  <p class="endonym" data-i18n="flag.endonym">Street and place names are shown in their official local language.</p>
</div>
```

Sheet box: `background: var(--color-bg); border-radius: var(--radius-lg);
box-shadow: var(--shadow-lg); padding: var(--space-3); width: 320px;
max-width: 78vw; max-height: min(70dvh, 640px); overflow-y: auto` with
`.bh-scroll`.

**The language switcher is the design system's `.seg`, unchanged.** It is native
radios with no script, `:has(input:checked)` gives it the accent fill,
`:has(input:focus-visible)` gives it the ring, `border-radius: 999px` from the
system's rounded-frame rule. Four options, `nl fr en auto`, matching the current
`.langs` group exactly. `main.js`'s `wireChrome()` binds
`$$(".langs button")` today; change that selector to
`$$(".langs input[name=lang]")` and the `change` event, and keep `setLanguage()`
and `paintChrome()` byte-for-byte otherwise. `paintChrome()`'s `aria-pressed`
loop becomes a `checked` assignment, which is the correct semantic for a radio
group and removes an ARIA misuse that exists today (`aria-pressed` on what is
really a single-select).

`auto` stays the default and stays the "follow the ground" option, so acceptance
test 5 is unchanged.

Ids `#foot-vintage`, `#foot-built`, `#offline-stored`, `#sources`,
`#sources-count`, `#sources-list` are all queried by `main.js`. **They keep their
ids.** Only their container moves.

#### Top-right: locate, zoom, layers, tile note

Vertical stack, right-aligned.

1. `p#locate-status`, the accuracy chip. `role="status" aria-live="polite"`,
   `border-radius: 999px; padding: 5px 12px; font-size: 11px; font-weight: 600;
   background: var(--color-bg); color: var(--ink-muted); box-shadow: var(--shadow-sm)`.
   `main.js` writes `"±12 m"` into it after every fix and the locate/denied copy
   before one, exactly as it does today.
2. `button#locate`: `.btn .btn-primary`, `border-radius: 999px`,
   `box-shadow: var(--shadow-md)`. Label `locate.action` ("Find where I am")
   before a fix; label `map.recentre` ("Back to where I am") once a fix exists
   and the map is off-centre. Hidden when a fix exists and the map is centred.
   Off-centre test, from the prototype: `|centreLat − fixLat| > 0.0008 ||
   |centreLon − fixLon| > 0.0012`.
   `.btn-primary` is `background: var(--color-accent); color: var(--color-bg)`
   in the design system, which is 3.03:1. **Override `.btn-primary` in `app.css`
   to `background: var(--fill-accent-solid)`**; hover `--color-accent-800`,
   active `--color-accent-900`.
3. The zoom cluster: one pill, `background: var(--color-bg); border-radius: 999px;
   padding: 5px; box-shadow: var(--shadow-md)`, holding
   `button#zoom-out .btn.btn-secondary.btn-icon`, the scale readout, and
   `button#zoom-in`. Both buttons `border-color: transparent`, glyphs `−` and `+`
   at 18 px in `currentColor` (`--color-text`, 13.95:1). `aria-label` from
   `map.zoom.out` / `map.zoom.in`; the glyphs are `aria-hidden="true"`.
   `disabled` at the clamp ends, which drops them to the system's 45% opacity.
4. The layer chips: `display: flex; flex-wrap: wrap; gap: 6px;
   justify-content: flex-end; max-width: 66vw`.

```html
<button type="button" class="chip" data-layer="cell" aria-pressed="true"
        title="The Statbel GRD_NEWID square, projected with grid.js">
  <span class="chip__swatch"></span>1 km cell
</button>
```

| Property | `aria-pressed="false"` | `aria-pressed="true"` |
|---|---|---|
| shape | `display: flex; align-items: center; gap: 7px; border: 0; border-radius: 999px; padding: 6px 12px; font-family: var(--font-body); font-size: 12px; font-weight: 600; box-shadow: var(--shadow-sm)` | same |
| `background` | `var(--color-bg)` | the layer ink |
| `color` | `var(--ink-muted)` | `var(--color-bg)` |
| `.chip__swatch` | 8 px circle, `background:` the layer ink | 8 px circle, `background: var(--color-bg)` |

| Chip | Layer ink token | Cream on it |
|---|---|---|
| `1 km cell` | `--ink-cell` = `--color-accent-2-700` | 5.43:1 |
| `Sectors` | `--ink-sector` = `--color-accent-700` | 5.72:1 |
| `Stops` | `--ink-stops` = `--color-accent-2-800` | 8.27:1 |

**Changed from the prototype**, which uses the `600` steps for the on-fill and
gets 3.53:1 and 3.77:1 on 12 px text. The chip ink is also the map ink, so the
chip is a real legend: the swatch you see in the chip is the stroke you see on
the ground. The prototype breaks that (chip `accent-2-600`, marker dot
`accent-2-600`, selected marker border `accent-2-700`); here the three inks are
one token each.

`title` attributes are the prototype's, as i18n keys `map.layer.*.title`. The
sector one is generalised from "from 21004/sector.geojson" to
`"2025 statistical sectors, from {nis}/sector.geojson"`.

### 3.5 The offline bar

`p#offline-bar` keeps its id, its `data-i18n="offline.bar"` and its `hidden`
toggling from `wireChrome()`. It moves to a full-width strip pinned under the top
chrome, `background: var(--fill-warn); color: var(--ink-on-warn);
border-radius: 999px; padding: 5px 14px; font-size: 12px; box-shadow: var(--shadow-sm)`,
centred, `z-index: 21`.

The iOS install hint `p#ios-hint` moves into the menu sheet.

### 3.6 Focus order, keyboard, and the focus ring

#### Tab order

DOM order is tab order. There is no positive `tabindex` anywhere in this app.

1. `a.skip`, "Skip to the bands", `href="#dock-panel"`. Visually hidden until
   `:focus-visible`, then a cream pill at the top-left with the standard ring.
2. `#map`, one stop (see below). It sits here, immediately after the skip link,
   because that is what the skip link is for: the first thing a keyboard user
   meets is the large interactive region, and the first thing they are offered
   is a way past it.
3. `a` in `p.map-attrib`. It follows `#map` because it is `#map`'s sibling in
   the markup, and it is `hidden` until a tile has actually been drawn, so on a
   tileless device it is not a stop at all.
4. `button#app-menu` (brand pill). When expanded, its sheet's controls follow:
   the four language radios (one tab stop, arrow keys within), the sources
   `<summary>`, then out.
5. `button#locate`. Itself conditional: hidden while the map is centred on the
   fix, revealed the moment a drag or an arrow key moves it off.
6. `button#zoom-out`, `button#zoom-in`.
7. `button.chip` × 3 (or the single collapsed chip below 560 px).
8. The pill row: **one tab stop**, roving `tabindex`. The pill with
   `aria-expanded="true"` holds `tabindex="0"`; if none is expanded, the first
   pill does. `ArrowLeft` / `ArrowRight` move the roving stop and scroll the
   pressed pill into view; `Home` / `End` jump to the ends; `Enter` / `Space`
   toggle. This is the disclosure pattern, not the tabs pattern, because
   collapsing to no panel at all is a real state here and the tabs pattern has no
   name for it.
9. `button.panel-close`, then the open `section.band`'s own content in its own
   DOM order (`details`, links, item buttons), all already accessible.

That is **ten tab stops before the first band**, and one more to reach the
panel's content. The skip link makes it two.

#### The map is operable and is still not a keyboard trap

`index.html` ships `#map` with `aria-hidden="true"` and no `tabindex`, which is
the correct state while the module is loading and the box is empty. `main.js`
mounts `map.js` with `keyboard: true`, and `map.js` then **removes**
`aria-hidden` and makes `#map` a `role="group"` with `tabindex="0"` and an
`aria-label` that names the keys. A focusable node inside an `aria-hidden`
subtree is an authoring error, so the two go together or not at all.

| Key | Effect |
|---|---|
| `ArrowLeft` / `ArrowRight` / `ArrowUp` / `ArrowDown` | pan 80 px |
| `+` / `=` and `-` / `_` | zoom one step, clamped 11..17 |
| `Home` | recentre on the current fix |

It is **one** tab stop, not 49: every marker stays a `<span
role="presentation">` inside an `aria-hidden` `.map-markers`, along with
`.map-tiles`, `.map-veil`, `svg.map-vectors` and `.map-position`. So the group
is named and enterable while its painted content stays decorative, and a screen
reader is never read the same stop twice, once as a marker and once as a Go row.

It cannot become a trap because `Tab` and `Escape` are never intercepted: the
`switch` in `map.js` `onKeyDown` handles seven keys and calls `preventDefault()`
only for those, and any modifier (`alt`, `ctrl`, `meta`) returns early so
browser and AT shortcuts survive.

The keyboard user therefore gets the map as a *convenience*, never as the only
path. Everything it draws still has a keyboard-reachable, text equivalent, and
that remains the primary route:

| On the map | The keyboard and screen-reader path |
|---|---|
| Where you are | The **Here** band: address, sector, municipality, hierarchy, postcodes, and the cell id |
| The 1 km cell outline | `p.sub[data-layer="position"]` in Here prints the `GRD_NEWID` |
| The sector polygon | The `sector` fact row in Here, with its name, code and simplification tolerance |
| Every stop marker | The **Go** band's `ol.go-stops`, in the same ascending-distance order, each a real control |
| Your accuracy circle | `here.accuracy`, "accurate to about {d}" |
| Pan and zoom | `button#zoom-out`, `button#zoom-in`, `button#locate`, and the arrow keys on the map itself |
| The map's state after any change | `p.sr-only[role="status"]`, one polite announcement: `"Map at {m} m per 100 pixels, centred on your position."` |

Feedback for the arrow keys is the same feedback a pointer drag gets, and no
more: panning off-centre reveals `button#locate` ("Back to where I am"), which
is hidden while the map is centred, so the way back is always one Tab away. The
status region re-announces on zoom and on recentre, where the metres-per-100-px
figure actually changes; it deliberately does **not** re-announce identical text
after every arrow press, which would be a live-region that never shuts up.

`Escape` inside the panel collapses it and returns focus to the pill that opened
it. `Escape` inside the menu sheet closes it and returns focus to the brand pill.
Opening a band moves focus to `section.band[tabindex="-1"]` so the next `Tab`
lands in the content rather than back at the top of the page.

#### The `:focus-visible` ring

```css
:focus { outline: none }
:focus-visible {
  outline: 3px solid var(--focus-ring);
  outline-offset: 2px;
  border-radius: inherit;
}
```

`--focus-ring` = `--color-accent-700` light / `--color-accent-400` dark.

The design system ships `2px solid var(--color-accent)`. That measures 3.03:1 on
the cream ground, which passes SC 1.4.11 by 0.03, and falls to **1.31:1** where a
ring lands beside the map. `--color-accent-700` measures **5.72:1** on cream and
**at worst 4.37:1** over every washed tile fill in section 1.2; the dark
`--color-accent-400` measures **8.80:1**. Three pixels rather than two because
Organic's radii are large and a 2 px ring on a 999 px pill reads thin.

`.input:focus-visible` keeps the system's `outline-offset: 0` and its accent
border. `.seg-opt:has(input:focus-visible)` keeps `outline-offset: -2px` so the
ring stays inside the segmented control's own rounded frame.

---

## 4. COMPONENT MAPPING

### 4.1 Shell

| Today | Replacement | Notes |
|---|---|---|
| `header.app-bar` + `h1 Be<b>HERE</b>` | `button#app-menu.brand` | The wordmark becomes a control. `--font-heading` at 17 px |
| `.langs` + 4 `button[aria-pressed]` | `.seg` + 4 `.seg-opt` with native radios | Design system component, no script. Fixes the `aria-pressed`-on-single-select misuse |
| `.status` + `#locate.btn` + `#locate-status` | `button#locate.btn.btn-primary` + `p#locate-status` chip | Same ids, top-right cluster |
| `.offline-bar` | Same class, `--fill-warn` / `--ink-on-warn` pill | |
| `.ios-hint`, `.notice` | Moved into the menu sheet as `p.quiet` notes | |
| `main > section.band` × 5 | The same five sections inside `#dock-panel`, one visible | `data-band` and `data-state` unchanged |
| `.band > header > h2` + `p.band-status` | `.panel-title` + `.panel-kicker`, one instance driven by `dock.js` | Removes five duplicate headings |
| `.band-body[data-role="body"]` | Unchanged | The band modules' mount point |
| `p.src[data-role="src"]` | Unchanged, restyled | Acceptance test 8 |
| `footer.app-foot` | The menu sheet | Same ids inside |
| `details#sources` + `.disclosure-body` | Design system `details` + `.disclosure-body`, `border-radius: var(--radius-md)` | |

### 4.2 Band vocabulary

`app.css` today defines the class vocabulary that all five band modules emit. Not
one class name changes; only their rules do.

| Class | Organic mapping |
|---|---|
| `.answer` | `var(--font-heading)`, 22 px, `color: var(--color-text)` |
| `.house` | `var(--font-body)`, 700, inherits |
| `.name` | inherits; keeps its `lang` attribute |
| `.code` | `font-variant-numeric: tabular-nums`, `font-feature-settings: "tnum"`, `color: var(--ink-muted)`, `background: var(--fill-quiet)`, `border-radius: var(--radius-sm)`, `padding: 0 5px` |
| `.measure` | tabular-nums, `color: var(--ink-muted)` |
| `.sub` | 13 px, `color: var(--ink-muted)` |
| `.quiet` | the **note, quiet tone** of section 2.3 |
| `.asof`, `.now-asof`, `.go-asof` | the **note, warn tone** |
| `.facts` (`dl`/`dt`/`dd`) | the **field row** |
| `.rows`, `.around-list`, `.go-stops`, `.now-items` | `list-style: none`, `display: flex; flex-direction: column; gap: var(--space-2)` |
| `.around-item`, `.go-stop`, `.now-item` | the **item card** |
| `.around-layer` (`details`) | `.card` shape: `background: var(--fill-card)`, `border-radius: var(--radius-md)`, `padding: var(--space-3)` |
| `.around-layer__summary` | `display: flex; align-items: center; gap: var(--space-2); cursor: pointer` |
| `.around-layer__count` | `.tag .tag-neutral` |
| `.around-layer--empty`, `--absent` | `background: transparent`, `border: 1px solid var(--color-divider)`, summary in `--ink-muted` |
| `.around-layer--failed` | `background: var(--fill-warn)`, summary in `--ink-on-warn` |
| `.around-item__cat`, `.around-src__name` | `.tag .tag-neutral` |
| `.go-op` | `.tag .tag-accent-2` |
| `.go-delay[data-delay="late"]` | `.tag .tag-accent`, ink `--color-accent-800` (8.37:1) |
| `.go-cancelled` | `text-decoration: line-through`, `color: var(--ink-muted)` |
| `.go-time`, `.go-rel`, `.now-when`, `.around-item__dist` | tabular-nums |
| `.now-open[data-open="open"]` | `.tag .tag-accent-2` |
| `.now-open[data-open="closed"]` | `.tag .tag-neutral` |
| `.now-open[data-open="unknown"]` | `.tag .tag-neutral` with `border: 1px dashed var(--color-neutral-500)`. **Not a warning**: a source that publishes hours as prose has not failed |
| `.now-raw` | `font-style: italic`, `color: var(--ink-muted)`, full-width row |
| `.stats` | `display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: var(--space-2)` |
| `.stats li` | `.card`: `background: var(--fill-card)`, `border-radius: var(--radius-md)`, `padding: var(--space-3)` |
| `.stats .v` | `var(--font-heading)`, 25 px |
| `.stats .k` | `.card-meta`: 11 px, `color: var(--ink-muted)` |
| `.stats .stat--withheld` | `background: transparent`, `border: 1px dashed var(--color-divider)`, no `.v` |
| `.untranslated` (`sup`) | `color: var(--ink-accent)`, `font-size: .7em`, `cursor: help`, keeps `title` and `aria-label` |
| `.around-flag` (`sup`) | same |
| `.endonym` | 11.5 px, `color: var(--ink-muted)`, `padding-top: var(--space-2)` |
| `.src` | 11.5 px, `color: var(--ink-muted)` |
| `.vintage` | tabular-nums |
| `.go-alert` | `background: var(--fill-quiet)`, `border-radius: var(--radius-md)`, `padding: var(--space-3)` |
| `.disclosure-body` | `padding-top: var(--space-2)` |
| `details > summary::before` | Keep the existing rotating triangle, redrawn in `currentColor` |

### 4.3 What Organic has no component for

Five gaps. Each is built from Organic primitives; none introduces a parallel
system, and each is named so the design system could absorb it later.

| Gap | Built from | Rule |
|---|---|---|
| **`.pill`**, a floating map-overlay toggle carrying a label, a subtitle and a state dot | `.btn` geometry + the `border-radius: 999px` rounded-frame rule + `--shadow-sm/md` + a `.tag`-sized swatch | It is a `.btn` with a two-line body and a leading dot. It reuses `.btn`'s hover and pressed ramp steps verbatim. It exists because Organic's `.btn` is single-line and the dock needs a label plus a live count |
| **`.chip`**, a two-state legend toggle whose "on" fill *is* the map ink | `.tag` type scale + `.btn` interaction states + `aria-pressed` | Organic's `.tag` is a static label with no pressed state; `.btn-secondary` has states but no swatch. The chip is `.tag`'s size with `.btn`'s states and a 8 px `border-radius: 999px` swatch |
| **`.dock-panel`**, a bottom sheet that is not modal | `.card` (`background: var(--color-surface)` → here `--color-bg`), `--radius-lg` on two corners, `--shadow-lg` | Organic ships `.dialog` + `.dialog-backdrop`, which is modal and centred. A map sheet must not trap focus and must not dim the map, so it takes `.dialog`'s box and drops the backdrop |
| **`.map-marker`**, a pill-shaped map label | the `border-radius: 999px` frame rule + `--shadow-sm/lg` + `--color-bg` fill | Structurally a `.tag` that can grow a leading dot and a shadow. Not a `.btn`, because it is `role="presentation"` |
| **`.sheet`**, a non-modal popover anchored to a control | `.card` at `--radius-lg` + `--shadow-lg` | Same argument as `.dock-panel`: `.dialog` is the right box, the wrong behaviour |

Two smaller notes:

- Organic gives `.washed` as the image treatment. A raster basemap **is** an
  image layer, so the light `--tile-filter` is `.washed`'s filter verbatim. It is
  expressed as a token rather than the class only because the dark theme needs a
  different value.
- Organic gives `.hr` and tells you not to use it. This spec never does. Every
  separation is whitespace, a `--color-divider` hairline on a field row, or a
  card edge.

---

## 5. TOKENS

### 5.1 The semantic layer

The prototype writes ramp steps directly into inline styles
(`var(--color-neutral-600)` as body text, and so on). That cannot survive a dark
theme, where the same step is on the wrong side of the ground. So `app.css`
defines a thin semantic layer over Organic's ramps. **No new colours are
invented** except the two dark ramp extensions in 5.3, which are derived from the
neutral ramp's own OKLCH ladder.

| Token | Light | Dark |
|---|---|---|
| `--ink` | `var(--color-text)` | `var(--color-neutral-100)` |
| `--ink-muted` | `var(--color-neutral-700)` | `var(--color-neutral-300)` |
| `--ink-quiet` | `var(--color-neutral-600)` | `var(--color-neutral-400)` |
| `--ink-accent` | `var(--color-accent-700)` | `var(--color-accent-300)` |
| `--fill-quiet` | `var(--color-neutral-200)` | `var(--color-neutral-800)` |
| `--ink-on-quiet` | `var(--color-neutral-800)` | `var(--color-neutral-200)` |
| `--fill-warn` | `var(--color-accent-200)` | `var(--color-accent-800)` |
| `--ink-on-warn` | `var(--color-accent-900)` | `var(--color-accent-200)` |
| `--fill-card` | `var(--color-surface)` | `var(--color-neutral-900)` |
| `--fill-card-selected` | `var(--color-accent-100)` | `var(--color-accent-900)` |
| `--fill-accent-solid` | `var(--color-accent-700)` | `var(--color-accent-400)` |
| `--ink-on-accent-solid` | `var(--color-bg)` | `var(--color-bg)` |
| `--focus-ring` | `var(--color-accent-700)` | `var(--color-accent-400)` |
| `--ink-cell` | `var(--color-accent-2-700)` | `var(--color-accent-2-300)` |
| `--ink-sector` | `var(--color-accent-700)` | `var(--color-accent-300)` |
| `--ink-stops` | `var(--color-accent-2-800)` | `var(--color-accent-2-200)` |
| `--tile-filter` | `saturate(.6) contrast(.85) brightness(1.1) opacity(.94)` | `saturate(.55) contrast(1.05) brightness(.55) opacity(.94)` |
| `--tile-alpha` | `0.62` | `0.62` |

`--ink-quiet` is used **only** for non-text purposes (the hollow pill dot's ring,
a dashed border). It never carries body copy in the light theme: at 3.61:1 it
would fail AA. See section 7.4, row F4.

### 5.2 Theme switching

```css
:root { color-scheme: light dark; /* light tokens */ }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { /* dark tokens */ } }
:root[data-theme="dark"] { /* dark tokens */ }
```

There is **no theme toggle**. The app follows the system, as it does today. One
fewer control on a crowded map and one fewer preference to persist. The
`[data-theme]` hooks exist so a toggle can be added later without restructuring.

`<meta name="theme-color">`: light `#f5ead8`, dark `#1c140c`.

### 5.3 The dark ground, derived not invented

Organic's neutral ramp is generated in OKLCH on one lightness ladder:

```
100 L .969 · 200 L .930 · 300 L .870 · 400 L .780 · 500 L .680
600 L .580 · 700 L .479 · 800 L .381 · 900 L .290
```

The step at the dark end is ~0.091. Two further rungs continue that ladder with
the chroma **held rather than decayed**, because the Organic guide's own rule is
"do not desaturate the palette into greys, warmth is the point" and the neutral
ramp's chroma is already falling toward grey at the 900 end:

| New token | OKLCH | Hex | Role |
|---|---|---|---|
| `--color-neutral-950` | `L .199 C .020 H 68` | `#1c140c` | the dark theme's `--color-bg`, a deep coffee brown |
| `--color-neutral-1000` | `L .105 C .016 H 61` | `#070301` | the dark theme's shadow ink only |

Dark role tokens:

```
--color-bg:      var(--color-neutral-950)   #1c140c
--color-surface: var(--color-neutral-900)   #2e2b25
--color-text:    var(--color-neutral-100)   #f9f4ed
--color-accent:  var(--color-accent-400)    #f6a06b
--color-accent-2:var(--color-accent-2-400)  #aebf92
--color-divider: color-mix(in srgb, var(--color-neutral-100) 20%, transparent)
```

`--color-accent` moves to the `400` step in dark because that is the Organic
guide's own instruction for a dark ground.

Dark elevation, per the guide's "a hairline edge plus ambient darkness on a dark
one":

```
--shadow-sm: 0 0 0 1px color-mix(in srgb, var(--color-neutral-400) 22%, transparent),
             0 1px 2px  color-mix(in srgb, var(--color-neutral-1000) 55%, transparent);
--shadow-md: 0 0 0 1px color-mix(in srgb, var(--color-neutral-400) 24%, transparent),
             0 3px 10px color-mix(in srgb, var(--color-neutral-1000) 60%, transparent);
--shadow-lg: 0 0 0 1px color-mix(in srgb, var(--color-neutral-400) 26%, transparent),
             0 12px 32px color-mix(in srgb, var(--color-neutral-1000) 66%, transparent);
```

The hairline in `--shadow-sm` is load-bearing: it is what separates a marker pill
from the darkened basemap now that the marker's idle border is transparent.

### 5.4 Type

| Role | Token | Where |
|---|---|---|
| Display | `--font-heading` (Caprasimo 400) | `.brand__word`, `.pill__label`, `.panel-title`, `.answer`, `.stats .v`, `h1`–`h4`, and the design system's `.btn` |
| Body | `--font-body` (Figtree 400/600/700) | everything else |

Sizes are the prototype's, unrounded, because they are already tuned against the
1.10× density baked into `--space-*`: 26 (panel title), 22 (`.answer`), 17
(brand), 15 (pill label, item name), 14.5 (fact value), 14 (note body), 13.5,
13, 12.5, 12, 11.5, 11, 10.5, 10.

`text-wrap: pretty` on every prose paragraph; `text-wrap: balance` on
`.panel-title` and `.answer`. `font-variant-numeric: tabular-nums` everywhere a
number can change under the reader: distances, times, delays, counts, coordinates,
postcodes, NIS codes, cell ids.

`html { -webkit-text-size-adjust: 100% }` stays. `user-select: none` is set on
the map and the chrome, and explicitly **unset** (`user-select: text`) on
`.panel-body`, because a NIS code and a cell id are things people copy.

---

## 6. FONTS: self-hosting Caprasimo and Figtree

The design system's `styles.css` opens with
`@import url('https://fonts.googleapis.com/css2?…')`. **That line is deleted in
`web/ds/organic.css`.** It is a third-party request from a public civic app, it
would need a CSP `style-src`/`font-src` exception, and it breaks offline.

Both faces are OFL-1.1, so vendoring is clean. Ship the licence text with them.

```
web/fonts/
  caprasimo-latin.woff2          U+0000-00FF, U+0131, U+0152-0153, …
  caprasimo-latin-ext.woff2      U+0100-02BA, …
  figtree-latin.woff2            variable, wght 400..700
  figtree-latin-ext.woff2        variable, wght 400..700
  OFL.txt                        the SIL Open Font License 1.1 text, verbatim
```

**`latin-ext` is not optional.** Belgian authored names carry `è é ê ë ï ô û ç`
and, in the German-speaking Community, `ä ö ü ß`. Dropping the extended range
would tofu `Liège`, `Sint-Job-in-'t-Goor` and `Büllingen`.

```css
@font-face {
  font-family: "Caprasimo"; font-style: normal; font-weight: 400;
  font-display: swap; src: url("../fonts/caprasimo-latin.woff2") format("woff2");
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA,
    U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193,
    U+2212, U+2215, U+FEFF, U+FFFD;
}
/* …the latin-ext twin, and the two Figtree faces with font-weight: 400 700… */
```

- `font-display: swap`, so a slow font never delays "where am I".
- Fallback stack stays the design system's: `system-ui, sans-serif`.
- The four woff2 files go in `sw.js`'s `SHELL_REQUIRED`. A missing font must fail
  the install loudly rather than ship a silent system-font build, and
  `scripts/test_sw_offline.mjs` runs the real install against disk, so a typo in
  a path fails CI.
- **They do not count against the 3 MB budget.** The gate in
  `.github/workflows/deploy.yml` walks `web/data` only (`ROOT = "web/data"`), as
  does `bake.py`'s `BUDGET_MAX_GZ`. Acceptance test 10 is about shipped *data*.
  Expect roughly 60–80 KB of woff2 in total, in the shell cache.
- `scripts/ghpages_preflight.py` only flags `http://` references, so vendored
  fonts pass it unchanged.

---

## 7. ACCESSIBILITY

### 7.1 Method

Every ratio below is WCAG 2.x relative luminance,
`(L1 + 0.05) / (L2 + 0.05)`, computed from the token hex values. Thresholds
applied: **4.5:1** for text under 18.66 px (or under 14 px bold), **3:1** for
text at or above that and for non-text UI components and meaningful graphics
(SC 1.4.11), **3:1** for focus indicators.

Where a graphic sits over the basemap, the ground used is not the raw OSM colour
but the **effective** colour after `--tile-filter`, the 0.583 composite alpha and
the 18% veil, computed in section 1.2. That is the colour a user actually sees.

### 7.2 Light theme, text on ground

| # | Foreground | Ground | Ratio | Verdict |
|---|---|---|---|---|
| 1 | `--color-text` `#201e1d` | `--color-bg` `#f5ead8` | **13.95:1** | pass |
| 2 | `--ink-muted` `--color-neutral-700` `#645c50` | `--color-bg` | **5.53:1** | pass |
| 3 | `--ink-accent` `--color-accent-700` `#8c491a` | `--color-bg` | **5.72:1** | pass |
| 4 | `--color-text` | `--fill-card` `--color-surface` `#ebddc5` | **12.40:1** | pass |
| 5 | `--ink-muted` | `--fill-card` | **4.92:1** | pass |
| 6 | `--ink-on-quiet` `#474238` | `--fill-quiet` `#eee7db` | **8.12:1** | pass |
| 7 | `--ink-muted` | `--fill-quiet` | **5.36:1** | pass |
| 8 | `--ink-on-warn` `#402310` | `--fill-warn` `#ffe1d0` | **11.55:1** | pass |
| 9 | `--color-accent-800` `#643312` | `--fill-warn` | **8.37:1** | pass |
| 10 | `--color-accent-2-800` `#3d472b` | `--color-accent-2-200` `#e1eecc` | **8.11:1** | pass |
| 11 | `--color-text` | `--fill-card-selected` `#fff2eb` | **15.14:1** | pass |
| 12 | `--ink-muted` | `--fill-card-selected` | **6.01:1** | pass |
| 13 | `--ink-on-accent-solid` `#f5ead8` | `--fill-accent-solid` `#8c491a` | **5.72:1** | pass |
| 14 | `--color-accent-100` `#fff2eb` | `--fill-accent-solid` | **6.21:1** | pass |
| 15 | `--ink-on-accent-solid` | `--ink-cell` `#56633f` | **5.43:1** | pass |
| 16 | `--ink-on-accent-solid` | `--ink-stops` `#3d472b` | **8.27:1** | pass |
| 17 | `--ink-accent` | `--fill-card` | **5.09:1** | pass |
| 18 | `--ink-accent` | `--fill-quiet` | **5.54:1** | pass |
| 19 | `--ink-on-quiet` `#474238` | `--fill-card` | **7.45:1** | pass |
| 20 | `--ink-on-quiet` | `--fill-card-selected` | **9.10:1** | pass |

### 7.3 Light theme, non-text and graphics (3:1)

| # | Graphic | Ground | Ratio | Verdict |
|---|---|---|---|---|
| 21 | `--focus-ring` `#8c491a` | `--color-bg` | **5.72:1** | pass |
| 22 | `--focus-ring` | worst washed tile fill (motorway `#e5c9c4`) | **4.37:1** | pass |
| 23 | `--ink-sector` (both widths) | worst washed tile fill | **4.37:1** | pass |
| 24 | `--ink-cell` dashed stroke | worst washed tile fill | **4.15:1** | pass |
| 25 | `--ink-stops` marker dot | `--color-bg` pill | **8.27:1** | pass |
| 26 | selected item border `--color-accent-600` `#b2622d` | `--color-bg` panel | **3.77:1** | pass |
| 27 | position-dot hairline `--color-accent-900` `#402310` | worst washed tile fill | **9.20:1** | pass |
| 28 | pill state dot filled `--ink-cell` | `--color-bg` pill | **5.43:1** | pass |
| 29 | pill state dot ring `--ink-quiet` `#82796a` | `--color-bg` pill | **3.61:1** | pass |
| 30 | `.tag-outline` border `--color-accent` `#c67139` | `--color-bg` | **3.03:1** | pass, just |

Full per-fill table for rows 22 to 24, over the effective washed grounds:

| ink | land | wood | grass | water | building | road | motorway |
|---|---|---|---|---|---|---|---|
| `--color-accent-700` | 5.96 | 5.01 | 5.64 | 5.14 | 5.30 | 6.23 | **4.37** |
| `--color-accent-2-700` | 5.65 | 4.75 | 5.35 | 4.87 | 5.03 | 5.91 | **4.15** |
| `--color-accent-600` (prototype) | 3.93 | 3.30 | 3.72 | 3.39 | 3.49 | 4.11 | **2.88 fail** |
| `--color-accent-2-600` (prototype) | 3.68 | 3.09 | 3.48 | 3.17 | 3.27 | 3.85 | **2.70 fail** |

### 7.4 Pairs that FAILED, and what they were changed to

Nine. Every one comes from the prototype or from an unmodified design-system
default, and every replacement is a step on the same ramp.

| # | Where | Prototype pair | Measured | Replaced with | Now |
|---|---|---|---|---|---|
| F1 | Band pill, expanded: label and count | `--color-bg` on `--color-accent` | **3.03:1** | `--ink-on-accent-solid` on `--fill-accent-solid` (`--color-accent-700`) | **5.72:1** |
| F2 | Band pill, resting: count | `--color-text` at `opacity: .6` | **4.13:1** | drop the opacity, `color: var(--ink-muted)` | **5.53:1** |
| F3 | Band pill, expanded: count | `--color-bg` at `opacity: .85` | **4.63:1** | drop the opacity, `color: var(--color-accent-100)` | **6.21:1** |
| F4 | Fact key, places coord, source line, item distance, tile note | `--color-neutral-600` on `--color-bg` | **3.61:1** | `--ink-muted` (`--color-neutral-700`) | **5.53:1** |
| F5 | Item state tag, secondary text on a neutral tint | `--color-neutral-600` on `--color-neutral-200` | **3.49:1** | `--ink-muted` on `--fill-quiet` | **5.36:1** |
| F6 | `.tag-outline` label (source tag, place badge) | `--color-accent` on `--color-bg` | **3.03:1** | `color: var(--ink-accent)`, border unchanged | **5.72:1** |
| F7 | Layer chip, on state | `--color-bg` on `--color-accent-2-600` (cell) and `--color-accent-600` (sectors) | **3.53:1** / **3.77:1** | `--ink-cell` (`accent-2-700`) and `--ink-sector` (`accent-700`) | **5.43:1** / **5.72:1** |
| F8 | Selected item-card border | `--color-accent-500` 1px on `--color-bg` | **2.52:1** | `--color-accent-600` 2px | **3.77:1** |
| F9 | Pill state dot | `--color-accent-2-500` (2.37:1) and `--color-neutral-400` (1.68:1) on `--color-bg` | **2.37:1 / 1.68:1** | filled `--ink-cell`, or hollow with a `--ink-quiet` inset ring | **5.43:1 / 3.61:1** |

Three more that fail only against the **basemap**, not against the cream ground,
and are therefore listed separately because the fix is the same promotion:

| # | Where | Prototype | Worst measured over a washed tile | Replaced with | Now |
|---|---|---|---|---|---|
| F10 | 1 km cell stroke | `--color-accent-2-600` | **2.70:1** | `--ink-cell` (`--color-accent-2-700`) | **4.15:1** |
| F11 | Current-sector stroke | `--color-accent-600` | **2.88:1** | `--ink-sector` (`--color-accent-700`) | **4.37:1** |
| F12 | Idle-sector stroke; accuracy circle stroke | `--color-accent-300` (1.27:1 on cream) and `--color-accent-400` (1.74:1 on cream) | **1.03:1** | both to `--ink-sector`; the distinction moves to stroke width and fill alpha, and the accuracy ring becomes `3 4` dashed | **4.37:1** |

And one design-system default changed for the same reason:

| # | Where | Default | Measured | Replaced with | Now |
|---|---|---|---|---|---|
| F13 | `:focus-visible` ring | `2px solid var(--color-accent)` | **3.03:1** on cream, **1.31:1** beside the map | `3px solid var(--focus-ring)` (`--color-accent-700`) | **5.72:1** on cream, **4.37:1** worst over a tile |

The Organic guide's own warning is confirmed by measurement: `--color-accent`
against `--color-bg` is **3.03:1**, which is enough for icons, large text and
interface chrome and is not enough for body copy. **Every occurrence of accent
as body copy in this spec uses `--color-accent-700`.** `--color-accent` survives
in exactly three places, all non-text: the position dot fill, its pulse, and the
`.tag-outline` border.

### 7.5 Dark theme

| Foreground | Ground | Ratio |
|---|---|---|
| `--ink` `#f9f4ed` | `--color-bg` `#1c140c` | **16.62:1** |
| `--ink-muted` `#dcd3c4` | `--color-bg` | **12.26:1** |
| `--ink-quiet` `#c0b6a5` | `--color-bg` | **9.07:1** |
| `--ink-accent` `#ffc6a5` | `--color-bg` | **12.01:1** |
| `--ink-on-accent-solid` `#1c140c` | `--fill-accent-solid` `#f6a06b` | **8.80:1** |
| `--ink-on-quiet` `#eee7db` | `--fill-quiet` `#474238` | **8.12:1** |
| `--ink-muted` | `--fill-quiet` | **6.73:1** |
| `--ink-on-warn` `#ffe1d0` | `--fill-warn` `#643312` | **8.37:1** |
| `--color-accent-2-200` | `--color-accent-2-800` | **8.11:1** |
| `--ink` | `--fill-card` `#2e2b25` | **12.89:1** |
| `--ink-muted` | `--fill-card` | **9.51:1** |
| `--ink-quiet` | `--fill-card` | **7.04:1** |
| `--ink` | `--fill-card-selected` `#402310` | **13.09:1** |
| `--focus-ring` `#f6a06b` | `--color-bg` | **8.80:1** |
| `--focus-ring` | `--fill-card` | **6.83:1** |
| `--ink-sector` `#ffc6a5` | worst dark-washed tile | **5.53:1** |
| `--ink-cell` `#ccdbb2` | worst dark-washed tile | **5.71:1** |
| `--ink-stops` `#e1eecc` | worst dark-washed tile | **6.89:1** |

**No dark pair fails.** The dark theme has more headroom than the light one,
which is expected: a deep ground gives every ramp step room to breathe.

### 7.6 Beyond contrast

- **Colour is never the only channel.** The pill state dot is filled or hollow
  *and* its meaning is in `.pill__count` as words. `.now-open` states carry text
  ("Open now", "Opening hours not published"), not just a tint. `.go-delay`
  carries `+3 min`, not just a colour. `.around-layer--empty/--absent/--failed`
  each carry a sentence.
- **The `--color-divider` hairline is 1.37:1 against the cream ground and is
  never load-bearing.** Every component it outlines is identified by its text
  label, which passes 4.5:1. Where the border carries *state* (selected item),
  it is promoted to `--color-accent-600` at 3.77:1 and backed by `aria-current`.
- **Target size** 44 × 44 CSS px on every map control, every band pill and the
  panel close. Item cards inside a list are full-width and at least 44 px tall.
- **Motion** respects `prefers-reduced-motion: reduce`: the position pulse
  stops, the panel transition disappears, the marker scale transition is removed,
  the map's centre offset snaps.
- **Announcements.** `#locate-status` is `role="status" aria-live="polite"` and
  already carries the accuracy and the denied/unavailable copy. One more polite
  status region reports map changes (section 3.6). Nothing is `aria-live="assertive"`.
- **Language.** `document.documentElement.lang` is set by `paintChrome()` today
  and keeps being set. Every authored name keeps its own `lang` attribute:
  `here.js` sets `lang` on `span.name`, `go.js` on `h3.go-name`, `around.js` on
  `.around-item__name` and `.around-item__detail`. That is what tells a screen
  reader to pronounce `Kruidtuin` in Dutch inside a French interface, and it is
  why street names are never translated.
- **Reduced transparency.** Under `prefers-contrast: more`, drop the veil to
  0/0/0, set `--tile-alpha: 0.35`, and give `.map-attrib` and every floating pill
  an opaque `--color-bg` with a `1px solid var(--ink-muted)` edge.
- **Zoom.** The layout must survive 320 px width at 200% page zoom and
  `text-spacing` overrides. Nothing has a fixed height; the panel uses
  `max-height` and scrolls; the pill row scrolls horizontally.

---

## 8. THE ACCEPTANCE TESTS, RE-CHECKED

| Test | Effect of the revamp |
|---|---|
| 1. Cold start, airplane mode, Here resolves | Unaffected. `scripts/test_sw_offline.mjs` is headless over `sw.js` and `geo.js`; it never sees the map. Tile failure degrades to the vector layers, and Here reads baked shards either way |
| 2. Postcode 1000 never resolves to a municipality | Unaffected. `here.js`'s rule and its `here.postcodes.note` copy both survive |
| 3. Pre-2025 statistic passes the history table or is refused | Unaffected. `zoom.js` and `stats.js` untouched; `.stats .stat--withheld` keeps its own styling |
| 4. No blank string; untranslated strings are marked | `sup.untranslated` and `UNTRANSLATED_MARK` untouched. `scripts/check_i18n.py` gains the new keys in section 10.2 and must pass in `en`, `nl` and `fr` |
| 5. UI language defaults from the municipality, override persists | Unaffected in logic. The `.langs` control becomes a `.seg` radio group; `setLanguage()` and `i18n.setUiLang()` are unchanged |
| 6. Around returns results in Ottignies-LLN | Unaffected |
| 7. No key, token or credential in the built output | Unaffected. The tile URL is keyless and carries no query string |
| 8. Every layer shows its source and its vintage | Unaffected. `setSources()` still writes `p.src[data-role="src"]`, which is now the last row of the panel body. The map gains its own attribution, which is a further source line |
| 9. Geolocation debounced, live results cached 30–60 s, no polling | Unaffected, and extended: zoom is debounced 120 ms, tiles are cache-first for 7 days, no tile is ever requested speculatively |
| 10. Total shipped data under 3 MB gzipped | Unaffected. The gate walks `web/data`; fonts and the new modules live outside it |

Existing suite, all of which must stay green:
`scripts/test_sw_offline.mjs`, `scripts/test_stats.mjs`,
`scripts/test_i18n_marker.mjs`, `scripts/test_zoom.mjs`,
`python3 scripts/gen_precache.py --check`, `python3 scripts/check_i18n.py`,
`python3 scripts/ghpages_preflight.py ./web --repo-name behere`.

Two new CI checks, both stdlib greps, in the tile section of 1.2.

---

## 9. HOW TO REPRODUCE EVERY NUMBER

```python
# WCAG relative luminance and contrast, from a hex pair.
def lin(c):
    c /= 255
    return c/12.92 if c <= 0.04045 else ((c+0.055)/1.055) ** 2.4
def lum(h):
    r, g, b = (int(h.lstrip('#')[i:i+2], 16) for i in (0, 2, 4))
    return 0.2126*lin(r) + 0.7152*lin(g) + 0.0722*lin(b)
def ratio(a, b):
    l1, l2 = sorted((lum(a), lum(b)), reverse=True)
    return (l1 + 0.05) / (l2 + 0.05)
```

The washed tile grounds in 1.2 and 7.3 are produced by applying the CSS filter
functions in `--tile-filter` in order, in sRGB, per the Filter Effects spec
(`saturate` matrix, then `contrast: v*c + (0.5 - 0.5c)`, then `brightness: v*b`),
compositing the result over `--color-bg` at `0.62 * 0.94`, then mixing 18% of
`--color-bg` over that for the veil.

The two dark ramp rungs in 5.3 are produced by the standard sRGB → OKLab → OKLCH
transform, extending the neutral ramp's lightness ladder by one step and holding
the chroma.

---

## 10. WORK ITEMS

### 10.1 Files

**New**

```
web/ds/organic.css               tokens + components, no @import, with @font-face
web/fonts/*.woff2, OFL.txt       Caprasimo, Figtree, latin + latin-ext
web/app/map.js                   projection, tiles, vector layers, markers, position
web/app/dock.js                  pills, panel, expand/collapse, focus
```

**Changed**

```
web/index.html                   new shell, CSP img-src, same ids
web/app/app.css                  rewritten on tokens, same selectors
web/app/grid.js                  + laeaInverse(), + cellRing()
web/app/main.js                  boots map.js and dock.js; .langs selector change
web/sw.js                        behere-tiles-v1, tile route, LRU 300, fonts in SHELL_REQUIRED
web/manifest.webmanifest         theme_color #f5ead8, background_color #f5ead8
scripts/gen_icons.py             FIELD = (0x8C,0x49,0x1A), MARK = (0xF5,0xEA,0xD8)
web/offline.html, web/404.html   restyled on the same tokens
web/data/i18n/{en,nl,fr}.json    new keys below
PLAN.md                          section 6 screen-model correction
```

### 10.2 New i18n keys

All must land in `en.json`, `nl.json` and `fr.json` or
`python3 scripts/check_i18n.py` fails the build.

```
map.label            "Map of where you are"
map.scale            "{m} m per 100 pixels"
map.zoom.in          "Zoom in"
map.zoom.out         "Zoom out"             (see note)
map.recentre         "Back to where I am"
map.status           "Map at {m} m per 100 pixels, centred on your position."
map.tiles.live       "Tiles: openstreetmap.org · live"
map.tiles.none       "No tiles. Everything drawn is baked on this device."
map.layer.cell       "1 km cell"
map.layer.sector     "Sectors"
map.layer.stops      "Stops"
map.layer.cell.title    "The Statbel GRD_NEWID square, projected with grid.js"
map.layer.sector.title  "2025 statistical sectors, from {nis}/sector.geojson"
map.layer.stops.title   "Baked NAP GTFS stops from the loaded shard"
map.layers.collapsed "{n} layers"

menu.open            "BeHERE menu"
menu.language        "Interface language"
panel.close          "Close"
skip.bands           "Skip to the bands"

pill.idle            "waiting for a position"
pill.none            "nothing baked"
pill.here.nis        "NIS {nis}"
pill.around          "{n} datasets"
pill.around.one      "{n} dataset"
pill.go              "{n} stops here"
pill.go.baked        "{n} baked"
pill.now             "{n} calendars"
pill.now.one         "{n} calendar"
pill.now.none        "none published"
pill.zoom            "{nuts3}"

here.offrelease      "This 1 km square is not in the {n} municipalities of this
                      release, so there is no address, sector or municipality to
                      resolve against on this device."
```

> **Naming note.** `map.zoom.out` is the map control ("Zoom out" = show more
> ground). `band.zoomout` is the fifth band ("Zoom out" = province and country
> context). The English happens to coincide; the Dutch and French do not
> (`Uitzoomen` / `Dézoomer` for the control, `Ruimer beeld` / `Prendre du recul`
> for the band). Two keys, never one.

### 10.3 The PLAN correction

`PLAN.md` section 6, "Screen model", currently reads "Four bands stacked on one
screen. No tabs, no dashboard." Replace with:

> ### Screen model
>
> One full-bleed map, with five bands as pill overlays above it. One band is open
> at a time, or none. No tabs, no dashboard, no routing: the pills are
> disclosures over a single screen, and the URL never changes.
>
> The map is the answer to "where am I" made visible; the bands are the answer
> made readable. Everything the map draws is also text in a band, because the map
> is `aria-hidden` and a keyboard user must lose nothing.
>
> The layer table (Here / Around / Go / Now / Zoom out, with their sources and
> their offline behaviour) is unchanged. `docs/UI_SPEC.md` is the authority on
> appearance and interaction.

Also correct the same section's "**Never render an empty panel.** A missing layer
collapses." to name the three cases the UI now distinguishes: **published nothing
here**, **out of scope for this region by design**, and **could not be reached**.
Only the last is a fault, and only the last uses the warn tone.
