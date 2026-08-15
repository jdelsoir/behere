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
function tile(list, t, lang, label, join, render, sub) {
  if (!join || !join.ok) {
    const why = (join && join.note) || "";
    list.appendChild(el("li", { class: "stat--withheld" },
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
  const li = el("li", null, value, el("span", { class: "k", text: label }));
  if (sub) li.appendChild(el("span", { class: "k", text: sub }));
  if (marked) li.appendChild(el("span", { class: "k", text: aggregate }));
  list.appendChild(li);
}

/** Copy that names what is missing. Never a blank panel. */
function collapse(host, text) {
  host.textContent = "";
  host.appendChild(el("p", { class: "quiet", text }));
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
  // their town's numbers has been misled by the layout alone.
  const districtName = arrondissementName(figures, lang);
  host.appendChild(el("p", { class: "answer" },
    el("span", { class: "name", lang: figures.names && figures.names[lang] ? lang : null,
      text: districtName }),
    el("span", { class: "sub", text: " " + t("zoom.district") })
  ));

  const list = el("ul", { class: "stats" });
  let shown = 0;

  if (figures.population !== null) {
    const j = guardFigure(g, figures.popYear, figures.population, false);
    tile(list, t, lang, t("zoom.population"), j, (v) => fmtInt(v, lang));
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
      t("zoom.medianage.note"));
    shown++;
  }
  if (figures.dependency !== null) {
    const j = guardFigure(g, figures.popYear, figures.dependency, false);
    tile(list, t, lang, t("zoom.dependency"), j, (v) => fmtRatio(v, lang, 2),
      t("zoom.dependency.note"));
    shown++;
  }
  for (const [key, here, be] of [
    ["zoom.birthrate", figures.birthRate, figures.birthRateBE],
    ["zoom.deathrate", figures.deathRate, figures.deathRateBE],
  ]) {
    if (!here) continue;
    const j = guardFigure(g, here.year, here.value, true);
    const beText = be ? " · " + t("zoom.country") + " " + fmtRatio(be.value * 1000, lang, 1) : "";
    tile(list, t, lang, t(key) + " " + t("zoom.year", { y: here.year }), j,
      (v) => fmtRatio(v * 1000, lang, 1), beText || null);
    shown++;
  }

  if (!shown) {
    collapse(host, t("empty.zoom.novalues"));
    return false;
  }
  host.appendChild(list);

  host.appendChild(el("p", { class: "quiet", text: t("zoom.context") }));
  if (figures.at) {
    const when = new Date(figures.at).toISOString().slice(0, 10);
    host.appendChild(el("p", { class: "asof", text: t("zoom.asof", { when }) }));
  }
  if (figures.stale) host.appendChild(el("p", { class: "asof", text: t("zoom.stale") }));
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
  function setState(name) {
    const s = section();
    if (s) s.dataset.state = name;
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
      collapse(host, t("empty.zoom.position"));
      setState("idle");
      return;
    }
    if (!current.nis || !m) {
      collapse(host, t("empty.zoom.municipality"));
      setState("empty");
      return;
    }
    if (!m.nuts3 || !m.dstr) {
      collapse(host, t("empty.zoom.nuts3"));
      setState("empty");
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
      collapse(host, t(current.online ? "empty.zoom.unreachable" : "empty.zoom.offline"));
      setState("empty");
      return;
    }

    const hist = await history();
    if (destroyed || gen !== generation) return;

    const drew = render(host, current, figures, guardArgs(hist));
    setState(drew ? "ready" : "empty");
    if (drew && typeof current.setSources === "function") {
      current.setSources("zoom", ZOOM_SOURCE_IDS[0]);
    }
  }

  function run() {
    paint().catch((err) => {
      console.error("BeHERE: zoom band failed", err);
      collapse(host, makeT(current)("empty.zoom.unreachable"));
      setState("error");
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
