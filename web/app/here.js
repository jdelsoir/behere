/**
 * BeHERE, the Here band. "Where am I?"
 *
 * Address, statistical sector, NIS municipality, district, province, region,
 * the postcodes the municipality spans, and an honest account of what this
 * release does not ship for the square you are standing in.
 *
 * TWO RULES DECIDE CORRECTNESS HERE, and both are structural:
 *
 *   1. Position resolves to a NIS through the address record or the sector
 *      polygon. NEVER through the postcode. City of Brussels (21004) spans ten
 *      postcodes, so postcode 1000 cannot on its own name a municipality
 *      (PLAN Trap 2, acceptance test 2). Every appearance of a postcode in
 *      this file is a rendered string; none is a lookup key. The band even
 *      says so on screen, next to the list.
 *
 *   2. Everything shown is baked. No runtime source is called. Cold start in
 *      airplane mode answers address, sector and municipality from the service
 *      worker cache (acceptance test 1).
 *
 * INTERFACE. This module is a band module in main.js's sense: it exports
 * `mount(el, ctx)` and returns a handle with `update(ctx)`. main.js owns the
 * <section>, the geolocation, the 9-cell read and the shard decoding, and
 * hands over a fully decoded context. This module owns the body of the band
 * and one thing main.js does not do: reading <nis>/sector.geojson and running
 * point in polygon, which is the sector-polygon half of the resolve rule.
 *
 * It also runs standalone, off geo.js alone, for offline.html and for tests:
 * `resolveHere(fix)` resolves from baked shards with no shell at all, and
 * `createHereBand(root)` mounts a complete band including its own header.
 *
 * MARKUP ONLY. No styles are written here and no inline style attribute is
 * ever set. The class vocabulary is app.css's own (.answer, .sub, .facts,
 * .rows, .quiet, .src, .endonym, .untranslated, details/.disclosure-body); the
 * only additions are `data-*` hooks, listed at the bottom of this file.
 *
 * THE MAP-FIRST REVAMP CHANGED TWO THINGS HERE, AND NEITHER IS LOGIC.
 *
 *   1. Presentation. The body now renders into the pill-overlay panel of
 *      docs/UI_SPEC.md: notes carry a kind label and a tone, and the tone rule
 *      is absolute (UI_SPEC 2.5). "Published nothing here" and "out of scope
 *      by design" are quiet and are NOT faults. "Could not be reached" is the
 *      only warn tone, and in this band it can only ever mean the device's own
 *      geolocation, because nothing this band shows is fetched at runtime.
 *
 *   2. It feeds the map. The 1 km cell, the sector polygons, the sector you
 *      are standing in and the position dot are all resolved here already, so
 *      they are published rather than re-derived: UI_SPEC 1.4 says "the map
 *      asks here.js, it does not re-derive it. There is one sector authority
 *      in this app." Section 7 is that interface.
 *
 * The view model, the resolve rules, the point-in-polygon and the three-phase
 * read are untouched.
 */

import {
  readCellsAround, addressesOf, foreignOf, nearest,
  readMunicipalities, readRootMeta, readMunicipalityMeta,
  readStreets, readSectors, readOverride, findSectorAt,
  formatDistance, haversineMetres, neighbours, watchPosition,
} from "./geo.js";

export { haversineMetres, formatDistance };

/* =====================================================================
 * 1. The i18n bridge
 * ===================================================================== */
/* CONTRACT 9 puts resolveLabel in its own module and main.js passes one in on
 * the context. This band uses whichever it is given, in that order of
 * preference, and never duplicates the four steps. The shim below covers only
 * steps 3 and 4 so that a missing resolver degrades to an authored name rather
 * than to a blank string (acceptance test 4). */

let _resolveLabel = null;
let _t = null;
let _i18nTried = false;

/**
 * The inline "this is not in your language" marker.
 *
 * Deliberately a local constant rather than an import: this module mounts
 * standalone with no i18n.js present, and the marker has to work in that case
 * too. It must stay byte-identical to i18n.js's UNTRANSLATED_MARK, which
 * scripts/check_i18n.py is the backstop for.
 */
const UNTRANSLATED_MARK = " *";

/** Inject a resolver explicitly. @param {{resolveLabel?:Function, t?:Function}} mod */
export function useI18n(mod) {
  if (mod && typeof mod.resolveLabel === "function") _resolveLabel = mod.resolveLabel;
  if (mod && typeof mod.t === "function") _t = mod.t;
}

async function ensureI18n() {
  if (_resolveLabel || _i18nTried) return;
  _i18nTried = true;
  try { useI18n(await import("./i18n.js")); } catch (_) { /* not present */ }
}

/** Steps 3 and 4 of CONTRACT 9.2 only. It selects an authored name, never invents one. */
function shimResolveLabel(entity, kind, uiLang, ctx) {
  const name = (entity && entity.name) || {};
  const rd = (ctx && ctx.regionDefault) || "nl";
  if (typeof name[rd] === "string" && name[rd]) {
    return { text: name[rd], lang: rd, translated: false, step: 3 };
  }
  for (const lang of ["nl", "fr", "de", "en"]) {
    if (typeof name[lang] === "string" && name[lang]) {
      return { text: name[lang], lang, translated: false, step: 4 };
    }
  }
  const id = entity && entity.id !== undefined ? entity.id : "?";
  return { text: "[" + id + "]", lang: "?", translated: false, step: 4 };
}

/* =====================================================================
 * 2. App chrome strings
 * ===================================================================== */
/* English defaults, so no string is ever blank before web/data/i18n/*.json
 * lands. Lift them verbatim into the `ui` group. Keys follow main.js's own
 * naming: `here.*` labels, `empty.here.*` gap copy, shared `flag.*`.
 * `{name}` placeholders are filled by tt(). */

export const HERE_UI_DEFAULTS = Object.freeze({
  "band.here": "Here",

  /* The note kind labels, UI_SPEC 2.3. Every note in the panel is a kind label
   * over a body, and the kind is what makes UI_SPEC 2.5's three situations
   * distinguishable at a glance rather than only by reading the sentence:
   * PUBLISHED NOTHING and OUT OF SCOPE BY DESIGN are quiet and are not faults;
   * COULD NOT BE REACHED is the one that is. They are declared here because
   * this band renders them; scripts/check_i18n.py gates them in all three
   * languages either way, and around.js, go.js and now.js may declare the same
   * keys for the same purpose without conflict. */
  "note.waiting": "Waiting for a position",
  "note.nothing": "Published nothing",
  "note.scope": "Out of scope by design",
  "note.unreachable": "Could not be reached",
  "note.approx": "Approximate",
  "note.pending": "Not loaded yet",

  "here.address": "Address",
  "here.away": "{d} from you",
  "here.far": "The nearest baked address is {d} away, so this is approximate.",

  "here.sector": "Statistical sector",
  "here.sector.polygon": "the polygon you are standing in, simplified to {t} m",
  "here.sector.address": "the nearest address record",

  "here.municipality": "Municipality",
  "here.nis": "NIS code",
  "here.official": "Official name",
  "here.official.both": "Official names",
  "here.alt": "Also written",

  "here.district": "District",
  "here.province": "Province",
  "here.region": "Region",

  "here.postcodes": "Postcodes",
  "here.postcodes.note": "{name} spans {n} postcodes. A postcode names a delivery area, not a municipality, so BeHERE never resolves your position through one.",
  "here.postcodes.note.one": "One postcode here. A postcode still names a delivery area, not a municipality.",

  "here.position": "Your position",
  "here.accuracy": "accurate to about {d}",
  "here.manual": "Position set by hand, not by the device.",
  "here.local": "Every line above was read from data already on this device.",

  "here.coverage": "Not in this release",
  "here.coverage.intro": "This square also holds addresses in municipalities this release does not ship, so they are named here rather than silently dropped.",
  "here.coverage.item": "{n} addresses",

  "empty.here.position": "No position yet, so BeHERE cannot say where you are.",
  "empty.here.address": "No baked address near this position. The seven pilot cities carry addresses; the ground between them does not.",
  "empty.here.sector": "No statistical sector could be resolved for this position.",
  "empty.here.municipality": "This position is outside the municipalities in this release.",
  "empty.here.province": "The Brussels-Capital Region has no province.",
  "empty.here.streets": "The street name table for this municipality has not loaded, so the street is shown by its id.",

  /* UI_SPEC 2.5 and 10.2. The prototype writes "Seven municipalities were
   * baked" as a literal; this release ships nine, so {n} is filled from
   * meta.json.municipalities.length. That substitution is the only change the
   * spec permits to this sentence, and the reason it is permitted is that the
   * alternative is shipping a false number. */
  "here.offrelease": "This 1 km square is not in the {n} municipalities of this release, so there is no address, sector or municipality to resolve against on this device.",

  "here.source": "Source",
  "here.src.why": "Baked only. No runtime source is called, so this band answers in airplane mode.",
  "flag.untranslated": "Not available in English",
  "flag.endonym": "Street and place names are shown in their official local language.",
});

/** The keys this band asks for, exported so the i18n files can be diffed. */
export const HERE_UI_KEYS = Object.freeze(Object.keys(HERE_UI_DEFAULTS));

/* =====================================================================
 * 3. Language policy, CONTRACT 4.1
 * ===================================================================== */

/** The nine German-speaking Community municipalities, all in Liege province. */
export const DE_COMMUNITY = Object.freeze([
  "63001", "63012", "63013", "63023", "63040", "63048", "63061", "63067", "63087",
]);

/**
 * Default UI language and official languages of a municipality.
 *
 * <nis>/meta.json carries `lang` and is authoritative once loaded. This
 * derives the same answer from `rgn` alone, so the centre-cell paint is
 * correct before that file arrives.
 *
 * @param {string} nis @param {string} rgn @param {string} [browserLang]
 * @returns {{default: "nl"|"fr"|"de", official: string[]}}
 */
export function langPolicy(nis, rgn, browserLang) {
  if (rgn === "02000") return { default: "nl", official: ["nl"] };
  if (rgn === "04000") {
    const b = String(browserLang || "").slice(0, 2).toLowerCase();
    return { default: b === "nl" ? "nl" : "fr", official: ["fr", "nl"] };
  }
  if (rgn === "03000") {
    return DE_COMMUNITY.indexOf(nis) >= 0
      ? { default: "de", official: ["de"] }
      : { default: "fr", official: ["fr"] };
  }
  return { default: "nl", official: ["nl"] };
}

/* =====================================================================
 * 4. The view model
 * ===================================================================== */

/** Beyond this the nearest address is still shown, but flagged approximate. */
const FAR_ADDRESS_M = 300;

/**
 * @typedef {Object} HereView
 * @property {?Object} fix        {lat, lon, accuracy, at, source}
 * @property {"centre"|"full"|"refined"} phase
 * @property {?string} cell @property {string[]} cells
 * @property {?Object} address    {streetId, streetNames, house, lat, lon,
 *                                 distanceM, zip, sector, nis, far}
 * @property {?Object} sector     {code, names, source: "polygon"|"address", toleranceM}
 * @property {?string} nis
 * @property {?Object} municipality {nis, names, rgn, prov, dstr, nuts3, lang,
 *                                 zips, counts, vintage}
 * @property {?Object} district @property {?Object} province @property {?Object} region
 * @property {Array<{nis:string,count:number,names:?Object}>} foreign
 * @property {?string} vintage @property {?string[]} shipped
 * @property {Object} sources     id -> source record from meta.json
 * @property {boolean} online
 */

function pickAdmin(table, code) {
  if (!table || !code) return null;
  const names = table[code];
  return names ? { code, names } : null;
}

/** Sector by polygon first, then by the nearest address's own sector code. */
function resolveSector(lat, lon, sectorFC, addressSector, toleranceHint) {
  const toleranceM = toleranceHint !== null && toleranceHint !== undefined
    ? toleranceHint
    : (sectorFC && sectorFC.properties && sectorFC.properties.tolerance_m) || null;

  if (sectorFC) {
    const f = findSectorAt(lat, lon, sectorFC);
    if (f && f.properties) {
      return {
        code: f.properties.s || "",
        names: { nl: f.properties.nl || "", fr: f.properties.fr || "", de: f.properties.de || "" },
        source: "polygon",
        toleranceM,
      };
    }
  }
  if (addressSector) {
    let names = null;
    if (sectorFC && Array.isArray(sectorFC.features)) {
      const f = sectorFC.features.find((x) => x && x.properties && x.properties.s === addressSector);
      if (f) names = { nl: f.properties.nl || "", fr: f.properties.fr || "", de: f.properties.de || "" };
    }
    return { code: addressSector, names, source: "address", toleranceM };
  }
  return null;
}

function buildAddress(hit, streets) {
  if (!hit) return null;
  const a = hit.item !== undefined ? hit.item : hit;
  const distanceM = hit.distanceM !== undefined ? hit.distanceM : hit.distance;
  const streetId = a.streetId !== undefined ? a.streetId : a.street;
  return {
    streetId,
    streetNames: streets && typeof streets.get === "function" ? (streets.get(streetId) || null) : null,
    house: a.house,
    lat: a.lat,
    lon: a.lon,
    distanceM,
    zip: a.zip,            // display only, never a key
    sector: a.sector,
    nis: a.nis,
    far: distanceM > FAR_ADDRESS_M,
  };
}

function buildMunicipality(nis, mrec, mmeta, browserLang) {
  if (!nis) return null;
  const rgn = (mmeta && mmeta.rgn) || (mrec && mrec.rgn) || null;
  return {
    nis,
    names: mrec ? { nl: mrec.nl, fr: mrec.fr, de: mrec.de } : (mmeta && mmeta.name) || null,
    rgn,
    prov: mmeta ? mmeta.prov : (mrec ? mrec.prov : null),
    dstr: (mmeta && mmeta.dstr) || (mrec && mrec.dstr) || null,
    nuts3: (mmeta && mmeta.nuts3) || null,
    lang: (mmeta && mmeta.lang) || (rgn ? langPolicy(nis, rgn, browserLang) : null),
    zips: (mmeta && Array.isArray(mmeta.zips)) ? mmeta.zips : [],
    counts: (mmeta && mmeta.counts) || null,
    vintage: (mmeta && mmeta.vintage) || null,
  };
}

function buildForeign(counts, municipalities) {
  if (!counts) return [];
  return Object.keys(counts).sort().map((k) => ({
    nis: k,
    count: counts[k],
    names: municipalities && municipalities[k] ? municipalities[k] : null,
  }));
}

function indexSources(rootMeta, muni) {
  const out = {};
  if (rootMeta && Array.isArray(rootMeta.sources)) {
    for (const s of rootMeta.sources) if (s && s.id) out[s.id] = s;
  }
  if (muni && muni.sources && typeof muni.sources === "object") {
    for (const id of Object.keys(muni.sources)) if (!out[id]) out[id] = muni.sources[id];
  }
  return out;
}

const browserLang = () => (typeof navigator !== "undefined" ? navigator.language : "");

/**
 * Build the view from main.js's context. Nothing is re-fetched: the spine has
 * already decoded the shards, resolved the nearest address and loaded
 * <nis>/meta.json and <nis>/streets.json. The one thing it has not done is the
 * sector polygon, which arrives here as `sectorFC`.
 *
 * @param {Object} ctx @param {?Object} sectorFC
 * @returns {HereView}
 */
export function viewFromContext(ctx, sectorFC) {
  const municipalities = (ctx.municipalities && ctx.municipalities.municipalities) || null;
  const nis = ctx.nis || (ctx.nearest && ctx.nearest.nis) || null;
  const mrec = nis && municipalities ? municipalities[nis] : null;
  const mmeta = ctx.muntyMeta && ctx.muntyMeta.nis === nis ? ctx.muntyMeta : null;
  const pos = ctx.position || null;

  const address = buildAddress(ctx.nearest, ctx.streets);
  const sector = pos
    ? resolveSector(pos.lat, pos.lon, sectorFC, address && address.sector,
        mmeta ? mmeta.sector_tolerance_m : null)
    : null;

  return {
    fix: pos,
    phase: sectorFC ? "refined" : (ctx.shards && ctx.shards.size > 1 ? "full" : "centre"),
    cell: ctx.cell || null,
    cells: ctx.shards ? Array.from(ctx.shards.keys()) : [],
    address,
    sector,
    nis,
    municipality: buildMunicipality(nis, mrec, mmeta, browserLang()),
    district: pickAdmin(ctx.municipalities && ctx.municipalities.districts,
      (mmeta && mmeta.dstr) || (mrec && mrec.dstr)),
    province: pickAdmin(ctx.municipalities && ctx.municipalities.provinces,
      mmeta ? mmeta.prov : (mrec ? mrec.prov : null)),
    region: pickAdmin(ctx.municipalities && ctx.municipalities.regions,
      (mmeta && mmeta.rgn) || (mrec && mrec.rgn)),
    foreign: buildForeign(ctx.foreign, municipalities),
    vintage: (mmeta && mmeta.vintage) || (ctx.meta && ctx.meta.vintage) || null,
    shipped: (ctx.meta && Array.isArray(ctx.meta.municipalities)) ? ctx.meta.municipalities : null,
    sources: indexSources(ctx.meta, ctx.municipalities),
    online: ctx.online !== false,
  };
}

/** Standalone composition, from files read through geo.js. */
function composeView(input) {
  const { fix, cell, cells, shards, muni, rootMeta, mmeta, streets, sectorFC, phase } = input;
  const municipalities = (muni && muni.municipalities) || null;

  const addresses = addressesOf(shards);
  const hit = addresses.length ? nearest(fix.lat, fix.lon, addresses) : null;

  // NIS comes from the address record, or from the folder that owns the sector
  // polygon. It never comes from a postcode.
  let nis = null;
  if (mmeta && mmeta.nis) nis = mmeta.nis;
  else if (hit) nis = hit.item.nis || null;
  else if (shards.length === 1 && shards[0].municipalities.length === 1) {
    nis = shards[0].municipalities[0];
  }

  const mrec = nis && municipalities ? municipalities[nis] : null;
  const address = buildAddress(hit, streets);

  return {
    fix,
    phase,
    cell,
    cells,
    address,
    sector: resolveSector(fix.lat, fix.lon, sectorFC, address && address.sector,
      mmeta ? mmeta.sector_tolerance_m : null),
    nis,
    municipality: buildMunicipality(nis, mrec, mmeta, browserLang()),
    district: pickAdmin(muni && muni.districts, (mmeta && mmeta.dstr) || (mrec && mrec.dstr)),
    province: pickAdmin(muni && muni.provinces, mmeta ? mmeta.prov : (mrec ? mrec.prov : null)),
    region: pickAdmin(muni && muni.regions, (mmeta && mmeta.rgn) || (mrec && mrec.rgn)),
    foreign: buildForeign(foreignOf(shards), municipalities),
    vintage: (mmeta && mmeta.vintage) || (shards.length && shards[0].vintage) ||
      (rootMeta && rootMeta.vintage) || null,
    shipped: (rootMeta && Array.isArray(rootMeta.municipalities)) ? rootMeta.municipalities : null,
    sources: indexSources(rootMeta, muni),
    online: typeof navigator === "undefined" || navigator.onLine !== false,
  };
}

/**
 * Resolve a position to address, sector, municipality and hierarchy, reading
 * only baked files. Works with the network switched off.
 *
 * Progressive in three paints, because CONTRACT 7.5 measures the worst 9-cell
 * read at 629 KB raw and forbids blocking first paint on it:
 *   centre   the centre shard alone answers "where am I"
 *   full     all nine cells, plus <nis>/meta.json and <nis>/streets.json
 *   refined  <nis>/sector.geojson, point in polygon
 *
 * `onPartial` fires after the first two; the promise settles on the third.
 *
 * @param {{lat:number, lon:number, accuracy?:number, at?:number}} fix
 * @param {{signal?:AbortSignal, onPartial?:(v:HereView)=>void}} [opts]
 * @returns {Promise<HereView>}
 */
export async function resolveHere(fix, opts = {}) {
  const { signal, onPartial } = opts;
  const nine = readCellsAround(fix.lat, fix.lon, { signal });
  const abortIf = () => {
    if (signal && signal.aborted) throw new DOMException("aborted", "AbortError");
  };

  const [centreShard, muniRes, rootRes] = await Promise.all([
    nine.centre, readMunicipalities({ signal }), readRootMeta({ signal }),
  ]);
  abortIf();

  const common = {
    fix, cell: nine.cell, cells: nine.cells,
    muni: muniRes.ok ? muniRes.data : null,
    rootMeta: rootRes.ok ? rootRes.data : null,
  };

  let view = composeView(Object.assign({}, common, {
    shards: centreShard ? [centreShard] : [],
    mmeta: null, streets: null, sectorFC: null, phase: "centre",
  }));
  if (onPartial) onPartial(view);

  const guess = view.nis;
  const scoped = guess
    ? Promise.all([readMunicipalityMeta(guess, { signal }), readStreets(guess, { signal })])
    : Promise.resolve([null, null]);
  const [shards, scopedRes] = await Promise.all([nine.all, scoped]);
  abortIf();

  let mmeta = scopedRes[0] && scopedRes[0].ok ? scopedRes[0].data : null;
  let streets = scopedRes[1] || null;
  view = composeView(Object.assign({}, common, { shards, mmeta, streets, sectorFC: null, phase: "full" }));

  // The eight neighbours can move the nearest address into a different
  // municipality than the centre cell suggested. Refetch once; the cache makes
  // a repeat call free.
  if (view.nis && view.nis !== guess) {
    const [m2, s2] = await Promise.all([
      readMunicipalityMeta(view.nis, { signal }), readStreets(view.nis, { signal }),
    ]);
    mmeta = m2 && m2.ok ? m2.data : null;
    streets = s2 || null;
    view = composeView(Object.assign({}, common, { shards, mmeta, streets, sectorFC: null, phase: "full" }));
  }
  if (onPartial) onPartial(view);

  // Up to 150 KB, so it never gates a paint.
  const sectorFC = view.nis ? await readSectors(view.nis, { signal }) : null;
  abortIf();
  return composeView(Object.assign({}, common, { shards, mmeta, streets, sectorFC, phase: "refined" }));
}

/* =====================================================================
 * 5. DOM helpers
 * ===================================================================== */

function el(tag, attrs, ...children) {
  const n = document.createElement(tag);
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = String(v);
      else n.setAttribute(k, v === true ? "" : String(v));
    }
  }
  // flat(Infinity): helpers like labelNodes() return arrays, and fact() passes
  // them through a rest parameter, so children arrive nested more than once.
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    n.appendChild(typeof c === "string" || typeof c === "number"
      ? document.createTextNode(String(c)) : c);
  }
  return n;
}

/** Per-kind marker policy, CONTRACT 9.3. */
const INLINE_MARKER = { munty: true, cat: true, ui: true };

/**
 * The five honest ways this band can have nothing to say, as a `data-empty`
 * value. UI_SPEC 2.5 names the first three and insists they are not one thing:
 *
 *   published-nothing  the source answered and there is no data at this place
 *   out-of-scope       this release does not cover here, by design
 *   unreachable        THE ONLY FAULT. Warn tone, never used for the other two
 *
 * and two more that this band needs because it paints three times per fix:
 *
 *   pending            a baked file that will arrive, has not arrived yet
 *   idle               no position yet, so nothing has been asked of anything
 *
 * Everything the Here band shows is baked (CONTRACT 7.5, acceptance test 1), so
 * `unreachable` appears here for exactly one thing: the device's own
 * geolocation refusing or failing, in the standalone path's fail(). No layer in
 * this band can be "unreachable", because no layer in it is fetched at runtime.
 */
export const NOTHING = Object.freeze({
  PUBLISHED_NOTHING: "published-nothing",
  OUT_OF_SCOPE: "out-of-scope",
  UNREACHABLE: "unreachable",
  PENDING: "pending",
  IDLE: "idle",
});

/**
 * One note: a kind label over a body, in a quiet or a warn box (UI_SPEC 2.3).
 *
 * THE TONE RULE IS THE LOAD-BEARING ONE. Warn is only ever for data that is
 * real but old, or for a source that could not be reached. It is never used for
 * "published nothing here" and never for "out of scope by design", because
 * absent and broken are different claims and blurring them is how an app that
 * is behaving correctly starts to look broken in the two pilot cities that
 * publish almost nothing.
 *
 * The class stays `.quiet`, which is app.css's existing vocabulary; the tone
 * rides on `data-tone`, so no band module has to know a second class name and
 * a stylesheet that has not been told about warn notes still renders a calm,
 * correct box rather than an unstyled one.
 *
 * @param {{layer:string, body:string, kind?:string, tone?:"quiet"|"warn",
 *          empty?:string}} spec
 */
function note(spec) {
  const p = el("p", {
    class: "quiet",
    "data-layer": spec.layer,
    "data-tone": spec.tone || "quiet",
    "data-empty": spec.empty || null,
  });
  if (spec.kind) p.appendChild(el("strong", { class: "note__kind", text: spec.kind }));
  p.appendChild(el("span", { class: "note__body", text: spec.body }));
  return p;
}

/* =====================================================================
 * 6. Rendering
 * ===================================================================== */

/**
 * The render API. `mount` fills it from main.js's context; the standalone path
 * fills it from this module's own defaults.
 * @typedef {Object} RenderApi
 * @property {string} lang
 * @property {(key:string, vars?:Object)=>string} t
 * @property {(entity:Object, kind:string)=>Object} label
 * @property {(m:number)=>string} metres
 */

function makeApi(ctx, view) {
  const lang = (ctx && ctx.lang) || "en";
  const m = view && view.municipality;
  const regionDefault = (ctx && ctx.regionDefault) ||
    (m && m.lang && m.lang.default) || "nl";
  const override = (ctx && ctx.override) || _override || {};

  function t(key, vars) {
    let s;
    if (ctx && typeof ctx.t === "function") {
      try { s = ctx.t(key); } catch (_) { s = undefined; }
    }
    // main.js's t() returns the key when it knows nothing, so that is a miss.
    if (typeof s !== "string" || s === "" || s === key) {
      if (_t) { try { s = _t(key, lang); } catch (_) { s = undefined; } }
    }
    // The standalone path (createHereBand) has no shell and therefore no ctx.t,
    // but it has read web/data/i18n/en.json into _override, which carries every
    // key in HERE_UI_DEFAULTS. Prefer the shipped English to the copy compiled
    // into this file, so the two can never disagree on wording. It is ENGLISH,
    // so under another interface language it is marked like any other fallback.
    if (typeof s !== "string" || s === "" || s === key) {
      const ui = override && override.ui;
      const shipped = ui && ui[key];
      if (typeof shipped === "string" && shipped !== "") {
        s = lang === "en" ? shipped : shipped + UNTRANSLATED_MARK;
      }
    }
    if (typeof s !== "string" || s === "" || s === key) {
      s = HERE_UI_DEFAULTS[key];
      // Acceptance test 4, second clause. Falling back to this module's own
      // English under a Dutch or French interface IS an untranslated string,
      // and until this line existed it rendered unmarked, indistinguishable
      // from a translation. ui["flag.untranslated"] explains the asterisk.
      if (typeof s === "string" && s !== "" && lang !== "en") s += UNTRANSLATED_MARK;
    }
    if (typeof s !== "string" || s === "") s = key;   // never blank
    return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m)) : s;
  }

  function label(entity, kind) {
    const fns = [];
    if (ctx && typeof ctx.label === "function") fns.push(() => ctx.label(entity, kind));
    if (ctx && typeof ctx.resolveLabel === "function") {
      fns.push(() => ctx.resolveLabel(entity, kind, lang, ctx));
    }
    if (_resolveLabel) fns.push(() => _resolveLabel(entity, kind, lang, { override, regionDefault }));
    for (const fn of fns) {
      try {
        const r = fn();
        if (r && typeof r.text === "string" && r.text !== "") return r;
      } catch (_) { /* try the next */ }
    }
    return shimResolveLabel(entity, kind, lang, { override, regionDefault });
  }

  const metres = (ctx && typeof ctx.metres === "function")
    ? ctx.metres
    : (m) => formatDistance(m, lang);

  return { lang, t, label, metres };
}

/** A resolved label, plus an inline marker for the kinds that warrant one. */
function labelNodes(r, kind, api, flags) {
  if (!r.translated && !INLINE_MARKER[kind]) flags.endonym = true;
  const out = [el("span", { class: "name", lang: r.lang !== "?" ? r.lang : null, text: r.text })];
  if (!r.translated && INLINE_MARKER[kind]) {
    out.push(el("sup", {
      class: "untranslated",
      title: api.t("flag.untranslated"),
      "aria-label": api.t("flag.untranslated"),
      text: "*",
    }));
  }
  return out;
}

function fact(dl, key, term, ...nodes) {
  dl.appendChild(el("dt", { "data-fact": key, text: term }));
  dl.appendChild(el("dd", { "data-fact": key }, nodes));
  return dl;
}

/**
 * A fact whose value is honestly absent. It keeps its term, so the row still
 * says what is missing rather than vanishing, and it carries the same
 * `data-empty` taxonomy as a note so the two can never disagree.
 */
function emptyFact(dl, key, term, copy, empty) {
  dl.appendChild(el("dt", { "data-fact": key, text: term }));
  dl.appendChild(el("dd", {
    "data-fact": key,
    "data-state": "empty",
    "data-empty": empty || NOTHING.PUBLISHED_NOTHING,
  }, el("span", { class: "sub", text: copy })));
  return dl;
}

/** Six decimals is about 11 cm: the precision the baked coordinates carry. */
function coordText(fix, lang) {
  const dp = (v) => {
    try {
      return new Intl.NumberFormat(lang, {
        minimumFractionDigits: 6, maximumFractionDigits: 6, useGrouping: false,
      }).format(v);
    } catch (_) { return v.toFixed(6); }
  };
  return dp(fix.lat) + ", " + dp(fix.lon);
}

/** "Source: title (publisher), vintage" for the standalone path. */
function sourceText(view, api, ids) {
  const parts = [];
  for (const id of ids) {
    const s = view.sources[id];
    if (!s) continue;
    parts.push(s.title + " (" + s.publisher + "), " + s.vintage);
  }
  return parts.length ? api.t("here.source") + ": " + parts.join(" · ") : "";
}

const HERE_SOURCE_IDS = ["statbel_addr_sector_2025", "statbel_sectors_2025", "statbel_refnis_2025"];

/**
 * Render the body of the Here band into `el`.
 *
 * The shape is UI_SPEC 2.3's three: notes, field rows and (in this band) no
 * item cards. Reading order is the order the questions are asked in: the
 * address is the answer and goes first at display size, the administrative
 * facts follow as a `dl.facts` grid, the caveats follow those, and the raw
 * position and provenance close the panel.
 *
 * @param {Element} host  the band's div[data-role="body"]
 * @param {HereView} view @param {RenderApi} api
 * @param {{coverageOpen?: boolean, ownSourceLine?: boolean}} [state]
 */
export function renderHereBody(host, view, api, state = {}) {
  const flags = { endonym: false };
  const out = [];

  if (!view || !view.fix) {
    host.textContent = "";
    host.appendChild(note({
      layer: "position",
      empty: NOTHING.IDLE,
      kind: api.t("note.waiting"),
      body: api.t("empty.here.position"),
    }));
    return { endonym: false };
  }

  /* ---- the address, the biggest string in the band ---------------------- */
  const a = view.address;
  const m = view.municipality;
  if (a) {
    let streetNode;
    if (a.streetNames) {
      const r = api.label({ name: a.streetNames, id: String(a.streetId) }, "street");
      if (!r.translated) flags.endonym = true;
      streetNode = el("span", { class: "name", lang: r.lang !== "?" ? r.lang : null, text: r.text });
    } else {
      streetNode = el("span", { class: "name", "data-state": "pending" },
        el("span", { class: "code", text: "#" + a.streetId }));
    }
    const answer = el("p", { class: "answer", "data-layer": "address" }, streetNode);
    if (a.house !== "" && a.house !== null && a.house !== undefined) {
      answer.appendChild(document.createTextNode(" "));
      answer.appendChild(el("span", { class: "house", text: String(a.house) }));
    }
    out.push(answer);

    const sub = [];
    if (a.zip) {
      sub.push(el("span", { class: "code", "data-fact": "zip", text: a.zip }));
      sub.push(document.createTextNode(" · "));
    }
    sub.push(el("span", { class: "measure",
      text: api.t("here.away", { d: api.metres(a.distanceM) }) }));
    out.push(el("p", { class: "sub", "data-layer": "address-meta",
      "data-confidence": a.far ? "low" : null }, sub));

    // A confidence claim, not a failure: the answer above is still the best
    // one on this device, and this says how much to trust it.
    if (a.far) {
      out.push(note({
        layer: "address-far",
        kind: api.t("note.approx"),
        body: api.t("here.far", { d: api.metres(a.distanceM) }),
      }));
    }
    // <nis>/streets.json is baked and will land; the id above is a placeholder,
    // not a gap in the release.
    if (!a.streetNames) {
      out.push(note({
        layer: "streets",
        empty: NOTHING.PENDING,
        kind: api.t("note.pending"),
        body: api.t("empty.here.streets"),
      }));
    }
  } else if (m) {
    // In a municipality this release ships, and still no address within reach.
    // The pilot cities carry addresses and the ground between them does not.
    // Nothing failed; nothing was published here to begin with.
    out.push(note({
      layer: "address",
      empty: NOTHING.PUBLISHED_NOTHING,
      kind: api.t("note.nothing"),
      body: api.t("empty.here.address"),
    }));
  }
  // No `else`. Off the release there is no address BECAUSE the square is out
  // of scope, and the note below says exactly that. Two notes with two
  // different taxonomies for one cause would be two answers to one question.

  /* ---- off the release, UI_SPEC 2.5 ------------------------------------ */
  // No municipality resolves, so there is nothing to be missing: this square
  // was never in scope. Quiet tone, out-of-scope taxonomy, and the count of
  // baked municipalities comes from meta.json rather than from the sentence.
  if (!m) {
    const n = Array.isArray(view.shipped) ? view.shipped.length : null;
    out.push(note({
      layer: "municipality",
      empty: NOTHING.OUT_OF_SCOPE,
      kind: api.t("note.scope"),
      body: n !== null
        ? api.t("here.offrelease", { n: new Intl.NumberFormat(api.lang).format(n) })
        : api.t("empty.here.municipality"),
    }));
  }

  /* ---- the facts -------------------------------------------------------- */
  const dl = el("dl", { class: "facts" });

  // Sector. The polygon wins over the nearest address's own sector code,
  // because the nearest address can sit across a boundary.
  if (view.sector) {
    const bits = [];
    const s = view.sector;
    if (s.names && (s.names.nl || s.names.fr || s.names.de)) {
      const r = api.label({ name: s.names, id: s.code }, "sector");
      bits.push.apply(bits, labelNodes(r, "sector", api, flags));
      bits.push(document.createTextNode(" "));
    }
    bits.push(el("span", { class: "code", text: s.code }));
    bits.push(el("span", {
      class: "sub", "data-source": s.source,
      text: " · " + (s.source === "polygon"
        ? api.t("here.sector.polygon", { t: s.toleranceM === null || s.toleranceM === undefined ? "?" : s.toleranceM })
        : api.t("here.sector.address")),
    }));
    fact(dl, "sector", api.t("here.sector"), bits);
  } else if (m) {
    // In scope, and still no polygon hit: worth a row that says so. Off the
    // release the out-of-scope note above has already said it once, and saying
    // it twice would read as two separate faults.
    emptyFact(dl, "sector", api.t("here.sector"), api.t("empty.here.sector"),
      NOTHING.PUBLISHED_NOTHING);
  }

  // Municipality, plus its official names.
  if (m) {
    const r = api.label({ name: m.names || {}, id: m.nis }, "munty");
    fact(dl, "municipality", api.t("here.municipality"), labelNodes(r, "munty", api, flags));

    const official = (m.lang && Array.isArray(m.lang.official)) ? m.lang.official : [];
    const officialNodes = [];
    for (const lang of official) {
      const text = m.names && m.names[lang];
      if (!text) continue;
      if (officialNodes.length) officialNodes.push(document.createTextNode(" / "));
      officialNodes.push(el("span", { class: "name", lang, text }));
    }
    // In Brussels both official names are shown together, always, because two
    // official languages is the point (PLAN section 5). Elsewhere the single
    // official name is only worth a row when it differs from the label already
    // on screen; repeating "Andenne" under "Andenne" is noise, not honesty.
    const officialRedundant = official.length === 1 &&
      m.names && m.names[official[0]] === r.text;
    if (officialNodes.length && !officialRedundant) {
      dl.appendChild(el("dt", { "data-fact": "official",
        text: official.length > 1 ? api.t("here.official.both") : api.t("here.official") }));
      dl.appendChild(el("dd", { "data-fact": "official",
        "data-bilingual": official.length > 1 ? "true" : null }, officialNodes));
    }

    // Everything else the source authored, minus what is already on screen.
    const shown = new Set([r.text].concat(official.map((l) => m.names && m.names[l]).filter(Boolean)));
    const alt = [];
    for (const lang of ["nl", "fr", "de"]) {
      const text = m.names && m.names[lang];
      if (!text || shown.has(text)) continue;
      shown.add(text);
      if (alt.length) alt.push(document.createTextNode(" · "));
      alt.push(el("span", { class: "name", lang, text }));
      alt.push(el("span", { class: "sub", "aria-hidden": "true", text: " " + lang }));
    }
    if (alt.length) fact(dl, "alt", api.t("here.alt"), alt);

    fact(dl, "nis", api.t("here.nis"), el("span", { class: "code", text: m.nis }));
  }
  // No `else`. Off the release the out-of-scope note above is the answer, and
  // an empty "Municipality: —" row underneath it would read as a second,
  // separate failure of the same one thing.

  // District, province, region. `prov` is null for the 19 Brussels
  // municipalities, and that is a fact about Belgium, not a missing value.
  //
  // These carry their own resolver kinds (dstr / prov / rgn) rather than
  // "munty", for two reasons. The override has no group for them by design
  // (CONTRACT 8.1 budgets 565 municipalities, ~40 categories, ~45 chrome and
  // nothing else), so an inline "not available in English" marker on all three
  // would fire on every English render forever: crying wolf about our own
  // scope, which is exactly what CONTRACT 9.3 refuses to do for street names.
  // Falling outside the inline-marker kinds puts them under the one endonym
  // note instead. If the override ever grows a prov/rgn/dstr group, these keys
  // pick it up with no change here.
  const admin = (key, kind, rec) => {
    if (rec) {
      const r = api.label({ name: rec.names, id: rec.code }, kind);
      fact(dl, key, api.t("here." + key), labelNodes(r, kind, api, flags));
    } else if (key === "province" && m && m.rgn === "04000") {
      // Belgium's own answer, not a gap in ours: the Brussels-Capital Region
      // has no province. Out of scope by design, at the level of the country.
      emptyFact(dl, key, api.t("here.province"), api.t("empty.here.province"),
        NOTHING.OUT_OF_SCOPE);
    }
  };
  admin("district", "dstr", view.district);
  admin("province", "prov", view.province);
  admin("region", "rgn", view.region);

  // Postcodes: displayed, never joined on.
  if (m && m.zips.length) {
    const zips = [];
    m.zips.forEach((z, i) => {
      if (i) zips.push(document.createTextNode(" "));
      zips.push(el("span", { class: "code", text: z }));
    });
    fact(dl, "postcodes", api.t("here.postcodes"), zips);
  }

  // The raw position, last, because it is evidence for every row above it and
  // because a coordinate is one of the two things in this panel people copy
  // (the other is the cell id, on the line below the facts).
  fact(dl, "coords", api.t("here.position"),
    el("span", { class: "code", text: coordText(view.fix, api.lang) }));

  if (dl.childNodes.length) out.push(dl);

  // The sentence that makes acceptance test 2 visible rather than merely true.
  if (m && m.zips.length) {
    const muntyText = api.label({ name: m.names || {}, id: m.nis }, "munty").text;
    out.push(el("p", { class: "sub", "data-layer": "postcode-note",
      text: m.zips.length > 1
        ? api.t("here.postcodes.note", { name: muntyText, n: String(m.zips.length) })
        : api.t("here.postcodes.note.one") }));
  }

  /* ---- what this release does not ship --------------------------------- */
  if (view.foreign.length) {
    const rows = el("ul", { class: "rows" });
    for (const f of view.foreign) {
      const name = f.names ? api.label({ name: f.names, id: f.nis }, "munty").text : f.nis;
      rows.appendChild(el("li", {},
        el("span", { class: "name", text: name }),
        el("span", { class: "meta",
          text: api.t("here.coverage.item", { n: new Intl.NumberFormat(api.lang).format(f.count) }) })
      ));
    }
    out.push(el("details", { "data-layer": "coverage", open: state.coverageOpen ? true : null },
      el("summary", {},
        document.createTextNode(api.t("here.coverage")),
        el("span", { class: "count", text: String(view.foreign.length) })),
      el("div", { class: "disclosure-body" },
        el("p", { class: "sub", text: api.t("here.coverage.intro") }),
        rows)
    ));
  }

  /* ---- position and provenance ----------------------------------------- */
  const posBits = [];
  if (view.fix.accuracy > 0) {
    posBits.push(el("span", { class: "measure",
      text: api.t("here.accuracy", { d: api.metres(view.fix.accuracy) }) }));
    posBits.push(document.createTextNode(" · "));
  }
  posBits.push(el("span", { class: "code", "data-fact": "cell", text: view.cell || "" }));
  if (view.fix.at) {
    posBits.push(document.createTextNode(" · "));
    // Stamped once, at paint. Nothing ticks: a ticking clock is a poll.
    posBits.push(el("time", { datetime: new Date(view.fix.at).toISOString(),
      text: new Date(view.fix.at).toTimeString().slice(0, 5) }));
  }
  out.push(el("p", { class: "sub", "data-layer": "position" }, posBits));

  if (view.fix.source === "manual") {
    out.push(note({ layer: "position-manual", body: api.t("here.manual") }));
  }
  if (!view.online) {
    out.push(el("p", { class: "sub", "data-layer": "offline", text: api.t("here.local") }));
  }

  // One note per panel, never one marker per street (CONTRACT 9.3).
  if (flags.endonym) {
    out.push(el("p", { class: "endonym", text: api.t("flag.endonym") }));
  }

  // UI_SPEC 2.5, "the source lines, verbatim": the band says WHY its sources
  // are what they are, in a second line at the same size as the source line
  // itself. It comes first because it reads as the lead-in to it, and because
  // under the shell the source line is p.src[data-role="src"], a sibling of
  // this body that main.js owns and that this module must not write into.
  // No date is written into the sentence; every vintage is in the line below.
  out.push(el("p", { class: "src src__why", "data-layer": "why", text: api.t("here.src.why") }));

  if (state.ownSourceLine) {
    const line = sourceText(view, api, HERE_SOURCE_IDS);
    if (line) out.push(el("p", { class: "src", "data-role": "own-src", text: line }));
  }

  host.textContent = "";
  for (const n of out) host.appendChild(n);
  return flags;
}

/* =====================================================================
 * 7. WHAT THE MAP READS FROM THIS BAND
 * =====================================================================
 *
 * UI_SPEC 1.4: "Which sector you are in is decided by here.js's existing
 * point-in-polygon. The map asks here.js, it does not re-derive it. There is
 * one sector authority in this app."
 *
 * This band already resolves the three things map.js draws as vector layers,
 * so it publishes them rather than making map.js resolve them a second time:
 *
 *   layer 3, the 1 km cell      <- `cell`, a GRD_NEWID that map.js turns into
 *                                  four corners with grid.js cellRing()
 *   layer 4, the sector polys   <- `sectors`, the decoded sector.geojson, plus
 *                                  `sector`, the code of the one you stand in
 *   layers 5 and 7, the dot     <- `position`, including `accuracy` in metres,
 *                                  which is the radius of the accuracy circle
 *
 * and one thing dock.js reads: `state`, which is the pill's state dot
 * (`answers` / `nothing` / `idle`), and `sector` / `nis`, which is the pill's
 * count string (UI_SPEC 2.2, keys `pill.here.nis`, `pill.none`, `pill.idle`).
 * The formatting of that string stays in dock.js, where the key lives.
 *
 * THREE DELIVERY PATHS, because the shell has not been written yet and this
 * module must not care which one it picks:
 *
 *   1. `ctx.onHere(state)` or `ctx.onMapState(state)`, if the context carries
 *      one. main.js can add it in BAND_ADAPTER.here.mountOptions with no other
 *      change; `mountOptions` is already Object.assign'd onto the context.
 *   2. A `behere:here` CustomEvent on the band body, bubbling, `detail` = the
 *      state. Listen on the section, on #dock-panel or on the document.
 *   3. `handle.mapState`, on the object mount() returns, which main.js already
 *      keeps in `app.bands.get("here").controller`. Poll-free: it is the value
 *      the last paint published.
 *
 * The state object is FROZEN. It is a read model, not a channel: map.js may
 * not write to it, and `sectors` is the same FeatureCollection instance this
 * module resolves against, so no copy is made of up to 150 KB of geometry.
 */

/** The bubbling event name, exported so a listener cannot mistype it. */
export const HERE_EVENT = "behere:here";

/**
 * @typedef {Object} HereMapState
 * @property {"answers"|"nothing"|"idle"} state  pill state dot, UI_SPEC 2.2
 * @property {"centre"|"full"|"refined"} phase
 * @property {?{lat:number, lon:number, accuracy:number, at:number, source:?string}} position
 * @property {?string} cell        centre GRD_NEWID, the 1 km cell path
 * @property {string[]} cells      the nine cell ids read so far
 * @property {?string} nis
 * @property {?Object} sectors     decoded <nis>/sector.geojson, or null
 * @property {?string} sectorsFor  the NIS `sectors` belongs to
 * @property {?string} sector      properties.s of the sector you are standing in
 * @property {"polygon"|"address"|null} sectorSource  how that was decided
 * @property {?number} sectorToleranceM   the simplification the polygons carry
 * @property {?{lat:number, lon:number, distanceM:number, far:boolean}} address
 * @property {?string} vintage
 */

const EMPTY_MAP_STATE = Object.freeze({
  state: "idle", phase: "centre",
  position: null, cell: null, cells: [], nis: null,
  sectors: null, sectorsFor: null,
  sector: null, sectorSource: null, sectorToleranceM: null,
  address: null, vintage: null,
});

/**
 * Project a HereView onto what the map and the dock need. Pure, exported, and
 * testable without a DOM.
 *
 * @param {?HereView} view
 * @param {{sectors?: ?Object, sectorsFor?: ?string}} [opts]
 * @returns {HereMapState}
 */
export function hereMapState(view, opts = {}) {
  if (!view || !view.fix) return EMPTY_MAP_STATE;
  const s = view.sector;
  const a = view.address;
  const answers = !!(view.municipality || view.sector || view.address);
  return Object.freeze({
    // "nothing" is not an error. It is the honest reading of a square this
    // release does not cover, and UI_SPEC 2.2 gives it a hollow dot, not a
    // warn one.
    state: answers ? "answers" : "nothing",
    phase: view.phase,
    position: Object.freeze({
      lat: view.fix.lat,
      lon: view.fix.lon,
      accuracy: typeof view.fix.accuracy === "number" ? view.fix.accuracy : 0,
      at: view.fix.at || 0,
      source: view.fix.source || null,
    }),
    cell: view.cell || null,
    cells: Object.freeze((view.cells || []).slice()),
    nis: view.nis || null,
    sectors: opts.sectors || null,
    sectorsFor: opts.sectors ? (opts.sectorsFor || view.nis || null) : null,
    sector: s ? s.code : null,
    sectorSource: s ? s.source : null,
    sectorToleranceM: s && s.toleranceM !== undefined ? s.toleranceM : null,
    address: a ? Object.freeze({
      lat: a.lat, lon: a.lon, distanceM: a.distanceM, far: !!a.far,
    }) : null,
    vintage: view.vintage || null,
  });
}

/** Cheap identity for a published state, so an unchanged paint stays silent. */
function mapSignature(s) {
  const p = s.position;
  return [
    s.state, s.phase, p ? p.lat : "", p ? p.lon : "", p ? p.accuracy : "",
    s.cell, s.nis, s.sector, s.sectorSource, s.sectorsFor,
    s.address ? s.address.distanceM : "",
  ].join("|");
}

/**
 * Hand one state to every listener that asked for it, once.
 *
 * `dispatchEvent` and `CustomEvent` are both feature-detected: this module is
 * mounted against a four-method fake DOM in scripts/test_i18n_marker.mjs, and
 * a band module that only works in a real browser cannot be tested headlessly.
 */
function publishMapState(node, sinks, state, last) {
  if (last && last.sig === mapSignature(state)) return last;
  for (const sink of sinks) {
    if (typeof sink !== "function") continue;
    try { sink(state); } catch (err) { console.error("BeHERE: here map sink failed", err); }
  }
  if (node && typeof node.dispatchEvent === "function" && typeof CustomEvent === "function") {
    try {
      node.dispatchEvent(new CustomEvent(HERE_EVENT, {
        detail: state, bubbles: true,
      }));
    } catch (_) { /* a DOM without CustomEvent still gets the callbacks */ }
  }
  return { sig: mapSignature(state), state };
}

/* =====================================================================
 * 7b. mount(el, ctx): the band module entry main.js calls
 * ===================================================================== */

/** Cached sector geometry per NIS, so a repaint never refetches. */
let _sectorNis = null;
let _sectorFC = null;
let _override = null;

/**
 * @param {Element} host  the band's div[data-role="body"]
 * @param {Object} ctx    main.js's BeHereContext, optionally carrying
 *                        `onHere` / `onMapState`, a (HereMapState) => void
 * @returns {{update: (ctx: Object) => void, mapState: HereMapState,
 *            getMapState: () => HereMapState}}
 */
export function mount(host, ctx) {
  let coverageOpen = false;
  let published = null;

  function paint(c) {
    const view = viewFromContext(c, _sectorFC);
    const api = makeApi(c, view);
    renderHereBody(host, view, api, { coverageOpen, ownSourceLine: typeof c.setSources !== "function" });

    const d = host.querySelector("details");
    if (d) d.addEventListener("toggle", () => { coverageOpen = d.open; });

    // Acceptance test 8, via the band's own source slot. main.js joins each id
    // to meta.json.sources and prints title, publisher and vintage date.
    if (typeof c.setSources === "function") {
      c.setSources("here", HERE_SOURCE_IDS[0], HERE_SOURCE_IDS[1], HERE_SOURCE_IDS[2]);
    }

    // The map is fed AFTER the text, always. The band is the answer; the map
    // is the answer drawn. If the two ever disagree the text is the one that
    // has to be right, and it is the one a screen reader gets.
    published = publishMapState(host, [c.onHere, c.onMapState],
      hereMapState(view, { sectors: _sectorFC, sectorsFor: _sectorNis }), published);
  }

  /** The sector polygon is the one file main.js does not load. Fetch it once
   *  per municipality, off the paint path, then repaint with the refinement. */
  function ensureSector(c) {
    const nis = c.nis || (c.nearest && c.nearest.nis) || null;
    if (!nis || nis === _sectorNis) return;
    _sectorNis = nis;
    _sectorFC = null;
    readSectors(nis)
      .then((fc) => {
        if (_sectorNis !== nis) return;      // the user moved on
        _sectorFC = fc;
        paint(ctxRef);
      })
      .catch(() => { /* collapses to the address-derived sector */ });
  }

  let ctxRef = ctx;
  paint(ctx);
  ensureSector(ctx);
  ensureI18n().then(() => paint(ctxRef));

  return {
    update(next) {
      ctxRef = next;
      paint(next);
      ensureSector(next);
    },

    /** The last state handed to the map. See section 7. */
    get mapState() { return published ? published.state : EMPTY_MAP_STATE; },
    getMapState() { return published ? published.state : EMPTY_MAP_STATE; },
  };
}

/* Aliases, so main.js's entry-point probe cannot miss it. */
export const init = mount;
export default mount;

/* =====================================================================
 * 8. Standalone band, for offline.html and tests
 * ===================================================================== */

/**
 * Mount a complete Here band, header included, and drive it from `update(fix)`.
 * Used where main.js's spine is absent. It reads the same baked files through
 * geo.js and renders the same body.
 *
 * `onMunicipality` fires once per NIS change so a host can default the UI
 * language from the municipality rather than the browser (acceptance test 5).
 *
 * `onMapState` / `onHere` get the same HereMapState the shell path publishes,
 * and the same `behere:here` event bubbles off the section, so a host that
 * drives this band alone can still draw the map (section 7).
 *
 * @param {Element} root
 * @param {{lang?:string, onMunicipality?:Function, onResolve?:Function,
 *          onMapState?:Function, onHere?:Function}} [options]
 */
export function createHereBand(root, options = {}) {
  const section = el("section", {
    class: "band", id: "band-here", "data-band": "here", "data-state": "idle",
    "aria-labelledby": "h-here",
  },
    el("header", {},
      el("h2", { id: "h-here", "data-i18n": "band.here", text: "Here" })),
    el("div", { class: "band-body", "data-role": "body" })
  );
  root.appendChild(section);

  const host = section.querySelector('[data-role="body"]');
  let lang = options.lang || "en";
  let controller = null;
  let lastNis = null;
  let coverageOpen = false;
  let lastView = null;
  let published = null;
  let sectorFC = null;
  let sectorNis = null;

  /** resolveHere() has already read this file; geo.js caches it per NIS, so
   *  this second call is a cache hit and never a second request. It exists
   *  because the view model carries the resolved sector but not the geometry,
   *  and the geometry is what the map draws. */
  function ensureSector(nis) {
    if (!nis || nis === sectorNis) return;
    sectorNis = nis;
    sectorFC = null;
    readSectors(nis).then((fc) => {
      if (sectorNis !== nis) return;
      sectorFC = fc;
      if (lastView) paint(lastView);
    }).catch(() => { /* the band still answers; the map draws one layer less */ });
  }

  function paint(view) {
    lastView = view;
    const api = makeApi({ lang, override: _override }, view);
    // UI_SPEC 2.5: "empty" is a state this band can legitimately be in, and it
    // is not "error". A square off the release resolves perfectly; there is
    // simply nothing baked under it.
    section.setAttribute("data-state", !view || !view.fix
      ? "idle"
      : (view.municipality || view.address || view.sector ? "ready" : "empty"));
    section.setAttribute("data-phase", view ? view.phase : "none");
    renderHereBody(host, view, api, { coverageOpen, ownSourceLine: true });
    const d = host.querySelector("details");
    if (d) d.addEventListener("toggle", () => { coverageOpen = d.open; });

    if (view && view.municipality && view.municipality.nis !== lastNis) {
      lastNis = view.municipality.nis;
      if (options.onMunicipality) options.onMunicipality(view.municipality);
      section.dispatchEvent(new CustomEvent("behere:municipality", {
        detail: view.municipality, bubbles: true,
      }));
    }

    if (view && view.nis) ensureSector(view.nis);
    published = publishMapState(section, [options.onHere, options.onMapState],
      hereMapState(view, { sectors: sectorFC, sectorsFor: sectorNis }), published);
  }

  const api = {
    get element() { return section; },
    get view() { return lastView; },

    async update(fix) {
      if (controller) controller.abort();
      controller = new AbortController();
      const signal = controller.signal;
      await ensureI18n();
      if (!_override) {
        const r = await readOverride();
        _override = r.ok && r.data ? r.data : {};
      }
      try {
        const view = await resolveHere(fix, {
          signal,
          onPartial: (v) => { if (!signal.aborted) paint(v); },
        });
        if (signal.aborted) return;
        paint(view);
        if (options.onResolve) options.onResolve(view);
      } catch (err) {
        if (err && err.name === "AbortError") return;
        section.setAttribute("data-state", "error");
      }
    },

    /** Report a geolocation failure: the band names what is missing.
     *
     *  A DENIED permission is not a fault of this app and does not get the
     *  warn tone: the user switched location off and the band says so calmly.
     *  A device that tried and could not answer is the one case in this band
     *  where UI_SPEC 2.5's third situation, "could not be reached", is real,
     *  and it is the device that could not be reached, never a data source. */
    fail(geoError) {
      const denied = !!(geoError && geoError.kind === "denied");
      section.setAttribute("data-state", denied ? "denied" : "error");
      const a = makeApi({ lang }, { municipality: null });
      host.textContent = "";
      host.appendChild(note({
        layer: "position",
        empty: denied ? NOTHING.IDLE : NOTHING.UNREACHABLE,
        tone: denied ? "quiet" : "warn",
        kind: a.t(denied ? "note.waiting" : "note.unreachable"),
        body: a.t("empty.here.position"),
      }));
      lastView = null;
      published = publishMapState(section, [options.onHere, options.onMapState],
        EMPTY_MAP_STATE, published);
    },

    /** Repaint in another language. No refetch: everything is already local. */
    setLang(next) { lang = next; if (lastView) paint(lastView); },

    /** The last state handed to the map. See section 7. */
    get mapState() { return published ? published.state : EMPTY_MAP_STATE; },
    getMapState() { return published ? published.state : EMPTY_MAP_STATE; },

    destroy() { if (controller) controller.abort(); section.remove(); },
  };

  paint(null);
  return api;
}

/** Standalone band driven by the debounced device watcher in geo.js. */
export function startHere(root, options = {}) {
  const band = createHereBand(root, options);
  const w = watchPosition({
    onPosition: (fix) => band.update(fix),
    onError: (e) => band.fail(e),
  }, options.watch || {});
  band.stop = () => { w.stop(); band.destroy(); };
  band.push = w.push;   // inject a position by hand, for desktop testing
  return band;
}

/** Exported for tests and for a host that wants the 9 cell ids. */
export { neighbours };

/*
 * ---------------------------------------------------------------------------
 * MARKUP CONTRACT: what this module writes into div.band-body[data-role=body]
 * ---------------------------------------------------------------------------
 * Classes are app.css's existing vocabulary, unchanged by the map-first
 * revamp: UI_SPEC 4.2 restyles every one of them and renames none. Everything
 * else here is a data-* hook, so no new CSS is required for the band to be
 * legible, and any hook below can be styled without touching this file.
 *
 * NO ICONS ARE DRAWN HERE. app/icons.js exists for the map chrome; inside a
 * band body every icon Organic would use sits beside text that already says
 * the same thing, the disclosure marker stays app.css's rotating triangle
 * (UI_SPEC 4.2), and icons.js needs document.createElementNS, which the
 * four-method DOM in scripts/test_i18n_marker.mjs does not have. A band body
 * that cannot be rendered headlessly cannot be tested.
 *
 *   p.answer[data-layer="address"]
 *       span.name[lang]              the street, in its authored language
 *       span.house                   the house number ("225A" is a string)
 *   p.sub[data-layer="address-meta"][data-confidence="low"?]
 *       span.code[data-fact="zip"]   the postcode, DISPLAY ONLY
 *       span.measure                 "18 m from you"
 *
 *   p.quiet[data-layer=L][data-tone="quiet"|"warn"][data-empty=E?]
 *       strong.note__kind            the kind label, e.g. "PUBLISHED NOTHING"
 *       span.note__body              the sentence
 *     L is one of: position, address, address-far, streets, municipality,
 *                  position-manual
 *     E is one of: published-nothing, out-of-scope, unreachable, pending, idle
 *
 *     UI_SPEC 2.5 is the whole point of E. `published-nothing` and
 *     `out-of-scope` are NOT faults and keep the quiet tone; `unreachable` is
 *     the only fault and the only warn tone in this band, and it can only ever
 *     be the device's own geolocation, because nothing this band shows is
 *     fetched at runtime.
 *
 *     app.css MUST give .note__kind `display: block` (UI_SPEC 2.3 gives it
 *     11px / .08em / uppercase / opacity .72 / margin-bottom 4px). Without
 *     that rule the kind and the body run together on one line; nothing else
 *     breaks.
 *
 *   dl.facts
 *     dt[data-fact=KEY] / dd[data-fact=KEY][data-state="empty"?][data-empty=E?]
 *     KEY is one of: sector, municipality, official, alt, nis,
 *                    district, province, region, postcodes, coords
 *     dd[data-fact="official"][data-bilingual="true"]   Brussels, both names
 *     inside a dd: span.name[lang], span.code, sup.untranslated,
 *                  span.sub[data-source="polygon"|"address"]
 *
 *   p.sub[data-layer="postcode-note"]   "1000 spans 10 postcodes ..."
 *
 *   details[data-layer="coverage"]
 *     summary > text + span.count
 *     div.disclosure-body > p.sub + ul.rows > li > span.name + span.meta
 *
 *   p.sub[data-layer="position"]     accuracy, cell id, time of the fix
 *   p.sub[data-layer="offline"]
 *   p.endonym                        one per panel, never one per street
 *   p.src.src__why[data-layer="why"]  why these sources and no others
 *   p.src[data-role="own-src"]       standalone path only; under main.js the
 *                                    band's own p.src[data-role=src] is filled
 *                                    through ctx.setSources()
 *
 * Standalone only, from createHereBand():
 *   section.band#band-here[data-band="here"][data-state][data-phase]
 *     > header > h2#h-here
 *     > div.band-body[data-role="body"]
 *   data-state is idle | ready | empty | denied | error. `empty` means the
 *   square resolved and is off the release; it is not `error`.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE SHELL PASSES TO THE MAP
 * ---------------------------------------------------------------------------
 * Section 7 is the full account. In one line each:
 *
 *   hereMapState(view, {sectors})  pure projection of the view model
 *   ctx.onHere / ctx.onMapState    a callback on the context, if there is one
 *   "behere:here"                  a bubbling CustomEvent, detail = the state
 *   handle.mapState                the last published state, on mount()'s
 *                                  return value and on createHereBand()'s
 *
 * and the fields, all frozen:
 *
 *   position {lat, lon, accuracy, at, source}   the dot and the accuracy ring
 *   cell, cells                                 the 1 km GRD_NEWID path
 *   sectors, sectorsFor, sector, sectorSource, sectorToleranceM
 *                                               the sector polygons, and which
 *                                               one you stand in. THIS MODULE
 *                                               IS THE ONE SECTOR AUTHORITY
 *   nis, vintage, phase, address
 *   state  "answers" | "nothing" | "idle"       the pill's state dot
 * ---------------------------------------------------------------------------
 */
