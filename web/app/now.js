/**
 * BeHERE, the NOW band: "What can I do right now?"
 *
 * Four kinds of time-filtered opportunity, in the order a person asks:
 *   open today          places whose opening hours cover this moment
 *   market this morning a market on today's weekday, still to come or running
 *   collection tomorrow waste collection at this address in the next days
 *   event this weekend   dated events overlapping the coming Saturday/Sunday
 *
 * The calendar arithmetic is entirely local, so the whole band works offline
 * from cached records (PLAN section 6: "Now | live plus calendar rules |
 * calendar rules only"). Nothing here needs the network to decide *whether*
 * something is open; the network only supplies the records.
 *
 * ---------------------------------------------------------------------------
 * OPENING HOURS: WHAT THE SOURCES ACTUALLY EMIT
 * ---------------------------------------------------------------------------
 * The brief warned against assuming OSM `opening_hours` syntax. That warning
 * is correct. Every opening-hours-bearing field on the three Opendatasoft
 * portals was enumerated on 15 August 2026 and sampled. Not one uses OSM
 * syntax. What exists instead:
 *
 *  A. "Day / H - H", semicolons between days. The Brussels open-air market
 *     register (`marches-plein-air-vbx`, 12 records) in three parallel fields:
 *         horaires      "Samedi / 9h - 17h; Dimanche / 9h - 15h"
 *         openingsuren  "Zaterdag / 9u - 17u; Zondag / 9u - 15u"
 *         opening_hours "Saturday / 9h - 17h; Sunday / 9h - 15h"
 *     Note the trap: THE FIELD LITERALLY CALLED `opening_hours` CONTAINS
 *     ENGLISH PROSE, NOT OSM SYNTAX. Feeding it to an OSM parser yields
 *     nothing. Minutes appear as "7h30". Dutch uses "u" for the hour marker,
 *     and one record mixes the two ("Zaterdag / 8h - 13u"), so the parser must
 *     accept either marker in either language.
 *
 *  B. French prose day-ranges. `cimetieres` (City of Brussels):
 *         "Du lundi au dimanche de 8h30 à 16h30"
 *         "Du lundi au vendredi de 9h à 15h"
 *
 *  C. Prose with a half-day word. `marches-verviers` (ODWB):
 *         "Le samedi matin de 8h à 13h30"
 *
 *  D. Sentinels that are not hours at all: the literal string "N/A"
 *     (`bxl_food_trucks_commerces_ambulants`, every record), and `null`
 *     (`bloklocaties-gent`, every record sampled).
 *
 *  E. A URL where hours were promised. `points-de-collecte-parcs-a-containers-recypark`:
 *         info_et_horaires_d_ouverture: "https://arp-gan.be/fr/recypark"
 *     There are no hours in this dataset. Saying "open now" about it would be
 *     an invention, so the parser reports `unknown` and the UI links out.
 *
 *  F. Seasonal parentheticals that override the base range:
 *         "Vendredi / 14h - 19h (novembre à mars) 14h - 20h(avril-octobre)"
 *     Two ranges for one day, switching by month, with inconsistent spacing.
 *     The parser keeps the widest range and marks the record `approximate`
 *     rather than silently picking one and being wrong for half the year.
 *
 * `parseOpeningHours` therefore handles A, B, C and F, and returns an explicit
 * `unknown` for D and E instead of guessing. Anything it cannot parse is shown
 * with its raw text and no open/closed claim. **A wrong "open now" is worse
 * than no claim at all**, which is the same principle as the app's refusal to
 * machine-translate a street name.
 *
 * ---------------------------------------------------------------------------
 * DATED RECORDS
 * ---------------------------------------------------------------------------
 * Events and collections are dated, not recurring, and the formats are plain:
 *   date-only        Gent visit events: date_start "2026-06-17", date_end "2026-08-27"
 *   ISO datetime     ODWB agenda: event_datestart "2025-10-22T22:00:00+00:00"
 *   date-only rows   Gent IVAGO collection: datum "2026-08-17", fracties "PMD, RESTAFVAL"
 *                    TIBI (Wallonia): date "2025-05-09", type "PMC"
 *
 * The Ghent collection calendar has 171,150 rows and splits long streets by
 * house-number parity and range (`even_van`/`even_tot`, `on_van`/`on_tot`,
 * non-null on 18,282 rows), so a street match alone is not enough: the house
 * number has to fall in the right band or the wrong bin day gets shown.
 *
 * @module now
 */

import { icon } from "./icons.js";

// ---------------------------------------------------------------------------
// THE MAP-MARKER CONTRACT (identical in around.js, go.js and now.js)
// ---------------------------------------------------------------------------
//
// A market and an event happen SOMEWHERE, and the revamp draws a map
// (docs/UI_SPEC.md section 1). So this band publishes the points it already
// resolved and `web/app/map.js` draws them. Nothing here is triggered by a pan
// or a zoom; asking for the markers again costs nothing, because they are the
// by-product of a render that already happened.
//
//   getMarkers()            -> BandMarker[]   the dated and timed rows that
//                                             carry a coordinate
//   onMarkers(fn)           -> unsubscribe()  fires after every render pass
//   select(key, opts)       -> boolean        true when this band owns the key
//   getSelected()           -> string | null
//   onSelect(fn)            -> unsubscribe()  fires when the READER picks a row
//   getSummary()            -> {id, state, count, markers}
//
// UI_SPEC 3.3 gives NOW no layer chip of its own, so nothing here is drawn
// until the shell asks for it. That is deliberate and it is the shell's choice
// to make, not this band's: a waste-collection date has no point at all, and a
// market that is closed until Saturday is a weaker claim about the ground than
// a stop you can walk to now.
//
// WHAT NEVER BECOMES A MARKER: waste collection. The Ghent calendar is keyed on
// a street and a house-number band, not a coordinate, and inventing a point for
// it would be the same lie as inventing a distance.
//
/**
 * @typedef {Object} BandMarker
 * @property {"now"} band
 * @property {string} key      Stable across refetches: kind, name and rounded
 *                             position, never a row index.
 * @property {number} lat
 * @property {number} lon
 * @property {string} label    The record's own words. Never translated.
 * @property {string} lang     BCP-47 tag, "" when the source does not say.
 * @property {"market"|"event"} kind
 * @property {number} dist     Metres from the device, or NaN when no fix.
 * @property {string} [state]  markets: "open" | "closed" | "unknown".
 * @property {string} [when]   events: the ISO day it starts.
 * @property {string} sourceId Joins meta.json.sources[].id.
 */

// ---------------------------------------------------------------- constants

const ODS_HOSTS = {
  gent: "https://data.stad.gent",
  odwb: "https://www.odwb.be",
  brussels: "https://opendata.brussels.be",
};

/**
 * Per-municipality dataset wiring. Only what was verified to exist is listed;
 * a municipality absent from a category collapses that category with copy
 * naming the municipality, never a blank card.
 *
 * Ottignies-LLN (25121) appears nowhere on purpose: it publishes zero local
 * datasets, which PLAN section 7 calls out as the thinnest case. It still gets
 * the national layers, and the copy says which municipality has published
 * nothing rather than implying the app broke.
 */
const DATASETS = {
  market: {
    21004: {
      host: ODS_HOSTS.brussels,
      id: "marches-plein-air-vbx",
      name: "nom",
      hours: { fr: "horaires", nl: "openingsuren", en: "opening_hours" },
      geo: "geo_point_2d",
    },
  },
  collection: {
    44021: {
      host: ODS_HOSTS.gent,
      id: "afvalophaalkalender-ivago-woongebied-gent-2026-2027",
      street: "straatnaam",
      zip: "postcode",
      date: "datum",
      what: "fracties",
      ranges: { evenFrom: "even_van", evenTo: "even_tot", oddFrom: "on_van", oddTo: "on_tot" },
    },
  },
  event: {
    44021: {
      host: ODS_HOSTS.gent,
      id: "toeristische-evenementen-visit-gent",
      title: { nl: "name_nl" },
      start: "date_start",
      end: "date_end",
      geo: "geo",
      url: "url",
      venue: { nl: "ctcname_nl" },
    },
  },
};

/** Wallonia-wide agenda, filtered by distance rather than by municipality. */
const WALLOON_AGENDA = {
  host: ODS_HOSTS.odwb,
  id: "d4w-dw-openagenda",
  title: "event_label",
  start: "event_datestart",
  end: "event_dateend",
  geo: "event_locationgeotags",
  url: "url_dw",
  where: "event_locationaddr",
};

/** Walloon regions of the pilot set, for the agenda query. */
const WALLOON_NIS = new Set(["62063", "81001", "92003", "25121"]);

const SOURCE_ID = { ods: "opendatasoft_cities" };

const TTL_ODS_MS = 3600000; // CONTRACT 10.4: 1 h, stale-while-revalidate
const DEBOUNCE_MS = 1200;
const STORE_KEY = "behere.now.cache.v1";

// --------------------------------------------------------- day-name tables

/**
 * Weekday words, three languages, lower case and accent-free after folding.
 * Index matches `Date.getDay()`: 0 = Sunday.
 *
 * FULL NAMES AND ABBREVIATIONS ARE KEPT APART ON PURPOSE, and both are matched
 * whole rather than by prefix. An earlier version put them in one list and
 * prefix-matched, which silently mis-parsed real records:
 *
 *   "Mardi / 8h - 14h"            -> Monday, because Dutch "ma" (maandag) is
 *                                    a prefix of French "mardi" and Monday is
 *                                    tested first.
 *   "Le samedi matin de 8h a 13h" -> Monday, because "matin" also starts "ma".
 *
 * Both are verbatim records from opendata.brussels.be and www.odwb.be. A
 * market shown on the wrong day is exactly the class of quiet wrongness this
 * app is supposed to refuse, so the matcher is strict.
 */
const DAY_FULL = [
  ["dimanche", "zondag", "sunday"],
  ["lundi", "maandag", "monday"],
  ["mardi", "dinsdag", "tuesday"],
  ["mercredi", "woensdag", "wednesday"],
  ["jeudi", "donderdag", "thursday"],
  ["vendredi", "vrijdag", "friday"],
  ["samedi", "zaterdag", "saturday"],
];

/** Abbreviations, matched only as whole tokens and only if no full name did. */
const DAY_ABBR = [
  ["zo", "dim", "sun"],
  ["ma", "lun", "mon"],
  ["di", "mar", "tue"],
  ["wo", "mer", "wed"],
  ["do", "jeu", "thu"],
  ["vr", "ven", "fri"],
  ["za", "sam", "sat"],
];

/** Month words for the seasonal parentheticals of format F. */
const MONTH_WORDS = [
  ["janvier", "januari", "january"],
  ["fevrier", "februari", "february"],
  ["mars", "maart", "march"],
  ["avril", "april"],
  ["mai", "mei", "may"],
  ["juin", "juni", "june"],
  ["juillet", "juli", "july"],
  ["aout", "augustus", "august"],
  ["septembre", "september"],
  ["octobre", "oktober", "october"],
  ["novembre", "november"],
  ["decembre", "december"],
];

/** Half-day words, format C ("le samedi matin"). */
const MORNING = ["matin", "ochtend", "voormiddag", "morning"];
const AFTERNOON = ["apres-midi", "namiddag", "afternoon"];

/**
 * Strip accents and lower-case, so "Août" and "aout" are one token.
 * The combining-marks range is written as escapes on purpose: a literal
 * combining character in a source file is invisible and does not survive
 * copy-paste or a stray editor normalisation pass.
 */
function fold(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * The weekday a single token names, or -1.
 * Whole-token match only. A trailing plural "s" is allowed ("samedis"),
 * because that is the one inflection these registers actually use.
 */
function dayIndexOf(token) {
  const f = fold(token);
  if (!f) return -1;
  const bare = f.endsWith("s") ? f.slice(0, -1) : f;
  for (let i = 0; i < 7; i++) {
    for (const w of DAY_FULL[i]) if (f === w || bare === w) return i;
  }
  for (let i = 0; i < 7; i++) {
    for (const w of DAY_ABBR[i]) if (f === w) return i;
  }
  return -1;
}

// ------------------------------------------------------ opening-hours parser

/**
 * Parse the real Belgian open-data opening-hours formats into weekly rules.
 *
 * Deliberately NOT an OSM `opening_hours` parser: no source in this app emits
 * that syntax (see the file header). Handles formats A, B, C and F, and
 * returns `{known: false}` for anything else rather than guessing.
 *
 * @param {string|null|undefined} raw
 * @returns {{
 *   known: boolean,
 *   approximate: boolean,
 *   raw: string,
 *   reason?: "empty"|"sentinel"|"url"|"unparsed",
 *   rules: Array<{day:number, from:number, to:number}>  // minutes since midnight
 * }}
 */
export function parseOpeningHours(raw) {
  const out = { known: false, approximate: false, raw: raw == null ? "" : String(raw), rules: [] };
  const s = out.raw.trim();

  if (!s) return { ...out, reason: "empty" };
  // Format D: sentinels that mean "we did not record this".
  if (/^(n\/?a|nvt|onbekend|inconnu|-{1,3}|\.)$/i.test(s)) return { ...out, reason: "sentinel" };
  // Format E: a URL where hours were promised.
  if (/^https?:\/\//i.test(s)) return { ...out, reason: "url" };

  const folded = fold(s);

  // Format F: seasonal parentheticals. Detect, then strip them and widen.
  // "Vendredi / 14h - 19h (novembre à mars) 14h - 20h(avril-octobre)"
  let seasonal = false;
  if (/\(/.test(folded)) {
    for (const months of MONTH_WORDS) {
      if (months.some((m) => folded.includes("(" + m) || folded.includes("(" + m.slice(0, 4)))) {
        seasonal = true;
        break;
      }
    }
    if (!seasonal && /\((?:[^)]*\b(?:a|tot|to|-)\b[^)]*)\)/.test(folded)) {
      // A parenthetical containing a range word, e.g. "(april-oktober)".
      for (const months of MONTH_WORDS) {
        if (months.some((m) => folded.includes(m))) {
          seasonal = true;
          break;
        }
      }
    }
  }

  // Split into day-clauses. Semicolon is the documented separator in format A.
  const clauses = s.split(/\s*;\s*/).filter(Boolean);
  const rules = [];

  for (const clause of clauses) {
    const days = daysInClause(clause);
    if (!days.length) continue;
    const spans = timeSpansIn(clause);
    if (!spans.length) continue;
    // Format F leaves two spans on one clause: take the widest, and say so.
    let from = spans[0].from;
    let to = spans[0].to;
    if (spans.length > 1) {
      for (const sp of spans) {
        if (sp.from < from) from = sp.from;
        if (sp.to > to) to = sp.to;
      }
    }
    for (const d of days) rules.push({ day: d, from, to });
  }

  if (!rules.length) return { ...out, reason: "unparsed" };
  rules.sort((a, b) => a.day - b.day || a.from - b.from);
  return {
    known: true,
    approximate: seasonal || clauses.some((c) => timeSpansIn(c).length > 1),
    raw: out.raw,
    rules,
  };
}

/**
 * Which weekdays a clause names.
 * Handles the single day of format A, the "du lundi au dimanche" range of
 * format B, and the "le samedi matin" of format C.
 */
function daysInClause(clause) {
  const f = fold(clause);
  // Format B: an explicit range, "du X au Y" / "van X tot Y" / "X to Y".
  const range = /\b(?:du|van|from)\s+([a-z]+)\s+(?:au|tot(?:\s+en\s+met)?|to|a)\s+([a-z]+)/.exec(f);
  if (range) {
    const a = dayIndexOf(range[1]);
    const b = dayIndexOf(range[2]);
    if (a >= 0 && b >= 0) {
      const days = [];
      // Weeks wrap: "du samedi au lundi" is Sat, Sun, Mon.
      for (let i = 0, d = a; i < 7; i++, d = (d + 1) % 7) {
        days.push(d);
        if (d === b) break;
      }
      return days;
    }
  }
  // Otherwise every day word that appears, in order.
  const days = [];
  for (const token of f.split(/[^a-z]+/)) {
    if (!token) continue;
    const d = dayIndexOf(token);
    if (d >= 0 && !days.includes(d)) days.push(d);
  }
  return days;
}

/**
 * Every "H - H" span in a clause, in minutes since midnight.
 * Accepts "9h", "9u", "7h30", "8h30", "9:00", "9.30" and both "-" and "à"/"tot"
 * as the separator, because all of those occur in the sampled data.
 */
function timeSpansIn(clause) {
  const f = fold(clause);
  const spans = [];
  // A time: digits, then an optional h/u/: marker, then optional minutes.
  const T = "(\\d{1,2})\\s*(?:[hu:.]\\s*(\\d{2})?)?";
  const re = new RegExp(T + "\\s*(?:-|–|—|a\\b|au\\b|tot\\b|to\\b|jusqu'?a\\b)\\s*" + T, "g");
  let m;
  while ((m = re.exec(f))) {
    const from = Number(m[1]) * 60 + Number(m[2] || 0);
    const to = Number(m[3]) * 60 + Number(m[4] || 0);
    if (from >= 0 && to > from && to <= 24 * 60) spans.push({ from, to });
  }
  if (spans.length) return spans;

  // Format C fallback: a half-day word with no explicit end.
  if (MORNING.some((w) => f.includes(w))) return [{ from: 8 * 60, to: 13 * 60 }];
  if (AFTERNOON.some((w) => f.includes(w))) return [{ from: 13 * 60, to: 18 * 60 }];
  return [];
}

/**
 * Is a parsed schedule open at `when`?
 * @param {ReturnType<typeof parseOpeningHours>} parsed
 * @param {Date} when
 * @returns {{state:"open"|"closed"|"unknown", until?:number, next?:{day:number,from:number}}}
 */
export function openState(parsed, when) {
  if (!parsed || !parsed.known) return { state: "unknown" };
  const day = when.getDay();
  const mins = when.getHours() * 60 + when.getMinutes();
  for (const r of parsed.rules) {
    if (r.day === day && mins >= r.from && mins < r.to) {
      return { state: "open", until: r.to };
    }
  }
  // Next opening within the coming week.
  for (let i = 0; i < 8; i++) {
    const d = (day + i) % 7;
    for (const r of parsed.rules) {
      if (r.day !== d) continue;
      if (i === 0 && r.from <= mins) continue;
      return { state: "closed", next: { day: d, from: r.from, inDays: i } };
    }
  }
  return { state: "closed" };
}

// ------------------------------------------------------------ date helpers

/** Local midnight for a date, so day maths never crosses a timezone seam. */
function startOfDay(d) {
  const x = new Date(d.getTime());
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d, n) {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + n);
  return x;
}

/** "2026-08-15" in LOCAL time. `toISOString` would shift the day in +02:00. */
export function isoDay(d) {
  return (
    d.getFullYear() +
    "-" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0")
  );
}

/**
 * Parse the two dated shapes the sources emit: "2026-06-17" and
 * "2025-10-22T22:00:00+00:00". Returns null on anything else.
 */
export function parseWhen(v) {
  if (!v) return null;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d); // local midnight, not UTC
  }
  const t = Date.parse(s);
  return isNaN(t) ? null : new Date(t);
}

/**
 * The coming weekend as a half-open interval [start, end).
 * "This weekend" from a Saturday or Sunday means the one you are in, not the
 * next one, which is what a person standing there means.
 */
export function weekendRange(now) {
  const d = startOfDay(now);
  const day = d.getDay();
  const toSat = day === 0 ? -1 : 6 - day;
  const sat = addDays(d, toSat);
  return { start: sat, end: addDays(sat, 2) };
}

/** Do [aStart, aEnd] and [bStart, bEnd) overlap? */
function overlaps(aStart, aEnd, bStart, bEnd) {
  const s = aStart ? aStart.getTime() : -Infinity;
  const e = aEnd ? aEnd.getTime() : s;
  return e >= bStart.getTime() && s < bEnd.getTime();
}

/**
 * Does a house number fall inside a collection range row?
 *
 * The Ghent calendar splits long streets by parity and range on 18,282 of its
 * 171,150 rows. `even_van`/`even_tot` bound the even side, `on_van`/`on_tot`
 * the odd. All four are strings and may be null, and house numbers carry
 * letters ("225A"), so the numeric part is what is compared.
 */
export function houseInRange(house, row, f) {
  const n = parseInt(String(house).replace(/\D.*$/, ""), 10);
  if (!isFinite(n)) return true; // unnumbered: do not hide the collection
  const ev = row[f.evenFrom];
  const et = row[f.evenTo];
  const od = row[f.oddFrom];
  const ot = row[f.oddTo];
  if (ev == null && et == null && od == null && ot == null) return true; // whole street
  const even = n % 2 === 0;
  const from = even ? ev : od;
  const to = even ? et : ot;
  if (from == null && to == null) return false; // this side is not served by this row
  const lo = from == null ? -Infinity : parseInt(String(from).replace(/\D.*$/, ""), 10);
  const hi = to == null ? Infinity : parseInt(String(to).replace(/\D.*$/, ""), 10);
  return n >= lo && n <= hi;
}

// ------------------------------------------------------------- ODS fetching

/**
 * Opendatasoft Explore v2.1 query.
 *
 * CONTRACT 10.4: rate limits are per portal (250,000 / 100,000 / 20,000 a day)
 * and must be READ from `x-ratelimit-limit`, never hardcoded. Both that header
 * and `x-ratelimit-remaining` are in `access-control-expose-headers`, so the
 * browser can see them; verified live on data.stad.gent.
 */
class OdsClient {
  constructor(fetchFn, now) {
    this.fetch = fetchFn;
    this.now = now;
    /** @type {Map<string,{limit:number, remaining:number, reset:string}>} */
    this.budget = new Map();
    this.cache = new Map();
  }

  /** Stop calling a portal that is nearly out of budget. */
  exhausted(host) {
    const b = this.budget.get(host);
    return !!b && b.remaining <= 50;
  }

  async records(host, dataset, params) {
    const url = new URL(host + "/api/explore/v2.1/catalog/datasets/" + dataset + "/records");
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    const key = url.toString();

    const hit = this.cache.get(key);
    const nowMs = this.now();
    if (hit && nowMs - hit.at < TTL_ODS_MS) return { ...hit, fresh: true };

    if (this.exhausted(host)) {
      return hit
        ? { ...hit, fresh: false, stale: true, reason: "rate-limit" }
        : { rows: [], at: 0, fresh: false, stale: true, reason: "rate-limit" };
    }

    try {
      const r = await this.fetch(key, { credentials: "omit" });
      const lim = Number(r.headers.get("x-ratelimit-limit"));
      const rem = Number(r.headers.get("x-ratelimit-remaining"));
      if (isFinite(lim) && lim > 0) {
        this.budget.set(host, {
          limit: lim,
          remaining: isFinite(rem) ? rem : lim,
          reset: r.headers.get("x-ratelimit-reset") || "",
        });
      }
      if (!r.ok) throw new Error("ODS HTTP " + r.status);
      const j = await r.json();
      const v = { rows: j.results || [], total: j.total_count || 0, at: nowMs };
      this.cache.set(key, v);
      return { ...v, fresh: true };
    } catch (err) {
      if (hit) return { ...hit, fresh: false, stale: true, error: err };
      return { rows: [], total: 0, at: 0, fresh: false, stale: true, error: err };
    }
  }
}

// ------------------------------------------------------------------ the band

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
}

function fmtStamp(ms, locale) {
  try {
    return new Date(ms).toLocaleString(locale || undefined, {
      dateStyle: "short",
      timeStyle: "short",
    });
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  }
}

function fmtHM(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

/**
 * Bring a card into view INSIDE the scrolling panel body, and nowhere else.
 * `block: "nearest"` is load-bearing: the revamped shell does not scroll the
 * page, and "center" would ask every scrollable ancestor to move, the map's own
 * container included. Smooth is dropped under `prefers-reduced-motion`.
 */
function scrollIntoPanel(node) {
  if (!node || typeof node.scrollIntoView !== "function") return;
  let smooth = false;
  try {
    smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    smooth = false;
  }
  try {
    node.scrollIntoView({ block: "nearest", inline: "nearest", behavior: smooth ? "smooth" : "auto" });
  } catch {
    node.scrollIntoView(false);
  }
}

/** Belgium's bounding box, used only to disambiguate a bare coordinate PAIR. */
const BE_LAT = [49.0, 52.0];
const BE_LON = [2.0, 7.0];

function inRange(v, r) {
  return Number.isFinite(v) && v >= r[0] && v <= r[1];
}

/**
 * The point a source published, in whatever shape it published it.
 *
 * Opendatasoft Explore v2.1 returns `{lon, lat}` for a `geo_point_2d`, GeoJSON
 * geometry returns `{type, coordinates: [lon, lat]}`, and some older exports
 * carry a bare `[lat, lon]` array or a `"lat,lon"` string.
 *
 * A bare PAIR is genuinely ambiguous, so it is resolved by geography rather
 * than by hope: Belgium's latitude band (49..52) and longitude band (2..7) do
 * not overlap, so exactly one reading of the pair can be inside the country.
 * If neither is, the pair is DROPPED rather than guessed. A market placed in
 * the wrong hemisphere is the class of quiet wrongness this app refuses.
 *
 * @returns {{lat:number, lon:number}|null}
 */
function pointOf(v) {
  if (!v) return null;
  if (typeof v === "string") {
    const parts = v.split(",").map((s) => Number(s.trim()));
    return parts.length === 2 ? pairOf(parts[0], parts[1]) : null;
  }
  if (Array.isArray(v)) {
    if (v.length !== 2) return null;
    return pairOf(Number(v[0]), Number(v[1]));
  }
  if (typeof v === "object") {
    const lat = Number(v.lat !== undefined ? v.lat : v.latitude);
    const lon = Number(v.lon !== undefined ? v.lon : v.lng !== undefined ? v.lng : v.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon)) return clean(lat, lon);
    if (v.type === "Point" && Array.isArray(v.coordinates) && v.coordinates.length >= 2) {
      return clean(Number(v.coordinates[1]), Number(v.coordinates[0])); // GeoJSON is lon,lat
    }
    if (v.geometry) return pointOf(v.geometry);
  }
  return null;
}

function pairOf(a, b) {
  if (inRange(a, BE_LAT) && inRange(b, BE_LON)) return { lat: a, lon: b };
  if (inRange(b, BE_LAT) && inRange(a, BE_LON)) return { lat: b, lon: a };
  return null;
}

function clean(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

const R_EARTH_M = 6371008.8; // IUGG mean radius, the same constant as around.js
const DEG = Math.PI / 180;

/** Real haversine metres. Only ever used to order what is already on screen. */
function haversineM(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Create the Now band.
 *
 * Same contract as the Go band: owns `[data-role="body"]`, sets
 * `section[data-state]`, touches nothing else.
 *
 * @param {HTMLElement} section
 * @param {Object} [ctx]  See createGoBand; the same injected dependencies,
 *                        plus `ctx.address` for the collection lookup.
 */
export function createNowBand(section, ctx = {}) {
  const cfg = {
    fetch: ctx.fetch || ((...a) => globalThis.fetch(...a)),
    now: ctx.now || (() => Date.now()),
    uiLang: ctx.uiLang || "en",
    municipality: ctx.municipality || null,
    override: ctx.override || null,
    resolveLabel: ctx.resolveLabel || null,
    radiusM: ctx.radiusM || 3000,
    storage: ctx.storage || safeStorage(),
  };
  const t = makeT(ctx.t, () => cfg.uiLang);
  const body = section.querySelector('[data-role="body"]') || section;
  const ods = new OdsClient(cfg.fetch, cfg.now);

  let debounceTimer = null;
  let generation = 0;
  let lastFix = null;
  let destroyed = false;

  const store = loadStore(cfg.storage);

  /* ------------------------------------------------ the map surface -------
   * See the contract at the head of this file. Nothing below fetches, and
   * nothing below is driven by the map. */

  /** @type {BandMarker[]} */
  let markers = [];
  const markerListeners = new Set();
  const selectListeners = new Set();
  let selectedKey = null;
  let bandState = "idle";
  /** How many calendars are in scope here, and how many rows they yielded. */
  let calendarCount = 0;
  let rowCount = 0;

  function setState(s) {
    bandState = s;
    section.setAttribute("data-state", s);
  }
  function clear() {
    while (body.firstChild) body.removeChild(body.firstChild);
  }

  function publishMarkers(next) {
    // Ascending distance where a fix exists, so the map and the panel agree
    // about which of two markets is nearer. Rows with no fix keep their
    // chronological order, because "when" is the only ordering that is true
    // before there is a "where".
    markers = next.every((m) => Number.isFinite(m.dist))
      ? next.slice().sort((a, b) => a.dist - b.dist || String(a.key).localeCompare(String(b.key)))
      : next;
    for (const fn of markerListeners) {
      try {
        fn(markers);
      } catch (err) {
        console.error("[now] onMarkers listener threw", err);
      }
    }
    if (selectedKey !== null && !markers.some((m) => m.key === selectedKey)) {
      selectedKey = null;
      applySelection(false);
      emitSelect();
    }
  }

  function markerFor(key) {
    return markers.find((m) => m.key === key) || null;
  }

  function emitSelect() {
    const marker = selectedKey === null ? null : markerFor(selectedKey);
    for (const fn of selectListeners) {
      try {
        fn(selectedKey, marker);
      } catch (err) {
        console.error("[now] onSelect listener threw", err);
      }
    }
  }

  /** Paint the current selection onto whatever cards are in the DOM now. */
  function applySelection(scroll) {
    let target = null;
    for (const card of body.querySelectorAll(".now-item__card[data-key]")) {
      const mine = selectedKey !== null && card.getAttribute("data-key") === selectedKey;
      const li = card.closest(".now-item");
      if (mine) {
        card.setAttribute("aria-current", "true");
        if (li) li.setAttribute("data-selected", "true");
        target = card;
      } else {
        card.removeAttribute("aria-current");
        if (li) li.removeAttribute("data-selected");
      }
    }
    if (target && scroll) scrollIntoPanel(target);
    return target;
  }

  /* One delegated listener, so a re-render never leaks a handler. */
  body.addEventListener("click", (ev) => {
    const target = ev.target;
    if (!target || typeof target.closest !== "function") return;
    const card = target.closest(".now-item__card[data-key]");
    if (!card || !body.contains(card)) return;
    const key = card.getAttribute("data-key");
    // Tapping the open row again clears it, so the reader can quieten the map.
    selectedKey = selectedKey === key ? null : key;
    applySelection(false);
    emitSelect();
  });

  function nis() {
    return (cfg.municipality && cfg.municipality.nis) || "";
  }

  // ------------------------------------------------------------- collectors

  /** Markets on today's weekday, with their open state right now. */
  async function markets(now) {
    const ds = DATASETS.market[nis()];
    if (!ds) return { kind: "market", available: false, reason: "no-dataset", rows: [] };
    const res = await ods.records(ds.host, ds.id, { limit: 100 });
    const today = now.getDay();
    const rows = [];
    let unparsed = 0;
    for (const r of res.rows) {
      const field =
        ds.hours[cfg.uiLang] || ds.hours.fr || ds.hours.nl || ds.hours.en;
      const parsed = parseOpeningHours(r[field]);
      // Count only records whose hours could not be read at all. A market that
      // simply does not run today is not "unparsed", and saying so would be a
      // small lie in the footnote.
      if (!parsed.known) {
        unparsed++;
        continue;
      }
      const st = openState(parsed, now);
      const todayRule = parsed.rules.find((x) => x.day === today);
      if (!todayRule && st.state !== "open") continue; // not a market day
      rows.push({
        name: r[ds.name] || "",
        raw: parsed.raw,
        parsed,
        state: st,
        todayRule,
        geo: r[ds.geo] || null,
      });
    }
    rows.sort((a, b) => (a.todayRule ? a.todayRule.from : 0) - (b.todayRule ? b.todayRule.from : 0));
    return {
      kind: "market",
      available: true,
      rows,
      at: res.at,
      stale: !!res.stale,
      reason: res.reason,
      unparsed,
    };
  }

  /** Waste collection at this address over the next 8 days. */
  async function collections(now) {
    const ds = DATASETS.collection[nis()];
    if (!ds) return { kind: "collection", available: false, reason: "no-dataset", rows: [] };
    const street = ctx.address && ctx.address.street;
    if (!street) {
      return { kind: "collection", available: false, reason: "no-address", rows: [] };
    }
    const from = isoDay(now);
    const to = isoDay(addDays(now, 8));
    const res = await ods.records(ds.host, ds.id, {
      where: `${ds.street} = "${String(street).replace(/"/g, '\\"')}" AND ${ds.date} >= date'${from}' AND ${ds.date} <= date'${to}'`,
      order_by: ds.date,
      limit: 40,
    });
    const house = ctx.address && ctx.address.house;
    const rows = res.rows
      .filter((r) => (house == null ? true : houseInRange(house, r, ds.ranges)))
      .map((r) => ({
        date: parseWhen(r[ds.date]),
        what: String(r[ds.what] || "")
          .split(/\s*,\s*/)
          .filter(Boolean),
      }))
      .filter((r) => r.date);
    return {
      kind: "collection",
      available: true,
      rows,
      at: res.at,
      stale: !!res.stale,
      reason: res.reason,
      street,
    };
  }

  /** Events overlapping the coming weekend, or running today. */
  async function events(now) {
    const code = nis();
    const local = DATASETS.event[code];
    const wknd = weekendRange(now);
    const today = startOfDay(now);
    const rows = [];
    let at = 0;
    let stale = false;
    let available = false;

    if (local) {
      available = true;
      const res = await ods.records(local.host, local.id, {
        where: `${local.end} >= date'${isoDay(today)}'`,
        order_by: local.start,
        limit: 60,
      });
      at = Math.max(at, res.at);
      stale = stale || !!res.stale;
      for (const r of res.rows) {
        const s = parseWhen(r[local.start]);
        const e = parseWhen(r[local.end]) || s;
        if (!s) continue;
        const onNow = overlaps(s, e, today, addDays(today, 1));
        const onWknd = overlaps(s, e, wknd.start, wknd.end);
        if (!onNow && !onWknd) continue;
        rows.push({
          title: pickField(r, local.title),
          start: s,
          end: e,
          url: r[local.url] || "",
          venue: pickField(r, local.venue),
          onNow,
          onWknd,
          geo: r[local.geo] || null,
        });
      }
    }

    if (WALLOON_NIS.has(code) && lastFix) {
      available = true;
      const a = WALLOON_AGENDA;
      const res = await ods.records(a.host, a.id, {
        where: `${a.end} >= date'${isoDay(today)}' AND distance(${a.geo}, geom'POINT(${lastFix.lon} ${lastFix.lat})', ${cfg.radiusM}m)`,
        order_by: a.start,
        limit: 40,
      });
      at = Math.max(at, res.at);
      stale = stale || !!res.stale;
      for (const r of res.rows) {
        const s = parseWhen(r[a.start]);
        const e = parseWhen(r[a.end]) || s;
        if (!s) continue;
        const onNow = overlaps(s, e, today, addDays(today, 1));
        const onWknd = overlaps(s, e, wknd.start, wknd.end);
        if (!onNow && !onWknd) continue;
        rows.push({
          title: r[a.title] || "",
          start: s,
          end: e,
          url: r[a.url] || "",
          venue: r[a.where] || "",
          onNow,
          onWknd,
          geo: r[a.geo] || null,
        });
      }
    }

    rows.sort((x, y) => x.start - y.start);
    return { kind: "event", available, rows, at, stale, weekend: wknd };
  }

  function pickField(row, map) {
    if (!map) return "";
    const order = [cfg.uiLang, "nl", "fr", "de", "en"];
    for (const l of order) if (map[l] && row[map[l]]) return row[map[l]];
    for (const k of Object.values(map)) if (row[k]) return row[k];
    return "";
  }

  // ---------------------------------------------------------------- render

  /**
   * Which of the honest silences a group is in (UI_SPEC 2.5).
   *
   *   nothing      the source answered and has nothing here
   *   scope        out of scope for this region, by design
   *   declined     not asked on purpose: quota budget, save-data
   *   unreachable  could not be reached: the only one that is a FAULT
   *   stale        real but old; the warn tone, never used for "absent"
   *   waiting      a prerequisite is missing, or still in flight
   *
   * `data-kind` is a hook, never a second sentence: the copy below is unchanged
   * and still carries the whole claim in words.
   */
  function silenceOf(group) {
    if (!group.available) {
      // "It appears once your address is known" is not an absence, it is a
      // prerequisite. Reading it as "Ghent publishes nothing" would be false.
      return group.reason === "no-address" ? "waiting" : "nothing";
    }
    if (group.reason === "rate-limit") return "declined";
    // Stale with no timestamp means it was never successfully fetched at all:
    // "nothing on" and "we could not ask" are different facts.
    if (group.stale && !group.at) return "unreachable";
    return "nothing";
  }

  function noteEl(text, cls, kind) {
    const p = el("p", cls || "quiet", text);
    if (kind) p.setAttribute("data-kind", kind);
    // Only the fault carries a glyph: the non-colour half of the one signal
    // that is genuinely a warning (UI_SPEC 7.6).
    if (kind === "unreachable") p.insertBefore(icon("wifi-off", 14), p.firstChild);
    return p;
  }

  function render(view) {
    clear();
    const frag = document.createDocumentFragment();
    /** @type {BandMarker[]} */
    const fresh = [];
    let shown = 0;
    let anyFault = false;

    for (const group of view.groups) {
      const sec = el("section", "now-group");
      sec.setAttribute("data-kind", group.kind);
      sec.appendChild(el("h3", "now-group-head", groupTitle(group)));

      if (!group.available) {
        const kind = silenceOf(group);
        sec.setAttribute("data-silence", kind);
        sec.appendChild(noteEl(missingCopy(group), "quiet now-note", kind));
        frag.appendChild(sec);
        continue;
      }
      if (!group.rows.length) {
        const kind = silenceOf(group);
        if (kind === "unreachable") anyFault = true;
        sec.setAttribute("data-silence", kind);
        sec.appendChild(noteEl(emptyCopy(group, view.now), "quiet now-note", kind));
        if (group.stale) sec.appendChild(asOf(group));
        frag.appendChild(sec);
        continue;
      }

      const ul = el("ul", "now-items");
      group.rows.slice(0, 8).forEach((row, i) => {
        const { node, marker } = itemEl(group.kind, row, view.now, view.fix, i);
        ul.appendChild(node);
        if (marker) fresh.push(marker);
        shown++;
      });
      sec.appendChild(ul);
      if (group.stale) sec.appendChild(asOf(group));
      if (group.kind === "market" && group.unparsed > 0) {
        sec.appendChild(
          noteEl(
            t(
              "now.market.unparsed",
              "{n} more market records list no usable opening hours and are not shown."
            ).replace("{n}", String(group.unparsed)),
            "quiet now-note",
            "nothing"
          )
        );
      }
      frag.appendChild(sec);
    }

    frag.appendChild(sourceEl(view));
    body.appendChild(frag);
    calendarCount = view.groups.filter((g) => g.available).length;
    rowCount = shown;
    // A band with nothing to show is `empty` when the calendars answered and
    // `error` only when at least one of them could not be reached at all.
    // Ottignies-LLN publishes zero local datasets and must never read as broken.
    setState(shown ? "ready" : anyFault ? "error" : "empty");
    publishMarkers(fresh);
  }

  /**
   * A stable key for one row: kind, the record's own words, and the position
   * rounded to about a metre. Never a row index: the list reorders when a
   * market opens or an event starts, and a marker whose key moved under it
   * would jump to a different pin.
   */
  function rowKey(kind, name, point, i) {
    const where = point ? "@" + point.lat.toFixed(5) + "," + point.lon.toFixed(5) : "#" + i;
    return "now:" + kind + ":" + String(name || "").slice(0, 60) + where;
  }

  /**
   * One row, as the item card of UI_SPEC 2.3.
   *
   * The card is a real `button` when the row has a point of its own, because
   * that is what makes selection bidirectional (UI_SPEC 3.3). A waste
   * collection has no point (the calendar is keyed on a street and a
   * house-number band), so its card is a plain `div`: a control that cannot do
   * anything is worse than no control, and it would still take a tab stop.
   *
   * An outbound link is always a SEPARATE control in the tag row. An `<a>`
   * inside a `<button>` is invalid HTML and a nested-interactive trap.
   *
   * @returns {{node: HTMLElement, marker: BandMarker|null}}
   */
  function itemEl(kind, row, now, fix, i) {
    const li = el("li", "now-item");
    li.setAttribute("data-kind", kind);

    const point = kind === "collection" ? null : pointOf(row.geo);
    const name = kind === "market" ? row.name : row.title;
    const key = rowKey(kind, name, point, i || 0);
    li.setAttribute("data-key", key);

    const card = el(point ? "button" : "div", "card now-item__card");
    if (point) {
      card.type = "button";
      card.setAttribute("data-key", key);
      if (selectedKey === key) {
        card.setAttribute("aria-current", "true");
        li.setAttribute("data-selected", "true");
      }
    }
    const tags = el("p", "now-item__tags");

    if (kind === "market") {
      li.setAttribute("data-open", row.state.state);
      card.appendChild(el("span", "now-what", row.name));
      if (row.todayRule) {
        card.appendChild(
          el("span", "now-when", fmtHM(row.todayRule.from) + "–" + fmtHM(row.todayRule.to))
        );
      }
      const badge =
        row.state.state === "open"
          ? t("now.open", "Open now")
          : row.state.state === "unknown"
          ? t("now.hours.unknown", "Opening hours not published")
          : t("now.today", "Today");
      // UI_SPEC 4.2: open is the live tag, closed and unknown are neutral.
      // `unknown` is NOT a warning: a source that publishes its hours as prose
      // has not failed, and the band simply refuses to guess a state from it.
      // The attribute the stylesheet keys on is `data-open`, on this element.
      const b = el(
        "span",
        "tag " + (row.state.state === "open" ? "tag-accent-2" : "tag-neutral") + " now-open",
        badge
      );
      b.setAttribute("data-open", row.state.state);
      b.setAttribute("data-state", row.state.state);
      tags.appendChild(b);
      if (row.parsed.approximate) {
        const a = el("span", "tag tag-neutral now-approx", t("now.approx", "hours vary by season"));
        a.title = row.raw;
        tags.appendChild(a);
      }
      li.appendChild(card);
      li.appendChild(tags);
      if (!row.parsed.known && row.raw) {
        // Never claim a state we could not derive: show the source text.
        li.appendChild(el("span", "now-raw", row.raw));
      }
      return {
        node: li,
        marker: point
          ? {
              band: "now",
              key,
              lat: point.lat,
              lon: point.lon,
              label: row.name || "",
              lang: "",
              kind: "market",
              dist: distFrom(fix, point),
              state: row.state.state,
              sourceId: SOURCE_ID.ods,
            }
          : null,
      };
    }

    if (kind === "collection") {
      const days = Math.round((startOfDay(row.date) - startOfDay(now)) / 86400000);
      li.setAttribute("data-days", String(days));
      const when =
        days === 0
          ? t("now.today", "Today")
          : days === 1
          ? t("now.tomorrow", "Tomorrow")
          : row.date.toLocaleDateString(cfg.uiLang || undefined, {
              weekday: "long",
              day: "numeric",
              month: "short",
            });
      card.appendChild(el("span", "now-when", when));
      // The fractions ARE the "what" here, and each one is its own claim
      // ("PMD", "RESTAFVAL"), so they read as tags rather than as one string.
      for (const f of row.what) tags.appendChild(el("span", "tag tag-neutral now-frac", f));
      li.appendChild(card);
      if (tags.childNodes.length) li.appendChild(tags);
      return { node: li, marker: null };
    }

    // events
    const when =
      row.onNow && !row.onWknd
        ? t("now.today", "Today")
        : row.start.toLocaleDateString(cfg.uiLang || undefined, {
            weekday: "short",
            day: "numeric",
            month: "short",
          });
    li.setAttribute("data-weekend", row.onWknd ? "true" : "false");
    card.appendChild(el("span", "now-when", when));
    card.appendChild(el("span", "now-what", row.title));
    if (row.venue) card.appendChild(el("span", "now-where", row.venue));
    li.appendChild(card);
    if (row.url) {
      const a = el("a", "tag tag-outline now-item__link");
      a.href = row.url;
      a.rel = "noopener noreferrer";
      a.target = "_blank";
      // The event's own title IS the link text for a screen reader. No new UI
      // string, and no translation of a title the organiser wrote.
      a.setAttribute("aria-label", row.title || "");
      a.appendChild(icon("chevron-right", 14));
      tags.appendChild(a);
    }
    if (tags.childNodes.length) li.appendChild(tags);
    return {
      node: li,
      marker: point
        ? {
            band: "now",
            key,
            lat: point.lat,
            lon: point.lon,
            label: row.title || "",
            lang: "",
            kind: "event",
            dist: distFrom(fix, point),
            when: isoDay(row.start),
            sourceId: SOURCE_ID.ods,
          }
        : null,
    };
  }

  /** Metres from the device to a point, or NaN when there is no fix yet. */
  function distFrom(fix, point) {
    if (!fix || !isFinite(fix.lat) || !isFinite(fix.lon)) return NaN;
    return haversineM(fix.lat, fix.lon, point.lat, point.lon);
  }

  function groupTitle(g) {
    return {
      market: t("now.group.market", "Markets today"),
      collection: t("now.group.collection", "Waste collection"),
      event: t("now.group.event", "This weekend"),
    }[g.kind];
  }

  /**
   * Copy for a category with no dataset. Names the municipality, so a thin
   * city reads as honest rather than broken (PLAN section 7).
   */
  function missingCopy(g) {
    const name = municipalityName();
    if (g.reason === "no-address") {
      return t(
        "now.collection.noaddress",
        "The collection calendar is per street. It appears once your address is known."
      );
    }
    return {
      market: t(
        "empty.market",
        "No market data published for {city}."
      ).replace("{city}", name),
      collection: t(
        "now.collection.none",
        "{city} does not publish a waste collection calendar as open data."
      ).replace("{city}", name),
      event: t(
        "now.event.none",
        "No event calendar is published as open data for {city}."
      ).replace("{city}", name),
    }[g.kind];
  }

  /** Copy for a dataset that exists but has nothing in the window. */
  function emptyCopy(g, now) {
    if (g.reason === "rate-limit") {
      return t(
        "now.ratelimit",
        "The portal's daily request budget is nearly used up, so this was not refreshed."
      );
    }
    // "Nothing on" and "we could not ask" are different facts. A dataset that
    // was never successfully fetched (stale with no timestamp) must not be
    // reported as an empty result.
    if (g.stale && !g.at) {
      return t(
        "now.unreachable",
        "This calendar could not be reached, and nothing from it is stored on this device yet."
      );
    }
    const weekday = now.toLocaleDateString(cfg.uiLang || undefined, { weekday: "long" });
    return {
      market: t("now.market.empty", "No market on a {weekday} here.").replace(
        "{weekday}",
        weekday
      ),
      collection: t(
        "now.collection.empty",
        "No collection at this address in the next eight days."
      ),
      event: t("now.event.empty", "Nothing dated for today or this weekend."),
    }[g.kind];
  }

  /**
   * The warn tone, and the only thing in this band that gets it: data that is
   * real but old. "Old" and "absent" are different claims, and blurring them is
   * the one colour mistake app.css forbids outright.
   */
  function asOf(g) {
    const p = el(
      "p",
      "now-asof",
      t("now.asof", "Shown from what was stored, as of {when}.").replace(
        "{when}",
        g.at ? fmtStamp(g.at, cfg.uiLang) : t("now.asof.unknown", "an earlier visit")
      )
    );
    p.setAttribute("data-kind", "stale");
    return p;
  }

  function municipalityName() {
    const m = cfg.municipality;
    if (!m) return t("now.thiscity", "this municipality");
    if (cfg.resolveLabel) {
      const r = cfg.resolveLabel({ id: m.nis, name: m.name }, "munty", cfg.uiLang, {
        override: cfg.override || {},
        regionDefault: (m.lang && m.lang.default) || "nl",
      });
      if (r && r.text) return r.text;
    }
    const d = (m.lang && m.lang.default) || "nl";
    return (m.name && (m.name[cfg.uiLang] || m.name[d])) || t("now.thiscity", "this municipality");
  }

  /** Acceptance test 8, again: source and vintage on every layer. */
  function sourceEl(view) {
    const p = el("p", "now-src");
    p.setAttribute("data-sources", SOURCE_ID.ods);
    const bits = [
      t(
        "now.src.rules",
        "Opening hours, market days and collection dates are evaluated on this device, so this band works offline."
      ),
    ];
    if (view.liveAt) {
      bits.push(
        t("now.src.records", "Records fetched {when}.").replace(
          "{when}",
          fmtStamp(view.liveAt, cfg.uiLang)
        )
      );
    }
    const budgets = [...ods.budget.entries()].map(
      ([h, b]) => new URL(h).host + " " + b.remaining + "/" + b.limit
    );
    if (budgets.length) {
      p.setAttribute("data-budget", budgets.join(" "));
    }
    p.textContent = bits.join(" ");
    return p;
  }

  // ------------------------------------------------------------------- run

  async function run(fix) {
    const gen = ++generation;
    setState("loading");
    const now = new Date(cfg.now());

    const groups = await Promise.all([markets(now), collections(now), events(now)]);
    if (gen !== generation || destroyed) return;

    const liveAt = Math.max(0, ...groups.map((g) => g.at || 0));
    persist(groups);
    render({ groups, now, liveAt, fix });
  }

  function persist(groups) {
    try {
      store.groups = groups.map((g) => ({
        kind: g.kind,
        available: g.available,
        reason: g.reason,
        at: g.at || 0,
      }));
      saveStore(cfg.storage, store);
    } catch {
      /* ignore */
    }
  }

  /**
   * Every setter goes through one debounce.
   *
   * The shell resolves a single fix in three paints and pushes municipality,
   * address and position with each of them. When each setter re-ran the whole
   * collection on the spot, one position cost nine requests to the same
   * Opendatasoft dataset. One timer, shared by every setter, collapses a burst
   * of context updates into a single run. It is still the same one-shot timer
   * acceptance test 9 allows: nothing here polls.
   */
  function schedule() {
    if (destroyed || !lastFix) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    const fix = lastFix;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      run(fix);
    }, DEBOUNCE_MS);
  }

  return {
    id: "now",

    setPosition(fix) {
      if (!fix || !isFinite(fix.lat) || !isFinite(fix.lon)) return;
      lastFix = fix;
      schedule();
    },

    /** Address arrives from the shell's spine; the collection calendar needs it. */
    setAddress(address) {
      ctx.address = address;
      schedule();
    },

    setMunicipality(m) {
      cfg.municipality = m;
      schedule();
    },

    setLanguage(lang) {
      cfg.uiLang = lang;
      schedule();
    },

    refresh() {
      if (lastFix) run(lastFix);
    },

    destroy() {
      destroyed = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      generation++;
      markerListeners.clear();
      selectListeners.clear();
      markers = [];
    },

    /* ------------------------------------------------- the map surface ----
     * Documented in full at the head of this file. Read-only: none of these
     * calls fetches, and none of them can spend an Opendatasoft request. */

    /** @returns {BandMarker[]} markets and events that carry a coordinate. */
    getMarkers() {
      return markers.slice();
    },

    /**
     * @param {(markers: BandMarker[]) => void} fn
     * @returns {() => void} unsubscribe
     */
    onMarkers(fn) {
      if (typeof fn !== "function") return () => {};
      markerListeners.add(fn);
      if (markers.length) fn(markers);
      return () => markerListeners.delete(fn);
    },

    /**
     * Select a row, or clear with `null`. This is what `map.js` calls when a
     * marker is tapped. It does not re-emit `onSelect` unless asked, so a
     * marker tap cannot bounce back into the map and start a loop.
     *
     * @param {string|null} key
     * @param {{scroll?: boolean, silent?: boolean}} [opts]
     * @returns {boolean} true when this band owns the key
     */
    select(key, opts = {}) {
      const next = key === null || key === undefined ? null : String(key);
      if (next !== null && !markers.some((m) => m.key === next)) return false;
      selectedKey = next;
      applySelection(opts.scroll === true);
      if (opts.silent === false) emitSelect();
      return true;
    },

    /** @returns {string|null} */
    getSelected() {
      return selectedKey;
    },

    /**
     * @param {(key: string|null, marker: BandMarker|null) => void} fn
     * @returns {() => void} unsubscribe
     */
    onSelect(fn) {
      if (typeof fn !== "function") return () => {};
      selectListeners.add(fn);
      return () => selectListeners.delete(fn);
    },

    /**
     * What the pill needs: a state and a number, never a sentence.
     *
     * `count` is CALENDARS, not rows, because that is what the pill prints
     * ("{n} calendars", UI_SPEC 2.2). A municipality with three calendars and
     * nothing on today has three calendars, and saying zero would be a claim
     * about publishing rather than about today.
     */
    getSummary() {
      return {
        id: "now",
        state: bandState,
        count: calendarCount,
        rows: rowCount,
        markers: markers.length,
      };
    },

    _internals: { parseOpeningHours, openState, weekendRange, houseInRange, ods, pointOf },
  };
}

// ------------------------------------------------------------------ plumbing

/**
 * The inline "this is not in your language" marker. Must stay byte-identical
 * to i18n.js's UNTRANSLATED_MARK; this module takes its strings through ctx
 * and imports no i18n module, so it cannot import the constant.
 */
const UNTRANSLATED_MARK = " *";

/**
 * @param {Function} [fn]      ctx.t, the shell's bound chrome lookup
 * @param {Function} [langOf]  () => the ACTIVE UI language. A function, not a
 *        string, because setLanguage() mutates cfg.uiLang after this closure
 *        is built and a captured string would freeze the marker at mount.
 */
function makeT(fn, langOf) {
  return (key, fallback) => {
    if (fn) {
      const v = fn(key);
      if (v && v !== key) return v;
    }
    if (fallback === undefined) return key;
    // Acceptance test 4, second clause: this module's own English standing in
    // for a missing Dutch or French string is an untranslated string, and must
    // be marked rather than pass as a translation.
    const lang = typeof langOf === "function" ? langOf() : langOf;
    return lang && lang !== "en" ? fallback + UNTRANSLATED_MARK : fallback;
  };
}

function safeStorage() {
  try {
    const s = globalThis.localStorage;
    s.setItem("behere.probe", "1");
    s.removeItem("behere.probe");
    return s;
  } catch {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, v),
      removeItem: (k) => m.delete(k),
    };
  }
}

function loadStore(storage) {
  try {
    const raw = storage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveStore(storage, obj) {
  try {
    storage.setItem(STORE_KEY, JSON.stringify(obj));
  } catch {
    /* quota or private mode */
  }
}

export default createNowBand;

// ===========================================================================
// Class names (the stylesheet owns every rule; this file ships none)
// ===========================================================================
//
//  now-group           <section> per kind, carries data-kind="market|
//                      collection|event" and, when it has nothing to say,
//                      data-silence (see below)
//  now-group-head      <h3>
//  now-items           <ul>
//  now-item            <li>, carries data-kind, data-key and, when selected,
//                      data-selected="true". Markets add data-open, collections
//                      data-days, events data-weekend.
//  now-item__card      the item card of UI_SPEC 2.3. A <button> when the row
//                      has a point of its own (markets, events), a <div> for a
//                      waste collection, which is keyed on a street and a
//                      house-number band and has no coordinate at all.
//                      aria-current="true" when selected.
//  now-when            tabular; the time span, the weekday, or "Today"
//  now-what            the name or title
//  now-where           the venue
//  now-item__tags      <p>, the tag row
//  now-open            .tag .tag-accent-2 when data-open="open",
//                      .tag .tag-neutral when "closed" or "unknown".
//                      `unknown` is NOT a warning: a source that publishes its
//                      hours as prose has not failed, and this band refuses to
//                      guess a state from it. data-open is the attribute the
//                      stylesheet keys on; data-state repeats it for callers
//                      that already read the old name.
//  now-approx          "hours vary by season"; .tag .tag-neutral, title=raw
//  now-frac            one waste fraction; .tag .tag-neutral
//  now-raw             the source's own words, verbatim, when no state could be
//                      derived. Never translated, never reformatted.
//  now-item__link      outbound <a>; .tag .tag-outline, chevron glyph,
//                      aria-label is the event's own title
//
//  now-note            a note. data-kind says WHICH silence it is:
//                        nothing      the calendar answered and has nothing
//                        declined     the portal's daily budget is spent
//                        unreachable  could not be reached: the only fault,
//                                     and the only one carrying a glyph
//                        waiting      the address is not known yet
//  now-asof            the warn tone, and the ONLY warn tone in this band:
//                      data that is real but old. data-kind="stale".
//  now-src             source + vintage, data-sources and data-budget (test 8)
