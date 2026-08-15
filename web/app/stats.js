/**
 * BeHERE statistics join guard.
 *
 * PLAN acceptance test 3, in executable form:
 *
 *   "A statistic from a pre-2025 vintage either passes through
 *    nis_history.json or is refused, never silently dropped."
 *
 * Every value read from the Statbel HVD API goes through joinStatistic()
 * before it reaches a pixel. There is no second path: zoom.js imports this
 * module and nothing else knows how to turn a Statbel row into a displayable
 * number.
 *
 * WHY THIS MODULE EXISTS AT ALL
 * -----------------------------
 * Belgium went from 581 municipalities to 565 on 1 January 2025, and from 589
 * to 581 on 1 January 2019. The Hainaut administrative-district reform of 2019
 * additionally RENUMBERED eleven municipalities that never merged (Manage
 * 52043 -> 55086, Mouscron 54007 -> 57096, ...). The whole app is pinned to the
 * 2025-01-01 vintage, while the Statbel demographic tables reach back to 1992.
 * So almost every statistic this app can display is older than the geometry it
 * would be attached to, and a naive join is either a silent miss (the old code
 * is not in the current set, the row disappears) or a silent lie (the code
 * survived but the territory behind it grew).
 *
 * THE RESULT IS ALWAYS A TYPED OBJECT. NEVER undefined, NEVER a bare number.
 *
 *   {ok:true,  kind:"current"}    the statistic is at or after the pinned
 *                                 vintage; no history lookup is needed
 *   {ok:true,  kind:"unchanged"}  older, but no boundary change touched this
 *                                 code between the statistic and the pin
 *   {ok:true,  kind:"recode"}     the code was renumbered with no boundary
 *                                 change: followed silently, as the contract
 *                                 in nis_history.json's own notes requires
 *   {ok:true,  kind:"aggregate"}  a merger sits between the statistic and the
 *                                 pin, so the number describes a different
 *                                 territory than the code does today. The
 *                                 value is returned, FLAGGED, with the retired
 *                                 NIS codes named so the UI can say which
 *                                 municipalities were folded in
 *   {ok:false, kind:"refused"}    the join could not be made honestly. Always
 *                                 carries `reason` and `note`
 *
 * Refusal reasons, all of them mechanical:
 *
 *   "no-value"      the source row carried no usable number
 *   "bad-vintage"   the statistic's own vintage could not be parsed
 *   "no-history"    the statistic predates the pin and nis_history.json is not
 *                   loaded, so the join CANNOT be checked. Refusing is the
 *                   whole point of the acceptance test
 *   "unknown-nis"   the code is neither in the pinned 565-code set nor in the
 *                   history table. It belongs to no vintage this app knows
 *   "retired-nis"   the code was retired and the history gives no successor
 *
 * A note on the audit's suggested rule
 * ------------------------------------
 * "return a typed refusal for any NIS not present in nis_history when the
 * vintage is older" is too strong taken literally: nis_history.json holds only
 * the 55 codes that CHANGED, so 44021 (Ghent), 62063 (Liege) and 535 others
 * are absent from it by design, and refusing them would refuse essentially
 * every statistic in the country. The rule implemented here is the strictly
 * stronger one it was reaching for: the code is checked against BOTH tables,
 * and a code absent from both is refused as "unknown-nis". Absence from the
 * history table alone is proof the boundary did not move, which is exactly the
 * fact the join needs.
 *
 * Plain ES module, no build step, no dependency.
 */

/* ===================================================================== *
 * 0. The pin
 * ===================================================================== */

/** The one data vintage this release is pinned to. CLAUDE.md, PLAN trap 1. */
export const PINNED_VINTAGE = "2025-01-01";

/** Result kinds, exported so a consumer can switch on them without literals. */
export const JOIN = Object.freeze({
  CURRENT: "current",
  UNCHANGED: "unchanged",
  RECODE: "recode",
  AGGREGATE: "aggregate",
  REFUSED: "refused",
});

/* ===================================================================== *
 * 1. Vintage arithmetic
 * ===================================================================== */

/**
 * Normalise a vintage to YYYY-MM-DD.
 *
 * Statbel hands out bare years (`CD_YEAR: 2022`). A bare year is taken as
 * 1 January of that year, which is also how Statbel labels its population
 * series ("Population on 1 January"), so the reading is the source's own.
 *
 * @param {string|number|Date|null|undefined} v
 * @returns {string|null} YYYY-MM-DD, or null when it cannot be read.
 */
export function normaliseVintage(v) {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  }
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v < 1000 || v > 9999) return null;
    return String(Math.trunc(v)) + "-01-01";
  }
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (/^\d{4}$/.test(s)) return s + "-01-01";
  if (/^\d{4}-\d{2}$/.test(s)) return s + "-01";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

/** Lexical comparison is correct for YYYY-MM-DD and needs no Date parsing. */
function isBefore(a, b) {
  return a < b;
}

/* ===================================================================== *
 * 2. The history table
 * ===================================================================== */

/**
 * @typedef {Object} NisHistoryRecord
 * @property {string} old_nis @property {string} new_nis
 * @property {"merger"|"recode"} kind
 * @property {string} valid_from  YYYY-MM-DD
 * @property {string} [old_nl] @property {string} [old_fr]
 */

/**
 * @typedef {Object} NisHistoryIndex
 * @property {string} vintage
 * @property {number} count
 * @property {Map<string, NisHistoryRecord[]>} byOld
 * @property {Map<string, NisHistoryRecord[]>} byNew
 * @property {NisHistoryRecord[]} records
 */

const INDEXED = Symbol("behere.nisHistoryIndex");

/**
 * Index web/data/nis_history.json for lookup in both directions.
 *
 * Accepts the parsed document, a bare records array, or an already-built
 * index, so a caller never has to remember which it is holding.
 *
 * @param {Object|Array|NisHistoryIndex|null} doc
 * @returns {NisHistoryIndex|null}
 */
export function indexHistory(doc) {
  if (!doc) return null;
  if (doc[INDEXED] === true) return /** @type {NisHistoryIndex} */ (doc);

  const records = Array.isArray(doc)
    ? doc
    : Array.isArray(doc.records)
    ? doc.records
    : null;
  if (!records) return null;

  const byOld = new Map();
  const byNew = new Map();
  const clean = [];
  for (const r of records) {
    if (!r || typeof r !== "object") continue;
    const old_nis = String(r.old_nis || "");
    const new_nis = String(r.new_nis || "");
    const valid_from = normaliseVintage(r.valid_from);
    if (!old_nis || !new_nis || !valid_from) continue;
    const rec = {
      old_nis,
      new_nis,
      kind: r.kind === "recode" ? "recode" : "merger",
      valid_from,
      old_nl: r.old_nl || "",
      old_fr: r.old_fr || "",
    };
    clean.push(rec);
    if (!byOld.has(old_nis)) byOld.set(old_nis, []);
    byOld.get(old_nis).push(rec);
    if (!byNew.has(new_nis)) byNew.set(new_nis, []);
    byNew.get(new_nis).push(rec);
  }
  // Oldest wave first: a code can move twice (52043 -> 55086 in 2019), and the
  // first change after the statistic is the one that has to be followed.
  for (const list of byOld.values()) list.sort((a, b) => (a.valid_from < b.valid_from ? -1 : 1));
  for (const list of byNew.values()) list.sort((a, b) => (a.valid_from < b.valid_from ? -1 : 1));

  const index = {
    vintage: (doc.meta && normaliseVintage(doc.meta.vintage)) || PINNED_VINTAGE,
    count: clean.length,
    records: clean,
    byOld,
    byNew,
  };
  Object.defineProperty(index, INDEXED, { value: true, enumerable: false });
  return index;
}

/**
 * The set of codes valid in the pinned vintage.
 *
 * Accepts the whole web/data/municipalities.json document (which nests the
 * codes under `municipalities`, alongside `districts`, `provinces`, `regions`
 * and `meta`), a bare table keyed by NIS, an array, or a Set. The nesting is
 * checked FIRST: reading five-digit keys off the top level of the whole
 * document would silently pick up nothing at all.
 *
 * @param {Object|Array|Set|null} municipalities @returns {Set<string>|null}
 */
export function currentSet(municipalities) {
  if (!municipalities) return null;
  if (municipalities instanceof Set) return municipalities;
  if (Array.isArray(municipalities)) return new Set(municipalities.map(String));
  if (typeof municipalities !== "object") return null;

  for (const key of ["municipalities", "records"]) {
    const nested = municipalities[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const keys = Object.keys(nested).filter((k) => /^\d{5}$/.test(k));
      if (keys.length) return new Set(keys);
    }
  }
  const keys = Object.keys(municipalities).filter((k) => /^\d{5}$/.test(k));
  return keys.length ? new Set(keys) : null;
}

/* ===================================================================== *
 * 3. The join
 * ===================================================================== */

function refuse(reason, note, extra) {
  return Object.assign(
    {
      ok: false,
      kind: JOIN.REFUSED,
      reason,
      note,
      nis: null,
      value: null,
      translated: false,
    },
    extra || {}
  );
}

/**
 * Join one statistic to the pinned municipality vintage.
 *
 * @param {string|number} nis        The code the statistic is filed under.
 * @param {string|number|Date} statVintage  The statistic's own vintage. A bare
 *        year is read as 1 January of that year.
 * @param {Object|Array|NisHistoryIndex|null} history  Parsed nis_history.json.
 * @param {Object} [opts]
 * @param {*} [opts.value]           The measured value. Required for ok:true.
 * @param {Object|Array|Set} [opts.municipalities]  The pinned code set.
 * @param {string} [opts.pinned]     Override the pin, for testing.
 * @param {boolean} [opts.allowMissingValue]  Treat a null value as legitimate
 *        (a genuine "not published"), returning kind unchanged but value null.
 * @returns {{ok: boolean, kind: string, nis: ?string, value: *,
 *            vintage: ?string, pinned: string, reason?: string, note?: string,
 *            from?: string, steps?: Array, retired?: Array}}
 *          Never undefined, never a bare value.
 */
export function joinStatistic(nis, statVintage, history, opts) {
  const o = opts || {};
  const pinned = normaliseVintage(o.pinned) || PINNED_VINTAGE;
  const code = nis === null || nis === undefined ? "" : String(nis).trim();
  const vintage = normaliseVintage(statVintage);
  const value = o.value === undefined ? null : o.value;
  const hasValue = value !== null && value !== undefined && !(typeof value === "number" && Number.isNaN(value));

  if (!code) {
    return refuse("unknown-nis", "No NIS code was supplied for this statistic.",
      { vintage, pinned });
  }
  if (!vintage) {
    return refuse("bad-vintage",
      "The statistic carries no readable vintage, so it cannot be checked " +
      "against the " + pinned + " municipality boundaries.",
      { nis: code, pinned, vintage: null });
  }
  if (!hasValue && !o.allowMissingValue) {
    return refuse("no-value",
      "The source answered for " + code + " but published no value for " +
      vintage + ".",
      { nis: code, vintage, pinned });
  }

  const base = { value, vintage, pinned };

  // (a) At or after the pin: today's boundaries, nothing to follow.
  if (!isBefore(vintage, pinned)) {
    return Object.assign({ ok: true, kind: JOIN.CURRENT, nis: code }, base);
  }

  // Older than the pin. From here the history table is mandatory: without it
  // the join cannot be checked, and an unchecked cross-vintage join is exactly
  // what CLAUDE.md forbids.
  const idx = indexHistory(history);
  if (!idx) {
    return refuse("no-history",
      "This figure is from " + vintage + ", before the " + pinned +
      " municipality reform, and the code history is not loaded, so it cannot " +
      "be attached to a municipality honestly.",
      { nis: code, vintage, pinned });
  }

  const current = currentSet(o.municipalities);

  // Walk forward through every wave that happened AFTER the statistic.
  const steps = [];
  const retired = [];
  let cursor = code;
  let aggregated = false;
  const guard = new Set([cursor]);

  for (;;) {
    const moves = (idx.byOld.get(cursor) || []).filter((r) => isBefore(vintage, r.valid_from));
    if (!moves.length) break;
    const move = moves[0];
    steps.push(move);
    if (move.kind === "merger") {
      aggregated = true;
      retired.push(move);
    }
    cursor = move.new_nis;
    if (guard.has(cursor)) break; // a cycle cannot happen, but never loop
    guard.add(cursor);
  }

  // The code may itself be a merger TARGET: it survived the wave under the
  // same number while absorbing a neighbour (Antwerpen 11002 absorbed
  // Borsbeek 11007 on 2025-01-01). Today's 11002 is a bigger territory than
  // the 2015 figure describes, so the figure is an aggregate mismatch in the
  // other direction and must be flagged just as loudly.
  for (const r of idx.byNew.get(cursor) || []) {
    if (r.old_nis === cursor) continue;
    if (!isBefore(vintage, r.valid_from)) continue;
    if (steps.indexOf(r) >= 0) continue;
    aggregated = true;
    retired.push(r);
  }

  const known = current ? current.has(cursor) : true;
  if (!known && !idx.byOld.has(cursor) && !idx.byNew.has(cursor)) {
    return refuse("unknown-nis",
      "NIS " + code + " belongs to no vintage BeHERE knows: it is not one of " +
      "the " + pinned + " municipalities and the code history does not " +
      "mention it.",
      { nis: code, vintage, pinned, from: code !== cursor ? code : undefined });
  }
  if (!known && idx.byOld.has(cursor)) {
    return refuse("retired-nis",
      "NIS " + cursor + " was retired and the code history records no " +
      "successor valid at " + pinned + ".",
      { nis: cursor, vintage, pinned, from: code, steps });
  }

  if (aggregated) {
    return Object.assign(
      {
        ok: true,
        kind: JOIN.AGGREGATE,
        nis: cursor,
        from: code,
        steps,
        retired: retired.map((r) => ({
          nis: r.old_nis,
          nl: r.old_nl,
          fr: r.old_fr,
          valid_from: r.valid_from,
        })),
        note:
          "Boundaries changed on " +
          retired.map((r) => r.valid_from).filter(uniq).sort().join(", ") +
          ". This figure covers the area before " +
          retired.map((r) => r.old_nl || r.old_fr || r.old_nis).filter(uniq).join(", ") +
          " was folded in, so it is an aggregate across two vintages.",
      },
      base
    );
  }

  if (code !== cursor) {
    // (b) Pure renumbering: followed silently, no marker, no copy.
    return Object.assign(
      { ok: true, kind: JOIN.RECODE, nis: cursor, from: code, steps }, base
    );
  }

  return Object.assign({ ok: true, kind: JOIN.UNCHANGED, nis: cursor }, base);
}

function uniq(v, i, a) {
  return a.indexOf(v) === i;
}

/**
 * True when the UI must show a marker and copy next to this value.
 * Only an aggregate is marked: a recode is invisible by design, and a refusal
 * is not a value at all, it is a sentence.
 * @param {Object} join a joinStatistic() result
 */
export function needsAggregateMarker(join) {
  return !!join && join.ok === true && join.kind === JOIN.AGGREGATE;
}

/**
 * Convenience for a band: join, and hand back either the value or null plus
 * the sentence to print instead. Still never returns undefined.
 * @returns {{value: *, note: string, marked: boolean, join: Object}}
 */
export function joinForDisplay(nis, statVintage, history, opts) {
  const join = joinStatistic(nis, statVintage, history, opts);
  return {
    value: join.ok ? join.value : null,
    note: join.ok ? (join.note || "") : join.note,
    marked: needsAggregateMarker(join),
    join,
  };
}
