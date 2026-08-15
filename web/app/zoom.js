/**
 * BeHERE "Zoom out" band: arrondissement and country context.
 *
 * PLAN section 6 lists this band and names its feed: the Statbel high-value
 * datasets API. PLAN section 1 also says what it must never become:
 *
 *   "Not a municipality comparator. No league tables, no rankings, no 'your
 *    town versus theirs'. Zooming out to province and country replaces
 *    comparison with context."
 *
 * So this band shows the arrondissement you are standing in, and Belgium, and
 * nothing in between. There is no second municipality on the screen, ever.
 *
 * ---------------------------------------------------------------------------
 * WHY IT KEYS ON nuts3 AND dstr, NEVER ON THE MUNICIPALITY NIS
 * ---------------------------------------------------------------------------
 * CONTRACT 10.3, re-verified against the live API on 2026-08-15:
 *
 *   - column names are UPPERCASE; `cd_refnis=eq.44021` returns HTTP 400
 *   - the schema differs per table: tf_hvd_demo_population has no CD_REFNIS at
 *     all and keys on CD_NUTS_LVL3, while tf_hvd_demo_fertility and
 *     tf_hvd_demo_mortality key on CD_REFNIS plus CD_NUTS_LEVEL
 *   - NO table reaches municipality level. CD_NUTS_LEVEL stops at 3, the
 *     arrondissement, where CD_REFNIS is 44000, not 44021
 *
 * Both keys come from web/data/<nis>/meta.json (`nuts3`, `dstr`), which is
 * baked at the pinned 2025-01-01 vintage.
 *
 * ---------------------------------------------------------------------------
 * EVERY NUMBER PASSES THROUGH THE VINTAGE GUARD
 * ---------------------------------------------------------------------------
 * PLAN acceptance test 3: "A statistic from a pre-2025 vintage either passes
 * through nis_history.json or is refused, never silently dropped."
 *
 * That is not a hypothetical here. The demographic series reach back to 1992
 * and the newest crude birth and death rates are from 2022, so EVERY value
 * this band can draw is older than the pin. Two joins are checked for each of
 * them, because a municipal reform can move either end of the join:
 *
 *   1. the arrondissement code itself. The 2019 Hainaut reform created
 *      arrondissements 55000 (La Louviere) and 57000 (Mouscron), which did not
 *      exist when an older figure was measured
 *   2. the municipality you are standing in. Manage moved from arrondissement
 *      52000 to 55086/55000 in the same reform, so "this figure describes your
 *      district" is false for a 2015 number even though the district code is
 *      perfectly current
 *
 * Both go through stats.js joinStatistic(). A refusal prints a sentence in
 * place of the number; an aggregate prints the number with a marker and copy
 * naming the retired codes. Nothing is ever silently dropped, and no value is
 * rendered that did not come back ok:true.
 *
 * ---------------------------------------------------------------------------
 * NETWORK BUDGET
 * ---------------------------------------------------------------------------
 * Five GETs per arrondissement, all keyless, all 24 h cached by geo.js and by
 * the service worker (CONTRACT 10.3: "cache hard, this data changes yearly").
 * There is no polling loop; update() only refetches when the arrondissement
 * changes or the previous attempt failed.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE MAP-FIRST REVAMP CHANGED HERE
 * ---------------------------------------------------------------------------
 * Presentation, and one attribute. The band renders into the pill-overlay
 * panel of docs/UI_SPEC.md: notes carry a kind label and a tone, the figures
 * are cards in `ul.stats`, and the two join keys are on screen so the claim
 * this file's title makes can be checked rather than trusted. The one
 * behavioural change is that an unreachable Statbel now sets the section to
 * data-state="error" rather than "empty", because UI_SPEC 2.5 insists that
 * "published nothing", "out of scope by design" and "could not be reached"
 * are three different claims and only the last is a fault.
 *
 * The endpoint, the folds, the keys, the five-GET budget and every path
 * through the vintage guard are untouched. This band draws nothing on the map:
 * an arrondissement is not a place, it is a level.
 *
 * Plain ES module. No build step, no bundler, no dependency outside this repo.
 */

import { fetchJSON, TTL, readNisHistory } from "./geo.js";
import { joinStatistic, indexHistory, JOIN, needsAggregateMarker } from "./stats.js";

/* =====================================================================
 * 1. Copy
 * ===================================================================== */

/* English defaults so no string is ever blank. They are also the authored
 * source for web/data/i18n/*.json: scripts/check_i18n.py reads the table below
 * and fails the build when a key here is missing from any shipped language. */
export const ZOOM_UI_DEFAULTS = Object.freeze({
  "band.zoomout": "Zoom out",

  /* The note kind labels, UI_SPEC 2.3, declared here as well as in here.js
   * because scripts/check_i18n.py reads each band's own table and a shared key
   * asked for by two bands has to be visible in both. The kind is what makes
   * UI_SPEC 2.5's three situations distinguishable without reading the whole
   * sentence, and this band is the one band in the app that can be in all
   * three: Statbel is a live source. */
  "note.waiting": "Waiting for a position",
  "note.nothing": "Published nothing",
  "note.scope": "Out of scope by design",
  "note.unreachable": "Could not be reached",

  "zoom.district": "Arrondissement",
  "zoom.country": "Belgium",
  "zoom.year": "{y}",
  "zoom.population": "Inhabitants",
  "zoom.medianage": "Median age",
  "zoom.medianage.value": "{m} / {f}",
  "zoom.medianage.note": "men / women, in years",
  "zoom.dependency": "Old-age dependency",
  "zoom.dependency.note": "people of 65 and over per person of working age",
  "zoom.birthrate": "Births per 1,000",
  "zoom.deathrate": "Deaths per 1,000",
  "zoom.context": "Context for the arrondissement you are standing in, and for Belgium. BeHERE does not rank municipalities.",
  "zoom.asof": "Statistics as of {when}.",
  "zoom.stale": "Statbel could not be reached. These are the last figures stored on this device.",

  "empty.zoom.position": "Zoom-out context appears once your position is known.",
  "empty.zoom.municipality": "This position is outside the municipalities in this release, so no arrondissement can be named.",
  "empty.zoom.nuts3": "This municipality record carries no arrondissement code, so Statbel cannot be queried for it.",
  "empty.zoom.offline": "Statbel statistics need a network and nothing has been stored for this arrondissement yet.",
  "empty.zoom.unreachable": "Statbel could not be reached, and nothing from it is stored on this device yet.",
  "empty.zoom.novalues": "Statbel answered for this arrondissement but published none of the figures this band shows.",

  "zoom.refused": "Not shown: {why}",
  "zoom.aggregate": "Aggregate across two municipal vintages: {why}",

  /* UI_SPEC 2.5, "the source lines, verbatim". The second line under the
   * source line: why these keys and no others. No date is written into it;
   * every vintage comes from meta.json through setSources(). */
  "zoom.src.why": "Queries key on nuts3 and dstr. No Statbel table reaches municipality level.",
});

/** The keys this band asks for, exported so the i18n files can be diffed. */
export const ZOOM_UI_KEYS = Object.freeze(Object.keys(ZOOM_UI_DEFAULTS));

/** meta.json source ids this band is fed by (acceptance test 8). */
export const ZOOM_SOURCE_IDS = Object.freeze(["statbel_hvd"]);

/* =====================================================================
 * 2. The endpoint
 * ===================================================================== */

/** CONTRACT 10.3. Keyless, CORS echoes the origin, listed in the CSP. */
const HVD = "https://opendata-api.statbel.fgov.be/";

/** Trim the payload: these tables are wide and we need eleven columns. */
const POP_SELECT = [
  "CD_YEAR", "CD_SEX", "CD_AGE", "CD_PROPERTY", "MS_VALUE",
  "TX_NUTS_LVL3_DESCR_NL", "TX_NUTS_LVL3_DESCR_FR", "TX_NUTS_LVL3_DESCR_EN",
].join(",");

const RATE_SELECT = ["CD_YEAR", "CD_REFNIS", "CD_NUTS", "MS_VALUE"].join(",");

/**
 * The latest year in tf_hvd_demo_population is a single year with 45 rows
 * (21 age bands x 2 sexes, plus median age and the dependency ratio), so one
 * ordered page of 100 always contains all of it.
 */
const POP_PAGE = 100;

function popUrl(nuts3) {
  return HVD + "tf_hvd_demo_population?CD_NUTS_LVL3=eq." + encodeURIComponent(nuts3) +
    "&order=CD_YEAR.desc&limit=" + POP_PAGE + "&select=" + POP_SELECT;
}

function rateUrl(table, property, where) {
  return HVD + table + "?" + where + "&CD_PROPERTY=eq." + property +
    "&order=CD_YEAR.desc&limit=1&select=" + RATE_SELECT;
}

/* =====================================================================
 * 3. Reading one arrondissement
 * ===================================================================== */

/**
 * @typedef {Object} ZoomFigures
 * @property {?string} nuts3 @property {?string} dstr
 * @property {Object} names   {nl, fr, en} arrondissement name, authored by Statbel
 * @property {?number} popYear @property {?number} population
 * @property {?number} medianAgeM @property {?number} medianAgeF
 * @property {?number} dependency
 * @property {?{year:number, value:number}} birthRate
 * @property {?{year:number, value:number}} birthRateBE
 * @property {?{year:number, value:number}} deathRate
 * @property {?{year:number, value:number}} deathRateBE
 * @property {number} at        epoch ms the newest of the five reads landed
 * @property {boolean} stale    served past its TTL, or from cache with no network
 * @property {boolean} reached  at least one of the five reads returned data
 */

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Fold the population page into the figures it carries. */
function foldPopulation(rows) {
  const out = {
    names: {}, popYear: null, population: null,
    medianAgeM: null, medianAgeF: null, dependency: null,
  };
  if (!Array.isArray(rows) || !rows.length) return out;

  let latest = null;
  for (const r of rows) {
    const y = num(r && r.CD_YEAR);
    if (y !== null && (latest === null || y > latest)) latest = y;
  }
  if (latest === null) return out;
  out.popYear = latest;

  let pop = 0;
  let sawPop = false;
  for (const r of rows) {
    if (!r || num(r.CD_YEAR) !== latest) continue;
    if (!out.names.nl && r.TX_NUTS_LVL3_DESCR_NL) {
      out.names = {
        nl: r.TX_NUTS_LVL3_DESCR_NL || "",
        fr: r.TX_NUTS_LVL3_DESCR_FR || "",
        en: r.TX_NUTS_LVL3_DESCR_EN || "",
      };
    }
    const v = num(r.MS_VALUE);
    if (v === null) continue;
    if (r.CD_PROPERTY === "MS_POP") {
      // Rows are one per sex per five-year band; there is no TOTAL row, which
      // is why this sums rather than filters. Verified on 2026-08-15: BE234
      // 2023 carries 42 MS_POP rows, 21 bands x M and F.
      pop += v;
      sawPop = true;
    } else if (r.CD_PROPERTY === "MS_MEDIAN_AGE") {
      if (r.CD_SEX === "M") out.medianAgeM = v;
      else if (r.CD_SEX === "F") out.medianAgeF = v;
    } else if (r.CD_PROPERTY === "MS_DEPENDENCY_RATE") {
      out.dependency = v;
    }
  }
  if (sawPop) out.population = Math.round(pop);
  return out;
}

function foldRate(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const r = rows[0];
  const y = num(r && r.CD_YEAR);
  const v = num(r && r.MS_VALUE);
  if (y === null || v === null) return null;
  return { year: y, value: v };
}

/**
 * Five keyless GETs, all cached 24 h. Never throws: a failure becomes
 * `reached: false` and the band collapses with copy naming Statbel.
 * @param {string} nuts3 @param {string} dstr @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<ZoomFigures>}
 */
export async function readArrondissement(nuts3, dstr, opts = {}) {
  const ttl = TTL.statbel_hvd;
  const signal = opts.signal;
  const dstrWhere = "CD_NUTS_LEVEL=eq.3&CD_REFNIS=eq." + encodeURIComponent(dstr);
  const beWhere = "CD_NUTS_LEVEL=eq.0";

  const reads = [
    fetchJSON(popUrl(nuts3), { ttl, signal }),
    fetchJSON(rateUrl("tf_hvd_demo_fertility", "MS_CRUDE_BIRTH_RATE", dstrWhere), { ttl, signal }),
    fetchJSON(rateUrl("tf_hvd_demo_fertility", "MS_CRUDE_BIRTH_RATE", beWhere), { ttl, signal }),
    fetchJSON(rateUrl("tf_hvd_demo_mortality", "MS_CRUDE_DEATH_RATE", dstrWhere), { ttl, signal }),
    fetchJSON(rateUrl("tf_hvd_demo_mortality", "MS_CRUDE_DEATH_RATE", beWhere), { ttl, signal }),
  ];
  const [pop, birth, birthBE, death, deathBE] = await Promise.all(
    reads.map((p) => p.catch(() => null))
  );

  const parts = [pop, birth, birthBE, death, deathBE];
  const ok = parts.filter((r) => r && r.ok && r.data);
  const figures = Object.assign(
    { nuts3, dstr, birthRate: null, birthRateBE: null, deathRate: null, deathRateBE: null },
    foldPopulation(pop && pop.ok ? pop.data : null)
  );
  figures.birthRate = foldRate(birth && birth.ok ? birth.data : null);
  figures.birthRateBE = foldRate(birthBE && birthBE.ok ? birthBE.data : null);
  figures.deathRate = foldRate(death && death.ok ? death.data : null);
  figures.deathRateBE = foldRate(deathBE && deathBE.ok ? deathBE.data : null);
  figures.reached = ok.length > 0;
  figures.at = ok.reduce((m, r) => Math.max(m, r.at || 0), 0);
  figures.stale = ok.length > 0 && ok.some((r) => r.stale === true);
  return figures;
}

/* =====================================================================
 * 4. The vintage guard
 * ===================================================================== */

/**
 * The pinned arrondissement code set, derived from municipalities.json.
 *
 * nis_history.json holds MUNICIPALITY codes, so an arrondissement code has to
 * be checked against the set of `dstr` values actually shipped in this
 * vintage. Ghent's 44000 is in it; the pre-2019 Hainaut code 52000 is not.
 * @param {Object} municipalities @returns {Set<string>|null}
 */
export function districtSet(municipalities) {
  if (!municipalities || typeof municipalities !== "object") return null;

  // municipalities.json ships a first-class `districts` table (43 entries).
  const d = municipalities.districts;
  if (d && typeof d === "object" && !Array.isArray(d)) {
    const keys = Object.keys(d).filter((k) => /^\d{5}$/.test(k));
    if (keys.length) return new Set(keys);
  }

  // Otherwise derive it from the `dstr` of every municipality record.
  const table = (municipalities.municipalities && typeof municipalities.municipalities === "object")
    ? municipalities.municipalities
    : municipalities;
  const out = new Set();
  for (const k of Object.keys(table)) {
    const rec = table[k];
    if (rec && typeof rec === "object" && typeof rec.dstr === "string") out.add(rec.dstr);
  }
  return out.size ? out : null;
}

/**
 * Check one figure against BOTH ends of its join before it is allowed on
 * screen. Returns a stats.js-shaped result, never undefined.
 *
 * @param {Object} g   {history, municipalities, districts, nis, dstr}
 * @param {number} year   the statistic's own year
 * @param {*} value
 * @param {boolean} keyedOnDistrict  true for CD_REFNIS-keyed tables
 */
export function guardFigure(g, year, value, keyedOnDistrict) {
  const muni = joinStatistic(g.nis, year, g.history, {
    value,
    municipalities: g.municipalities,
  });
  if (!muni.ok) return muni;

  if (!keyedOnDistrict) return muni;

  const dstr = joinStatistic(g.dstr, year, g.history, {
    value,
    municipalities: g.districts,
  });
  if (!dstr.ok) return dstr;

  // Either end being an aggregate makes the figure an aggregate.
  if (needsAggregateMarker(dstr)) return dstr;
  return muni;
}

/* =====================================================================
 * 5. Rendering
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
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    n.appendChild(typeof c === "string" || typeof c === "number"
      ? document.createTextNode(String(c)) : c);
  }
  return n;
}

/**
 * The inline "this is not in your language" marker. Must stay byte-identical
 * to i18n.js's UNTRANSLATED_MARK; this band takes its strings through ctx and
 * imports no i18n module, so it cannot import the constant.
 */
const UNTRANSLATED_MARK = " *";

/**
 * The four honest ways this band can have nothing to say, as a `data-empty`
 * value. UI_SPEC 2.5 names the first three and they are not one thing:
 *
 *   published-nothing  Statbel answered and published none of these figures
 *   out-of-scope       no NIS resolves here, or the record carries no
 *                      arrondissement code, so no query can even be formed
 *   unreachable        THE ONLY FAULT: Statbel could not be reached, and
 *                      nothing from it is stored on this device yet
 *   idle               no position yet, so nothing has been asked of anything
 *
 * This is the one band in the app that can genuinely be in all four, because
 * it is the one band fed by a live source rather than by baked shards.
 */
export const NOTHING = Object.freeze({
  PUBLISHED_NOTHING: "published-nothing",
  OUT_OF_SCOPE: "out-of-scope",
  UNREACHABLE: "unreachable",
  IDLE: "idle",
});

/**
 * One note: a kind label over a body, in a quiet or a warn box (UI_SPEC 2.3).
 *
 * THE TONE RULE. Warn is only ever for data that is real but old, or for a
 * source that could not be reached. It is never used for "published nothing",
 * because a Statbel table that simply has no row for this arrondissement has
 * not failed, and an app that paints that amber is lying about its own health.
 *
 * The class stays `.quiet` (or `.asof` for the stale line), which is app.css's
 * existing vocabulary; the tone rides on `data-tone`, so a stylesheet that has
 * not been told about warn notes still renders a calm, correct box.
 *
 * @param {{layer?:string, body:string, kind?:string, tone?:"quiet"|"warn",
 *          empty?:string, className?:string}} spec
 */
function noteEl(spec) {
  const p = el("p", {
    class: spec.className || "quiet",
    "data-layer": spec.layer || null,
    "data-tone": spec.tone || "quiet",
    "data-empty": spec.empty || null,
  });
  if (spec.kind) p.appendChild(el("strong", { class: "note__kind", text: spec.kind }));
  p.appendChild(el("span", { class: "note__body", text: spec.body }));
  return p;
}

/** ctx.t(), with this band's English defaults behind it. Never blank. */
function makeT(ctx) {
  const lang = (ctx && (ctx.lang || ctx.uiLang)) || "en";
  return function t(key, vars) {
    let s;
    if (ctx && typeof ctx.t === "function") {
      try { s = ctx.t(key); } catch (_) { s = undefined; }
    }
    const miss = typeof s !== "string" || s === "" || s === key || s === "[" + key + "]";
    if (miss) {
      s = ZOOM_UI_DEFAULTS[key];
      // Acceptance test 4, second clause: an English default standing in for a
      // missing translation is MARKED, never passed off as a translation.
      if (typeof s === "string" && s !== "" && lang !== "en") s += UNTRANSLATED_MARK;
    }
    if (typeof s !== "string" || s === "") s = key;
    return vars
      ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : String(vars[k])))
      : s;
  };
}

function fmtInt(v, lang) {
  if (v === null || v === undefined) return "";
  try { return new Intl.NumberFormat(lang).format(v); } catch (_) { return String(v); }
}

function fmtRatio(v, lang, digits) {
  if (v === null || v === undefined) return "";
  try {
    return new Intl.NumberFormat(lang, {
      minimumFractionDigits: digits, maximumFractionDigits: digits,
    }).format(v);
  } catch (_) { return v.toFixed(digits); }
}

/** One statistic tile, or the sentence that replaces it.
 *
 *  A refused join never draws a number, and never draws a placeholder glyph
 *  either: it draws the label and the reason the figure is withheld, so the
 *  gap reads as a decision rather than as a rendering failure (acceptance
 *  test 3, "never silently dropped", and the never-render-an-empty-panel
 *  rule in CLAUDE.md). */
function tile(list, t, lang, label, join, render, sub, key) {
  if (!join || !join.ok) {
    const why = (join && join.note) || "";
    // No `data-empty`: a refused join is not one of UI_SPEC 2.5's three ways
    // of having nothing to say. The figure exists and Statbel published it;
    // this app declines to attach it to a place it cannot honestly attach it
    // to. That is a decision, and `data-state="withheld"` is its name.
    list.appendChild(el("li", {
      class: "stat--withheld", "data-fact": key || null, "data-state": "withheld",
    },
      el("span", { class: "k", text: label }),
      el("span", { class: "k", text: t("zoom.refused", { why }) })
    ));
    return;
  }
  const marked = needsAggregateMarker(join);
  const aggregate = marked ? t("zoom.aggregate", { why: join.note || "" }) : "";
  const value = el("span", { class: "v", text: render(join.value) });
  if (marked) {
    value.appendChild(el("sup", {
      class: "untranslated", title: aggregate, "aria-label": aggregate, text: "*",
    }));
  }
  const li = el("li", { "data-fact": key || null, "data-join": join.kind || null },
    value, el("span", { class: "k", text: label }));
  if (sub) li.appendChild(el("span", { class: "k", text: sub }));
  if (marked) li.appendChild(el("span", { class: "k", text: aggregate }));
  list.appendChild(li);
}

/**
 * Copy that names what is missing. Never a blank panel.
 *
 * `empty` is UI_SPEC 2.5's taxonomy and it decides the tone: only
 * `unreachable` is a fault and only `unreachable` gets the warn fill. A
 * position that has not arrived, an arrondissement that cannot be keyed and a
 * table that published nothing are all correct outcomes, and all three stay
 * quiet.
 */
function collapse(host, t, text, empty) {
  const failed = empty === NOTHING.UNREACHABLE;
  const KIND = {
    [NOTHING.IDLE]: "note.waiting",
    [NOTHING.OUT_OF_SCOPE]: "note.scope",
    [NOTHING.PUBLISHED_NOTHING]: "note.nothing",
    [NOTHING.UNREACHABLE]: "note.unreachable",
  };
  host.textContent = "";
  host.appendChild(noteEl({
    layer: "zoom",
    empty: empty || null,
    tone: failed ? "warn" : "quiet",
    kind: KIND[empty] ? t(KIND[empty]) : null,
    body: text,
  }));
}

function arrondissementName(figures, lang) {
  const n = figures.names || {};
  return n[lang] || n.nl || n.fr || n.en || figures.nuts3 || "";
}

function render(host, ctx, figures, g) {
  const t = makeT(ctx);
  const lang = (ctx && ctx.lang) || "en";
  host.textContent = "";

  // The administrative LEVEL is named explicitly. No Statbel table reaches
  // municipality level (CONTRACT 10.3), and a reader who thinks these are
  // their town's numbers has been misled by the layout alone. So the level is
  // the line under the name, not a parenthesis inside it.
  const districtName = arrondissementName(figures, lang);
  host.appendChild(el("p", { class: "answer", "data-layer": "district" },
    el("span", { class: "name", lang: figures.names && figures.names[lang] ? lang : null,
      text: districtName })
  ));

  // The two join keys, on screen. This band's central claim is that it keys on
  // nuts3 and dstr and never on the municipality NIS, and a claim the reader
  // cannot check is a claim they have to take on trust.
  const keyBits = [];
  if (figures.nuts3) keyBits.push(el("span", { class: "code", "data-fact": "nuts3", text: figures.nuts3 }));
  if (figures.dstr) {
    if (keyBits.length) keyBits.push(document.createTextNode(" · "));
    keyBits.push(el("span", { class: "code", "data-fact": "dstr", text: figures.dstr }));
  }
  if (keyBits.length) keyBits.push(document.createTextNode(" "));
  keyBits.push(el("span", { class: "sub", text: t("zoom.district") }));
  host.appendChild(el("p", { class: "sub", "data-layer": "keys" }, keyBits));

  const list = el("ul", { class: "stats" });
  let shown = 0;

  if (figures.population !== null) {
    const j = guardFigure(g, figures.popYear, figures.population, false);
    tile(list, t, lang, t("zoom.population"), j, (v) => fmtInt(v, lang), null, "population");
    shown++;
  }
  // Statbel publishes the median age per sex and never as a total, so the two
  // are shown side by side. When only one is published the pair is not drawn
  // at all: "40 / ?" would be a worse answer than one honest tile fewer.
  if (figures.medianAgeM !== null && figures.medianAgeF !== null) {
    const pair = { m: figures.medianAgeM, f: figures.medianAgeF };
    const j = guardFigure(g, figures.popYear, pair, false);
    tile(list, t, lang, t("zoom.medianage"), j,
      (v) => t("zoom.medianage.value", {
        m: fmtInt(v.m, lang), f: fmtInt(v.f, lang),
      }),
      t("zoom.medianage.note"), "medianage");
    shown++;
  }
  if (figures.dependency !== null) {
    const j = guardFigure(g, figures.popYear, figures.dependency, false);
    tile(list, t, lang, t("zoom.dependency"), j, (v) => fmtRatio(v, lang, 2),
      t("zoom.dependency.note"), "dependency");
    shown++;
  }
  for (const [key, here, be] of [
    ["zoom.birthrate", figures.birthRate, figures.birthRateBE],
    ["zoom.deathrate", figures.deathRate, figures.deathRateBE],
  ]) {
    if (!here) continue;
    const j = guardFigure(g, here.year, here.value, true);
    // The country figure is the card's own second line now, not a clause
    // appended to the first, so it drops the leading separator it carried when
    // the whole tile was one run of text.
    const beText = be ? t("zoom.country") + " " + fmtRatio(be.value * 1000, lang, 1) : "";
    tile(list, t, lang, t(key) + " " + t("zoom.year", { y: here.year }), j,
      (v) => fmtRatio(v * 1000, lang, 1), beText || null, key.split(".").pop());
    shown++;
  }

  if (!shown) {
    // Statbel answered. It simply has none of these figures for this
    // arrondissement, which is a published-nothing, not a fault.
    collapse(host, t, t("empty.zoom.novalues"), NOTHING.PUBLISHED_NOTHING);
    return false;
  }
  host.appendChild(list);

  // Not an empty state and not a caveat about age: it is the sentence that
  // says what this band refuses to be. No kind label, because a kind label
  // would make a statement of intent look like a report of a gap.
  host.appendChild(noteEl({ layer: "context", body: t("zoom.context") }));

  if (figures.at) {
    const when = new Date(figures.at).toISOString().slice(0, 10);
    host.appendChild(el("p", {
      class: "asof", "data-layer": "asof", "data-tone": "warn",
      text: t("zoom.asof", { when }),
    }));
  }
  // Real data, but old, AND the source could not be reached this time: the one
  // place in this band where both halves of the warn tone are true at once.
  if (figures.stale) {
    host.appendChild(noteEl({
      className: "asof", layer: "stale", tone: "warn",
      empty: NOTHING.UNREACHABLE, kind: t("note.unreachable"), body: t("zoom.stale"),
    }));
  }

  // UI_SPEC 2.5: the second line under the source line, at the same size.
  // It comes first because it reads as the lead-in to it, and because under
  // the shell the source line is p.src[data-role="src"], a sibling of this
  // body that main.js owns and that this module must not write into.
  host.appendChild(el("p", {
    class: "src src__why", "data-layer": "why", text: t("zoom.src.why"),
  }));
  return true;
}

/* =====================================================================
 * 6. The band controller
 * ===================================================================== */

/**
 * main.js calls mount(bodyEl, ctx) and then update(ctx) on every paint.
 *
 * @param {HTMLElement} host  the band's div[data-role="body"]
 * @param {Object} ctx        the context built by main.js makeContext()
 * @returns {{update: function, setLang: function, destroy: function}}
 */
export function mount(host, ctx) {
  let current = ctx || {};
  let historyDoc = null;
  let historyPending = null;
  let lastKey = "";
  let figures = null;
  let generation = 0;
  let destroyed = false;

  function section() {
    return host && host.closest ? host.closest("section.band") : null;
  }
  /**
   * `data-state` is what app.css keys on and what dock.js reads for the pill's
   * state dot (UI_SPEC 2.2). `data-empty` is the finer taxonomy underneath it:
   * "empty" is one word for three different situations and only one of them is
   * a fault, so the section carries both.
   */
  function setState(name, empty) {
    const s = section();
    if (!s) return;
    s.dataset.state = name;
    if (empty) s.dataset.empty = empty;
    else delete s.dataset.empty;
  }

  async function history() {
    if (historyDoc) return historyDoc;
    if (!historyPending) {
      historyPending = readNisHistory()
        .then((r) => (r && r.ok && r.data ? indexHistory(r.data) : null))
        .catch(() => null);
    }
    historyDoc = await historyPending;
    return historyDoc;
  }

  function guardArgs(hist) {
    return {
      history: hist,
      municipalities: current.municipalities,
      districts: districtSet(current.municipalities),
      nis: current.nis,
      dstr: current.muntyMeta ? current.muntyMeta.dstr : null,
    };
  }

  async function paint() {
    const gen = ++generation;
    const t = makeT(current);
    const m = current.muntyMeta;

    if (!current.position) {
      collapse(host, t, t("empty.zoom.position"), NOTHING.IDLE);
      setState("idle", NOTHING.IDLE);
      return;
    }
    // Out of scope by design, twice over: no municipality resolves here, or
    // the record that does carries no arrondissement code. Either way no query
    // can be formed, so nothing was asked and nothing failed.
    if (!current.nis || !m) {
      collapse(host, t, t("empty.zoom.municipality"), NOTHING.OUT_OF_SCOPE);
      setState("empty", NOTHING.OUT_OF_SCOPE);
      return;
    }
    if (!m.nuts3 || !m.dstr) {
      collapse(host, t, t("empty.zoom.nuts3"), NOTHING.OUT_OF_SCOPE);
      setState("empty", NOTHING.OUT_OF_SCOPE);
      return;
    }

    const key = m.nuts3 + "/" + m.dstr;
    if (key !== lastKey) {
      figures = null;
      lastKey = key;
    }

    if (!figures || !figures.reached) {
      // Attempted even when navigator.onLine is false: the service worker
      // serves this host network-first with a LIVE-cache fallback, so an
      // offline device can still answer from what it stored yesterday.
      const next = await readArrondissement(m.nuts3, m.dstr);
      if (destroyed || gen !== generation) return;
      figures = next;
    }

    if (!figures.reached) {
      // The only fault in this band, and the only warn tone: a live source was
      // asked and did not answer, and nothing from it is stored here yet.
      collapse(host, t, t(current.online ? "empty.zoom.unreachable" : "empty.zoom.offline"),
        NOTHING.UNREACHABLE);
      setState("error", NOTHING.UNREACHABLE);
      return;
    }

    const hist = await history();
    if (destroyed || gen !== generation) return;

    const drew = render(host, current, figures, guardArgs(hist));
    setState(drew ? "ready" : "empty", drew ? null : NOTHING.PUBLISHED_NOTHING);
    if (drew && typeof current.setSources === "function") {
      current.setSources("zoom", ZOOM_SOURCE_IDS[0]);
    }
  }

  function run() {
    paint().catch((err) => {
      console.error("BeHERE: zoom band failed", err);
      const t = makeT(current);
      collapse(host, t, t("empty.zoom.unreachable"), NOTHING.UNREACHABLE);
      setState("error", NOTHING.UNREACHABLE);
    });
  }

  run();

  return {
    update(next) {
      if (destroyed) return;
      current = next || current;
      run();
    },
    setLang() {
      if (destroyed) return;
      run();
    },
    setLanguage() {
      if (destroyed) return;
      run();
    },
    destroy() {
      destroyed = true;
      generation++;
    },
  };
}

export default mount;

/*
 * ---------------------------------------------------------------------------
 * MARKUP CONTRACT: what this module writes into div.band-body[data-role=body]
 * ---------------------------------------------------------------------------
 * Classes are app.css's existing vocabulary, unchanged by the map-first
 * revamp: UI_SPEC 4.2 restyles every one of them and renames none. Everything
 * else is a data-* hook. No styles are written here, no inline style attribute
 * is ever set, and no icon is drawn: inside a band body every glyph would sit
 * beside text that already says the same thing.
 *
 *   p.answer[data-layer="district"]
 *       span.name[lang]              the arrondissement, as Statbel authored it
 *   p.sub[data-layer="keys"]
 *       span.code[data-fact="nuts3"] BE234
 *       span.code[data-fact="dstr"]  44000
 *       span.sub                     "Arrondissement", naming the LEVEL, which
 *                                    is the one thing a reader must not guess
 *
 *   ul.stats > li[data-fact=KEY][data-join=KIND]
 *       span.v                       the figure, display size
 *         sup.untranslated           the aggregate marker, with its reason
 *       span.k                       the label, then the note, then the reason
 *     KEY is one of: population, medianage, dependency, birthrate, deathrate
 *     KIND is stats.js's JOIN result for the figure in that tile
 *
 *   li.stat--withheld[data-state="withheld"][data-empty="out-of-scope"]
 *       a figure the vintage guard REFUSED. It carries no span.v on purpose:
 *       an em dash in the number slot reads as a rendering failure, while the
 *       label plus the reason reads as the deliberate refusal it is
 *       (acceptance test 3, "never silently dropped").
 *
 *   p.quiet[data-layer=L][data-tone="quiet"|"warn"][data-empty=E?]
 *       strong.note__kind            the kind label, e.g. "COULD NOT BE REACHED"
 *       span.note__body              the sentence
 *     L is one of: zoom (the collapsed band), context
 *     E is one of: published-nothing, out-of-scope, unreachable, idle
 *
 *   p.asof[data-layer="asof"][data-tone="warn"]     "Statistics as of {when}."
 *   p.asof[data-layer="stale"][data-tone="warn"][data-empty="unreachable"]
 *       real figures, stored earlier, with Statbel unreachable now
 *   p.src.src__why[data-layer="why"]  why nuts3 and dstr and never the NIS
 *
 *   app.css MUST give .note__kind `display: block` (UI_SPEC 2.3: 11px, .08em,
 *   uppercase, opacity .72, margin-bottom 4px). Without that rule the kind and
 *   the body run together on one line; nothing else breaks.
 *
 * ON THE SECTION, via host.closest("section.band"):
 *   data-state  idle | ready | empty | error
 *   data-empty  the UI_SPEC 2.5 taxonomy underneath "empty", so dock.js can
 *               tell the pill's state dot which of the three it is
 *
 *   CHANGED BY THE REVAMP, and it is the only behavioural change in this file:
 *   an unreachable Statbel used to set data-state="empty". UI_SPEC 2.5 puts it
 *   at "error", because absent and broken are different claims and this band
 *   is the one band that can be either. Nothing else about the fetch, the
 *   fold, the keys or the vintage guard moved.
 * ---------------------------------------------------------------------------
 */
