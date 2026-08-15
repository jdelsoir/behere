# BeHERE design tokens

The Organic design system, ported into BeHERE as `web/app/tokens.css`.

This document is the record of that port: what was copied verbatim, what was
derived, what was deliberately changed and why, and the measured contrast of
every text-on-ground pair in both themes.

| | |
|---|---|
| Token sheet | `web/app/tokens.css` |
| This document | `docs/DESIGN_TOKENS.md` |
| Upstream system | `design/prototype/_ds/organic-42764194-de70-4e49-b9b1-f2c1b5c3cc65/` |
| Replaces | the `:root` block at the top of `web/app/app.css` (lines 27-67) |

`tokens.css` holds tokens only, plus one three-line `body` rule that paints the
ground. Component CSS lives in `web/app/app.css` and is owned by another
agent. If a value is a colour, a font, a space, a radius, a shadow or a type
size, it belongs here; if it is a selector, it does not.

---

## 1. Wiring

`tokens.css` has to load **before** `app.css`, in all three shell pages
(`index.html`, `offline.html`, `404.html` if it grows a stylesheet):

```html
<link rel="stylesheet" href="app/tokens.css">
<link rel="stylesheet" href="app/app.css">
```

Everything else that has to change to match, listed so the owning agent can
tick it off. None of these is in a file this agent owns:

| File | Change | Why |
|---|---|---|
| `web/index.html`, `web/offline.html` | add the `tokens.css` link above `app.css` | otherwise every `var()` in `app.css` resolves to nothing |
| `web/index.html` | `<meta name="theme-color" content="#f5ead8">` and `content="#241a0e" media="(prefers-color-scheme: dark)"` | currently `#1d3a5a` / `#0f1216`, the old navy palette |
| `web/index.html` | viewport gains `viewport-fit=cover` | without it `--inset-*` resolve to `0px` and map chrome sits under the notch |
| `web/index.html` | two `<link rel="preload" as="font" type="font/woff2" crossorigin>` for `fonts/figtree-var-latin.woff2` and `fonts/caprasimo-400-latin.woff2` | shortens the `font-display: swap` window, which is the whole layout-shift mitigation |
| `web/manifest.webmanifest` | `theme_color` and `background_color` to `#f5ead8` | manifest colours take no media query, so the light ground is the one that ships |
| `scripts/gen_icons.py` | icon field `#c67139` on `#f5ead8` | the icon is currently baked in the navy `--accent` |
| `web/sw.js` | `SHELL_REQUIRED` gains `"./app/tokens.css"` | a shell without tokens is an unstyled shell |
| `web/sw.js` | `SHELL_OPTIONAL` gains the four `./fonts/*.woff2` | optional, not required: a 404 on a font must not fail the install, and `swap` already draws the fallback |

**CSP needs no change.** `web/index.html` declares `default-src 'self'` with no
`font-src` override, so same-origin woff2 is already allowed. Do not add a
`font-src` entry pointing anywhere else; there is nowhere else.

**Fonts are shell, not data.** They go in `sw.js`'s shell list. They must never
appear in `web/data/precache.json`, which `scripts/bake.py` owns and
`scripts/gen_precache.py --check` verifies. And, separately: **OSM raster tiles
must never enter either list**, runtime cache only, per the tile usage policy.

---

## 2. What was ported verbatim

Every Organic token name is reproduced with its exact name so the two sheets
can be diffed. Values are unchanged except where section 6 says otherwise.

- **Roles**: `--color-bg`, `--color-surface`, `--color-text`, `--color-accent`,
  `--color-accent-2`, `--color-divider`
- **Ramps**, all 27 steps: `--color-neutral-100` … `-900`,
  `--color-accent-100` … `-900`, `--color-accent-2-100` … `-900`
- **Type**: `--font-heading`, `--font-heading-weight`, `--font-body`
- **Space**: `--space-1` `-2` `-3` `-4` `-6` `-8` (a 4px grid at density 1.10)
- **Radius**: `--radius-sm` `-md` `-lg`
- **Shadow**: `--shadow-sm` `-md` `-lg`

The ramps are **absolute**. They do not invert in dark mode. Step 100 is the
lightest step of a role in both themes; dark mode picks different steps, it
does not renumber them. Anything that reads `--color-accent-700` gets
`#8c491a` whatever the theme, and that is the point: it is a fixed rung, not a
semantic role.

---

## 3. The warm dark variant

### The ground

**`--color-bg` in dark is `#241a0e`.**

The obvious choice would have been `--color-text` `#201e1d`. It is already in
the palette and it is a near-black. It was rejected because it is *grey*. In
OKLCH it measures **L 0.2369, C 0.0036**: essentially achromatic. Organic's own
guide says "do not desaturate the palette into greys, warmth is the point",
and that applies to the theme where the ground is the largest surface on the
screen. `--color-neutral-900` `#2e2b25` is barely warmer at C 0.0115.

So the ground is derived by continuing the ramps rather than by borrowing an
existing step:

```
neutral-900  #2e2b25   L 0.2902  C 0.0115  H  84.6
accent-900   #402310   L 0.2900  C 0.0536  H  52.3
                                                     50/50 OKLCH mix
warm-900     #362819   L 0.2901  C 0.0326  H  68.4
                                                     one further ramp step
                                                     (dL -0.065, chroma tapered)
--color-bg   #241a0e   L 0.2265  C 0.0265  H  70.9
```

`#241a0e` carries **7.4× the chroma of `#201e1d` at the same lightness** and
2.3× that of `neutral-900`. It reads as espresso, not charcoal. Side by side
with a true grey of the same lightness (`#1b1917`) the difference is obvious:
rgb(36, 26, 14) has a 22-point spread from red to blue, the grey has 4.

`--color-surface` `#2f2419` is one notch up the same OKLCH line (L 0.270,
C 0.0255, H 66.4). The light theme separates bg from surface by ΔL 0.038; the
dark theme separates them by ΔL 0.043, so a card reads as *lighter* than the
page in dark exactly as it reads *darker* than the page in light.

### The ink

`--color-text` in dark is **`#f5ead8`**, the light theme's own `--color-bg`.
The palette turns over rather than being replaced, and the ink stays warm
instead of drifting to a cold white.

### The rest of the flip

The rule is one sentence: **where light reaches down the ramp, dark reaches
up, by the same number of steps.**

| Role | Light | Dark |
|---|---|---|
| brand hue (decorative) | `--color-accent` `#c67139` | accent-500 `#d67f48` |
| accent text and chrome | accent-700 `#8c491a` | accent-400 `#f6a06b` |
| accent solid fill | accent-700 | accent-500 |
| solid fill hover / active | accent-800 / accent-900 | accent-400 / accent-300 |
| muted ink | neutral-700 `#645c50` | neutral-400 `#c0b6a5` |
| stale ink / fill | stale-700 / stale-100 | stale-400 / stale-900 |
| tag fill / tag ink | *-100 / *-800 | *-900 / *-300 |

`--color-divider-strong` is `#82796a` (neutral-600) in **both** themes: it is
the one rung that clears 3:1 against all four grounds, so the dark block does
not restate it.

### Elevation

Organic's own note says elevation on a dark ground is "a hairline edge plus
ambient darkness". So each dark step is a 1px warm-cream ring under a soft
warm-black cast, `rgba(245,234,216, .06 to .09)` over `rgba(9,5,2, .55 to .7)`,
rather than the light theme's ink-tinted drop shadow. Black is used for the
cast because a shadow is a darkening; the *ring* is what carries the warmth.

### The basemap

`--map-tile-filter` washes the OSM raster layer so it sits under the palette
instead of fighting it: Organic's `.washed` idea, applied more gently because
a map still has to be legible.

- light: `saturate(0.68) contrast(0.9) brightness(1.06)`
- dark: `brightness(0.55) contrast(1.05) saturate(0.65) sepia(0.22)`

**Never `invert()`.** An inverted basemap is a colour negative, not a dark map:
water goes orange, parks go magenta, and the tiles stop matching the ODbL
attribution beneath them. Apply the filter to the tile layer only, never to the
vector overlays or the labels. If it costs frames on a low-end phone, drop the
dark filter to `brightness(0.6)` alone rather than removing the attribution.

---

## 4. The fonts

Both faces are **SIL Open Font License 1.1**, so vendoring the woff2 into a
public repo is clean **provided the licence text ships with them**.

Exact filenames expected under `web/fonts/`:

| File | Face | Notes |
|---|---|---|
| `caprasimo-400-latin.woff2` | Caprasimo 400 | latin subset |
| `caprasimo-400-latin-ext.woff2` | Caprasimo 400 | latin-ext subset |
| `figtree-var-latin.woff2` | Figtree variable, `wght 300 900` | latin subset |
| `figtree-var-latin-ext.woff2` | Figtree variable, `wght 300 900` | latin-ext subset |
| `OFL-Caprasimo.txt` | licence | must ship |
| `OFL-Figtree.txt` | licence | must ship |

Referenced from `tokens.css` as `url("../fonts/…")`, **relative**, because the
site is a Pages project page served from `/behere/` and a leading slash would
404. `web/app/tokens.css` + `../fonts/` resolves to `/behere/fonts/`, which is
what the brief asks for, and it also works from `file://` during local checks.

**latin-ext is not optional.** Belgian place names need it: `Liège`, `Sint-Job-in-'t-Goor`,
`Héron`, the German-speaking community's `Büllingen`, `Sankt Vith`.

**If the variable Figtree cannot be sourced** without a build tool (Python is
stdlib-only here, so no `fonttools`), fall back to statics named
`figtree-400-latin.woff2`, `figtree-600-latin.woff2`, `figtree-700-latin.woff2`
and their `-ext` twins, and tell this agent so the `@font-face` blocks are
rewritten. Do not leave a `font-weight: 300 900` declaration pointing at a
static 400 file. The browser will synthesise bold and Figtree's real 600 is
noticeably better.

Figtree ships no italic in this vendoring. `.now-raw`, the one italic line in
the app (a source's own opening-hours prose, quoted verbatim), gets a synthetic
oblique. That is acceptable for one line of quoted evidence.

### Layout shift

`font-display: swap` is mandatory here: an offline-first app must never hold
text invisible waiting on a font it may not have. The shift that swap causes is
mitigated three ways, and none of them is a guess:

1. **Preload** the two latin files in the shell (section 1). The swap window
   closes in the same round trip as the CSS.
2. **The body fallback stack is metric-adjacent.** Figtree is a humanist
   geometric sans; `system-ui` resolves to San Francisco, Roboto or Segoe UI,
   all of which sit within a few percent of it in width and x-height. Body copy
   reflows by a word at most.
3. **The heading fallback is Figtree, not a serif.** Caprasimo has no system
   analogue (it is a heavy rounded display face), so rather than fall to
   Georgia and reflow the whole heading, `--font-heading` falls to
   `"Figtree"` first. Headings in this app are short (a street name, a band
   title) and the fallback keeps them on the same line count.

A fourth mitigation, `size-adjust` / `ascent-override` on a named fallback
face, is deliberately **not** used. Doing it correctly needs the real
`unitsPerEm`, ascender, descender and x-height read out of the shipped woff2.
A guessed override is worse than none, because it locks in a wrong metric
permanently. Once the files are vendored, measure them and revisit.

---

## 5. Contrast, measured

Ratios are WCAG 2.x relative-luminance contrast, computed from the sRGB hex
values in `tokens.css`. The threshold column is the one that applies:
**4.5:1** for anything that carries body-size text, **3:1** for non-text UI
boundaries and focus indicators (WCAG 1.4.11 / 2.4.11).

### Light theme: ground `#f5ead8`, surface `#ebddc5`

| Pair | Foreground | Background | Ratio | Needs | |
|---|---|---|---:|---:|---|
| body ink on ground | `#201e1d` | `#f5ead8` | **13.95** | 4.5 | ✅ |
| body ink on surface | `#201e1d` | `#ebddc5` | **12.40** | 4.5 | ✅ |
| muted ink on ground | `#645c50` | `#f5ead8` | **5.53** | 4.5 | ✅ |
| muted ink on surface | `#645c50` | `#ebddc5` | **4.92** | 4.5 | ✅ |
| accent ink on ground | `#8c491a` | `#f5ead8` | **5.72** | 4.5 | ✅ |
| accent ink on surface | `#8c491a` | `#ebddc5` | **5.09** | 4.5 | ✅ |
| accent-2 ink on ground | `#56633f` | `#f5ead8` | **5.43** | 4.5 | ✅ |
| accent-2 ink on surface | `#56633f` | `#ebddc5` | **4.82** | 4.5 | ✅ |
| label on accent fill | `#f9f4ed` | `#8c491a` | **6.22** | 4.5 | ✅ |
| label on fill, hover | `#f9f4ed` | `#643312` | **9.48** | 4.5 | ✅ |
| label on fill, active | `#f9f4ed` | `#402310` | **13.09** | 4.5 | ✅ |
| label on accent-2 fill | `#f9f4ed` | `#56633f` | **5.90** | 4.5 | ✅ |
| stale ink on stale fill | `#715a1e` | `#fcf5e2` | **6.06** | 4.5 | ✅ |
| stale ink on ground | `#715a1e` | `#f5ead8` | **5.54** | 4.5 | ✅ |
| stale ink on surface | `#715a1e` | `#ebddc5` | **4.93** | 4.5 | ✅ |
| tag-accent ink on fill | `#643312` | `#fff2eb` | **9.46** | 4.5 | ✅ |
| tag-accent-2 ink on fill | `#3d472b` | `#f0fae1` | **9.12** | 4.5 | ✅ |
| tag-neutral ink on fill | `#474238` | `#f9f4ed` | **9.12** | 4.5 | ✅ |
| focus ring on ground | `#8c491a` | `#f5ead8` | **5.72** | 3.0 | ✅ |
| focus ring on surface | `#8c491a` | `#ebddc5` | **5.09** | 3.0 | ✅ |
| control border on ground | `#82796a` | `#f5ead8` | **3.61** | 3.0 | ✅ |
| control border on surface | `#82796a` | `#ebddc5` | **3.21** | 3.0 | ✅ |
| brand hue on ground † | `#c67139` | `#f5ead8` | **3.03** | 3.0 | ✅ |
| brand hue on surface † | `#c67139` | `#ebddc5` | 2.69 | 3.0 | ⚠︎ |
| brand hue 2 on ground † | `#7a8a5e` | `#f5ead8` | **3.14** | 3.0 | ✅ |
| brand hue 2 on surface † | `#7a8a5e` | `#ebddc5` | 2.79 | 3.0 | ⚠︎ |
| row rule (decorative) | `--color-divider` | ground | 1.37 | n/a | n/a |

### Dark theme: ground `#241a0e`, surface `#2f2419`

| Pair | Foreground | Background | Ratio | Needs | |
|---|---|---|---:|---:|---|
| body ink on ground | `#f5ead8` | `#241a0e` | **14.35** | 4.5 | ✅ |
| body ink on surface | `#f5ead8` | `#2f2419` | **12.72** | 4.5 | ✅ |
| muted ink on ground | `#c0b6a5` | `#241a0e` | **8.52** | 4.5 | ✅ |
| muted ink on surface | `#c0b6a5` | `#2f2419` | **7.55** | 4.5 | ✅ |
| accent ink on ground | `#f6a06b` | `#241a0e` | **8.27** | 4.5 | ✅ |
| accent ink on surface | `#f6a06b` | `#2f2419` | **7.32** | 4.5 | ✅ |
| accent-2 ink on ground | `#aebf92` | `#241a0e` | **8.68** | 4.5 | ✅ |
| accent-2 ink on surface | `#aebf92` | `#2f2419` | **7.69** | 4.5 | ✅ |
| label on accent fill | `#241a0e` | `#d67f48` | **5.69** | 4.5 | ✅ |
| label on fill, hover | `#241a0e` | `#f6a06b` | **8.27** | 4.5 | ✅ |
| label on fill, active | `#241a0e` | `#ffc6a5` | **11.29** | 4.5 | ✅ |
| label on accent-2 fill | `#241a0e` | `#8fa073` | **6.06** | 4.5 | ✅ |
| stale ink on stale fill | `#d0b46f` | `#342a0f` | **7.03** | 4.5 | ✅ |
| stale ink on ground | `#d0b46f` | `#241a0e` | **8.49** | 4.5 | ✅ |
| stale ink on surface | `#d0b46f` | `#2f2419` | **7.53** | 4.5 | ✅ |
| tag-accent ink on fill | `#ffc6a5` | `#402310` | **9.46** | 4.5 | ✅ |
| tag-accent-2 ink on fill | `#ccdbb2` | `#272e1b` | **9.61** | 4.5 | ✅ |
| tag-neutral ink on fill | `#dcd3c4` | `#2e2b25` | **9.51** | 4.5 | ✅ |
| focus ring on ground | `#f6a06b` | `#241a0e` | **8.27** | 3.0 | ✅ |
| focus ring on surface | `#f6a06b` | `#2f2419` | **7.32** | 3.0 | ✅ |
| control border on ground | `#82796a` | `#241a0e` | **3.98** | 3.0 | ✅ |
| control border on surface | `#82796a` | `#2f2419` | **3.53** | 3.0 | ✅ |
| brand hue on ground | `#d67f48` | `#241a0e` | **5.69** | 3.0 | ✅ |
| brand hue on surface | `#d67f48` | `#2f2419` | **5.04** | 3.0 | ✅ |
| brand hue 2 on ground | `#8fa073` | `#241a0e` | **6.06** | 3.0 | ✅ |
| brand hue 2 on surface | `#8fa073` | `#2f2419` | **5.37** | 3.0 | ✅ |
| row rule (decorative) | `--color-divider` | ground | 1.56 | n/a | n/a |

**No body-text pair is below 4.5:1 in either theme.** The lowest is muted ink
on the light surface at 4.92:1.

### † The two constrained tokens

`--color-accent` `#c67139` and `--color-accent-2` `#7a8a5e` are Organic's brand
hues, ported verbatim. They clear 3:1 on `--color-bg` (3.03 and 3.14) but not
on `--color-surface` (2.69 and 2.79). Rather than retune the brand, their use
is **constrained**:

- ✅ decorative fills, the "you are here" pin, large shapes, illustration
- ✅ anything ≥ 24px, or ≥ 18.7px bold
- ❌ never a text colour at body size
- ❌ never the sole visual cue for a control boundary sitting on `--color-surface`

Anything that must meet a ratio uses `--color-accent-ink` (5.72:1),
`--color-accent-solid` (6.22:1 with its label) or `--color-divider-strong`
(3.21:1 on surface). This is the single biggest departure from Organic's
component layer: its `a { color: var(--color-accent) }`, `.btn-ghost` and
`:focus-visible` are all 3.03:1 on the ground and 2.69:1 on a card, which fails
for links and ghost buttons. In BeHERE those use `--color-accent-ink`.

### Colour is never the only signal

`--color-stale` sits at OKLCH hue 88, the exact midpoint of terracotta (51.6)
and sage (124.6), so it is as far from both accents as this palette allows. It
is still within reach of the terracotta for a protanope or deuteranope
(`#715a1e` vs `#8c491a` differ by 36° of hue at the same lightness, 1.03:1 in
luminance). That is tolerated because the app never leans on the colour: an
`.asof` block always carries an explicit date string and a left rule, a
cancelled departure is struck through rather than reddened, and a `.quiet`
empty state differs from a stale one in copy, not hue. **Keep it that way.**
Anything new that distinguishes two states by colour alone is a defect.

---

## 6. Deviations from Organic, and why

| # | Deviation | Reason |
|---|---|---|
| 1 | No `@import url(fonts.googleapis.com…)`. Four self-hosted `@font-face` rules instead. | The repo is public, offline-first and CSP-locked to `default-src 'self'`. A third-party font request is a privacy leak, an offline failure and a CSP violation. Both faces are OFL-1.1, so vendoring is clean. |
| 2 | `--color-divider` and the three `--shadow-*` values are written as `rgba()` rather than `color-mix(in srgb, … , transparent)`. | Identical rendered values, zero modern-CSS cliff. `color-mix` that fails to parse makes the whole custom property invalid at computed-value time, which turns a hairline into `currentColor`. Also lets the dark block restate the divider from the cream ink instead of re-mixing a hard-coded hex. Organic's version hard-codes `#201e1d` and would break under a theme swap. |
| 3 | Fallback stacks lengthened past `system-ui, sans-serif`; `--font-heading` falls to `"Figtree"` before the system stack. | Section 4. The declared family is unchanged; only what happens when the woff2 is absent. |
| 4 | Added `--color-muted` (neutral-700) instead of Organic's `.text-muted` = `color-mix(--color-text 55%)`. | That mix lands at 4.2:1 on the ground. BeHERE sets real body copy in it (source lines, distances, the entire quiet empty state), so it must clear 4.5:1. A ramp step also honours the guide's own "prefer ramp steps over ad-hoc `color-mix()`". |
| 5 | Added `--color-accent-ink` / `--color-accent-2-ink`, `--color-accent-solid[-hover|-active]`, `--color-accent-2-solid`, `--color-on-accent`. | Organic's own guide says paragraph-size accent text needs a deep ramp step; its component layer does not follow that advice. These tokens make the correct value the easy one and keep the theme branch out of `app.css`. |
| 6 | Added `--color-divider-strong`, `--color-stale`, `--color-stale-bg`, `--color-tag-*-bg/-ink`, `--color-scrim`, `--font-mono`. | BeHERE has to say things Organic never had to: this figure is real but old; this code is data, not prose; this control has a boundary. All derived from the ramps, all documented at the point of definition. |
| 7 | Added `--text-*`, `--leading-*`, `--tracking-*`, `--radius-pill`, `--space-12`. | Organic hard-codes these inside its component layer. Lifting them into tokens is the only way `app.css` and the design system can be kept from drifting. Values are Organic's, unchanged, except `--text-display` and `--space-12` which are new and flagged. |
| 8 | Added `--text-display: clamp(27px, 4.6vw + 12px, 42px)`. | Organic's `h1` is a fixed 42px. The answer line is a Belgian street name on a 320px phone; at 42px Caprasimo, `Ottignies-Louvain-la-Neuve` overflows. It lands on the full 42px at 560px and above. |
| 9 | Added `--inset-*` (`env(safe-area-inset-*)`) and `--map-tile-filter`. | Organic was never a full-screen map in a standalone PWA. Without the insets, map chrome sits under the notch; without the filter, a full-colour OSM raster fights the warm palette in both themes. |
| 10 | The warm dark theme. | Organic has no dark mode at all. Section 3 documents the derivation. |

---

## 7. Mapping: current `app.css` → Organic

### Tokens

| Old `app.css` | New | Note |
|---|---|---|
| `--bg` `#ffffff` | `--color-bg` | cream, not white |
| `--surface` `#f4f5f7` | `--color-surface` | |
| `--surface-2` `#eceef1` | *gone* → `--color-tag-neutral-bg` | its only user is the `.go-line` chip, which becomes a tag |
| `--ink` `#14181d` | `--color-text` | |
| `--muted` `#565d67` | `--color-muted` | |
| `--line` `#d7dbe0` | `--color-divider` | decorative rules only |
| `--line-strong` `#b4bac2` | `--color-divider-strong` | control boundaries, clears 3:1 |
| `--accent` `#1d3a5a` | **splits three ways**: `--color-accent` decorative, `--color-accent-ink` text and chrome, `--color-accent-solid` fills | see section 5 † |
| `--accent-ink` `#ffffff` | `--color-on-accent` | |
| `--accent-weak` `#e7edf5` | `--color-tag-accent-bg` | |
| `--stale` / `--stale-bg` | `--color-stale` / `--color-stale-bg` | same semantics, warmer hue |
| `--radius` `8px` | `--radius-md` `16px` for cards and inputs; `--radius-sm` `8px` for small insets; `--radius-lg` `28px` for floating panels; `--radius-pill` for buttons, tags and chips | Organic over-rounds on purpose |
| `--measure` `44rem` | stays in `app.css` | a layout constant, not a design token |
| `--step--1` | `--text-xs` `11px` / `--text-sm` `13px` | |
| `--step-0` | `--text-body` `15px` | |
| `--step-1` | `--text-lg` `17px` / `--text-h4` `20px` | |
| `--step-2` | `--text-h3` `25px`; the answer line uses `--text-display` | |
| system font stack | `--font-body`, `--font-heading`, `--font-mono` | headings become Caprasimo, weight 400 |

### Components and band vocabulary

| Old concept | Organic token or class | Note |
|---|---|---|
| `.app-bar` + `.app-bar h1` | `.nav` + `.nav-brand` | |
| `.langs` (4 flat buttons) | `.seg` + `.seg-opt`, `--radius-pill` | selected option gets `--color-accent-solid` / `--color-on-accent` |
| `.btn` | `.btn` + `.btn-primary` | |
| `.btn.secondary` | `.btn-secondary` | border from `--color-divider-strong` |
| a band panel (`.band`) | `.card` on `--color-surface`, `--radius-lg`, `--shadow-md` | floating over the map it uses `--color-bg` + `--shadow-lg`, as the prototype does |
| `.band > header h2` | `.card-title` in `--font-heading` | |
| `.band-status` | `.card-meta` / `--color-muted` at `--text-xs` | |
| `.answer` | `--font-heading` at `--text-display` | the one fluid size |
| `.house`, `.code`, `.measure`, `.vintage` | `--font-mono` + `font-variant-numeric: tabular-nums` + `--color-muted` | codes are data, not prose |
| `.facts` (dl) | `.table` header treatment: `--text-xs`, `--tracking-caps`, `--color-muted` | |
| `.rows li`, `.around-item`, `.go-stop`, `.now-item` | list rows separated by `--color-divider` | |
| `.rows .meta.live`, `.go-delay`, `.around-item__here` | `--color-accent-ink` | the single accent in a band |
| **`.quiet`** | `.card` on `--color-surface`, `--color-muted` text, left rule `--color-divider-strong`, `--radius-md` | **no red, no warning glyph, no dashed "missing" border.** An absent layer is an ordinary outcome |
| `.asof`, `.go-asof`, `.now-asof`, `.offline-bar` | `--color-stale` on `--color-stale-bg`, left rule `--color-stale`, `--radius-md` | real but old, and it always carries a date |
| `.around-layer--failed` | `--color-stale` summary | could not be reached; the only one of the four layer states that is a fault |
| `.around-layer--empty`, `--absent` | `--color-muted` summary, no fill | published nothing / out of scope by design |
| `.endonym`, `.src`, `.around-src`, `.go-src`, `.now-src` | `--text-xs`, `--color-muted` | acceptance test 8: source and vintage on every layer |
| `.untranslated`, `.around-flag` | `--color-muted`, `--text-2xs`, superscript | one per panel, never one per street |
| `.stats li` | `.card`; value in `--font-heading`, key as `.card-kicker` | |
| `.stats .stat--withheld` | `.card` with `background: none`, dashed `--color-divider-strong` | a deliberate refusal, not a rendering failure |
| `details` / `summary` | `.card` + a Lucide `chevron-right` at stroke-width 2.75, rotating 90° | the only motion in the app; keep the `prefers-reduced-motion` guard |
| `.now-open[data-open="open"]` | `.tag-accent` tokens + `--color-accent-ink` border | |
| `.now-open[data-open="closed"]` | `.tag-neutral` tokens | |
| `.now-open[data-open="unknown"]` | `--color-divider-strong` dashed, `--color-muted` | unknown is not a warning |
| `.go-line` | `.tag-neutral` tokens at `--radius-pill` | |
| `.notice`, `.ios-hint` | `.card` on `--color-tag-accent-bg` | |
| `.app-foot` | `--text-xs`, `--color-muted` | |
| `:focus-visible` | `2px solid var(--color-accent-ink)`, `outline-offset: 2px` | **not** `--color-accent`; see section 5 † |
| photographs, hero imagery | `.washed` | |
| the OSM raster basemap | `--map-tile-filter` | not `.washed`, a map still has to be read |

### New, no old equivalent

| Concept | Tokens |
|---|---|
| the map canvas beneath everything | `--color-bg` while tiles load, `--map-tile-filter` once they arrive |
| the "you are here" pin | `--color-accent` fill, `--color-bg` ring, `--shadow-md` (as the prototype) |
| a floating map panel | `--color-bg`, `--radius-lg`, `--shadow-lg`, `--space-3` padding |
| **OSM attribution** | `--text-xs`, `--color-muted` on an opaque `--color-bg` chip, link in `--color-accent-ink` | required by ODbL, must be visible, must link to `openstreetmap.org/copyright` |
| notch and home-indicator gutters | `--inset-top` … `--inset-left` |

---

## 8. Rules for whoever writes `app.css`

1. **No hex, no rgb, no font name, no shadow in `app.css`.** If a value is
   missing, add a token here and document it in section 6, do not inline it.
2. **px is allowed only where no token carries the value**, a 1px hairline, a
   36px control height. Spacing, radii and type sizes always come from tokens.
3. **Never branch on the theme in `app.css`.** There is no
   `@media (prefers-color-scheme: dark)` outside `tokens.css`. If a component
   needs a different value in dark, that is a missing token, not a media query.
4. **`--color-accent` never carries text.** Use `--color-accent-ink`.
5. **Interactive states are themed, never browser defaults.** Every
   interactive element gets a hover tint, a pressed state one ramp step past
   the base, and `:focus-visible { outline: 2px solid var(--color-accent-ink);
   outline-offset: 2px; }`. Never the default blue ring.
6. **Empty is not an error.** `.quiet` gets no red, no warning glyph, no dashed
   "missing" border. Four Belgian pilot municipalities publish nothing locally
   and the app must read as calm there, not broken.
7. **Old is not absent.** `--color-stale` marks data that is real and dated;
   `--color-muted` on `--color-surface` marks data that was never published.
   Never blur the two.
8. **Every layer shows its source and its vintage date** (acceptance test 8).
   `--text-xs` `--color-muted`, but never omitted.
