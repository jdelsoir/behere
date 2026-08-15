/**
 * Unit tests for web/app/stats.js, run against the 55 records actually shipped
 * in web/data/nis_history.json and the 565 codes in web/data/municipalities.json.
 *
 * No test framework, no dependency, no npm install: plain node, stdlib only,
 * exactly like scripts/*.py is plain python3.
 *
 *   node scripts/test_stats.mjs        # exits 1 on the first failure
 *
 * PLAN acceptance test 3 is the thing under test:
 *   "A statistic from a pre-2025 vintage either passes through
 *    nis_history.json or is refused, never silently dropped."
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  PINNED_VINTAGE, JOIN, joinStatistic, indexHistory, currentSet,
  normaliseVintage, needsAggregateMarker, joinForDisplay,
} from "../web/app/stats.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const read = (p) => JSON.parse(readFileSync(join(REPO, p), "utf8"));

const history = read("web/data/nis_history.json");
const municipalities = read("web/data/municipalities.json");
const idx = indexHistory(history);
const current = currentSet(municipalities);

let pass = 0;
const failures = [];

function ok(cond, what, detail) {
  if (cond) { pass++; return; }
  failures.push(what + (detail ? "  -> " + JSON.stringify(detail) : ""));
}
function eq(a, b, what) {
  ok(a === b, what, { got: a, want: b });
}

/* ------------------------------------------------------------------ 0 */
console.log("nis_history.json: %d records, vintage %s", idx.count, idx.vintage);
console.log("municipalities.json: %d codes", current.size);
eq(idx.count, 55, "all 55 history records index");
eq(current.size, 565, "the pinned set is 565 municipalities");
eq(PINNED_VINTAGE, "2025-01-01", "the pin is 2025-01-01");

/* ------------------------------------------------------------------ 1
 * normaliseVintage                                                     */
eq(normaliseVintage(2022), "2022-01-01", "a bare year is 1 January");
eq(normaliseVintage("2022"), "2022-01-01", "a bare year string is 1 January");
eq(normaliseVintage("2025-01-01"), "2025-01-01", "a full date passes through");
eq(normaliseVintage("2025-04"), "2025-04-01", "a year-month is the 1st");
eq(normaliseVintage("rubbish"), null, "rubbish is null");
eq(normaliseVintage(null), null, "null is null");

/* ------------------------------------------------------------------ 2
 * (a) at or after the pin: returned, no history needed                 */
{
  const r = joinStatistic("44021", "2025-01-01", null, { value: 42, municipalities });
  eq(r.kind, JOIN.CURRENT, "2025-01-01 for Ghent is current");
  eq(r.ok, true, "current is ok");
  eq(r.value, 42, "current carries the value");
  const r2 = joinStatistic("44021", 2026, null, { value: 42, municipalities });
  eq(r2.kind, JOIN.CURRENT, "a 2026 statistic is current even with no history");
}

/* ------------------------------------------------------------------ 3
 * an untouched code, older statistic: passes, flagged unchanged        */
for (const [nis, name] of [["44021", "Ghent"], ["62063", "Liege"], ["21004", "Brussels"],
                           ["35013", "Ostend"], ["81001", "Arlon"],
                           ["25121", "Ottignies-LLN"], ["92003", "Andenne"]]) {
  const r = joinStatistic(nis, 2022, history, { value: 1, municipalities });
  eq(r.kind, JOIN.UNCHANGED, "2022 for " + name + " (" + nis + ") is unchanged");
  eq(r.nis, nis, "unchanged keeps the code for " + name);
}

/* ------------------------------------------------------------------ 4
 * (b) a recode is followed SILENTLY                                    */
{
  // Manage 52043 -> 55086, Hainaut administrative-district reform, 2019-01-01.
  const r = joinStatistic("52043", 2015, history, { value: 7, municipalities });
  eq(r.kind, JOIN.RECODE, "Manage 52043 in 2015 is a recode");
  eq(r.nis, "55086", "Manage resolves to 55086");
  eq(r.from, "52043", "the recode names where it came from");
  eq(r.value, 7, "the recode carries the value");
  eq(needsAggregateMarker(r), false, "a recode is NOT marked");
}
{
  // Mouscron 54007 -> 57096, same reform.
  const r = joinStatistic("54007", "2010-01-01", history, { value: 1, municipalities });
  eq(r.kind, JOIN.RECODE, "Mouscron 54007 in 2010 is a recode");
  eq(r.nis, "57096", "Mouscron resolves to 57096");
}
{
  // A recode measured AFTER its own wave is simply unchanged.
  const r = joinStatistic("55086", 2022, history, { value: 1, municipalities });
  eq(r.kind, JOIN.UNCHANGED, "55086 in 2022 is unchanged: the reform is behind it");
}

/* ------------------------------------------------------------------ 5
 * (c) a merger returns the value FLAGGED, naming the retired NIS       */
{
  // Borsbeek 11007 was absorbed by Antwerpen 11002 on 2025-01-01.
  const r = joinStatistic("11007", 2022, history, { value: 10500, municipalities });
  eq(r.kind, JOIN.AGGREGATE, "Borsbeek 11007 in 2022 is an aggregate");
  eq(r.ok, true, "an aggregate is still ok: the value is returned, not dropped");
  eq(r.nis, "11002", "Borsbeek resolves into Antwerpen 11002");
  eq(r.value, 10500, "the aggregate carries the value");
  eq(needsAggregateMarker(r), true, "an aggregate IS marked");
  ok(r.retired.some((x) => x.nis === "11007"), "the retired NIS is named", r.retired);
  ok(/Borsbeek/.test(r.note), "the copy names the retired municipality", r.note);
}
{
  // The other direction: Antwerpen kept 11002 but GREW on 2025-01-01, so a
  // 2022 figure for 11002 describes a smaller territory than today's code.
  const r = joinStatistic("11002", 2022, history, { value: 1, municipalities });
  eq(r.kind, JOIN.AGGREGATE, "11002 in 2022 is an aggregate: it absorbed Borsbeek");
  ok(r.retired.some((x) => x.nis === "11007"), "and it names Borsbeek", r.retired);
}
{
  // Three-way: Galmaarden/Gooik/Herne -> Pajottegem 23106 on 2025-01-01.
  const r = joinStatistic("23106", 2020, history, { value: 1, municipalities });
  eq(r.kind, JOIN.AGGREGATE, "Pajottegem 23106 in 2020 is an aggregate");
  eq(r.retired.length >= 3, true, "it names every code it absorbed");
}
{
  // A merger measured after its own wave is unchanged again.
  const r = joinStatistic("23106", "2025-06-01", history, { value: 1, municipalities });
  eq(r.kind, JOIN.CURRENT, "23106 in mid-2025 is current");
}

/* ------------------------------------------------------------------ 6
 * (d) typed refusals. Never undefined, never a bare value              */
{
  const r = joinStatistic("99999", 2022, history, { value: 1, municipalities });
  eq(r.ok, false, "an unknown code is refused");
  eq(r.kind, JOIN.REFUSED, "and the kind says so");
  eq(r.reason, "unknown-nis", "with reason unknown-nis");
  ok(typeof r.note === "string" && r.note.length > 0, "and a sentence to print", r.note);
}
{
  const r = joinStatistic("44021", 2022, null, { value: 1, municipalities });
  eq(r.ok, false, "a pre-pin statistic with NO history is refused");
  eq(r.reason, "no-history", "with reason no-history");
}
{
  const r = joinStatistic("44021", 2022, history, { value: null, municipalities });
  eq(r.ok, false, "a null value is refused");
  eq(r.reason, "no-value", "with reason no-value");
}
{
  const r = joinStatistic("44021", "not a date", history, { value: 1, municipalities });
  eq(r.ok, false, "an unreadable vintage is refused");
  eq(r.reason, "bad-vintage", "with reason bad-vintage");
}
{
  const r = joinStatistic("", 2022, history, { value: 1, municipalities });
  eq(r.ok, false, "an empty code is refused");
}

/* ------------------------------------------------------------------ 7
 * exhaustive: every one of the 55 records, both directions, never
 * undefined and never a silent drop                                    */
{
  let recodes = 0, mergers = 0, undefs = 0, blanks = 0;
  for (const rec of idx.records) {
    const before = String(Number(rec.valid_from.slice(0, 4)) - 3);
    const r = joinStatistic(rec.old_nis, before, history, { value: 1, municipalities });
    if (r === undefined || r === null) { undefs++; continue; }
    if (typeof r.kind !== "string" || r.kind === "") blanks++;
    if (r.ok !== true) {
      failures.push("record " + rec.old_nis + " -> " + rec.new_nis + " (" + rec.kind +
        ") was refused: " + r.reason);
      continue;
    }
    if (rec.kind === "recode") {
      recodes++;
      // A recode is followed silently UNLESS a later merger also applies.
      ok(r.kind === JOIN.RECODE || r.kind === JOIN.AGGREGATE,
        "recode " + rec.old_nis + " resolves", r);
    } else {
      mergers++;
      eq(r.kind, JOIN.AGGREGATE, "merger " + rec.old_nis + " is an aggregate");
      ok(r.retired.length > 0, "merger " + rec.old_nis + " names a retired code");
    }
    // Whatever the outcome, the code it lands on must exist in the pinned set.
    ok(current.has(r.nis), "resolved code " + r.nis + " is one of the 565", r);
  }
  eq(undefs, 0, "no call returned undefined");
  eq(blanks, 0, "every result carries a kind");
  console.log("  followed %d recodes and %d mergers through the table", recodes, mergers);
  eq(recodes, 11, "all 11 recodes followed");
  eq(mergers, 44, "all 44 mergers flagged");
}

/* ------------------------------------------------------------------ 8
 * every current code, with a 1992 statistic, is classified              */
{
  const kinds = {};
  for (const nis of current) {
    const r = joinStatistic(nis, 1992, history, { value: 1, municipalities });
    ok(r !== undefined && r !== null, "1992 join for " + nis + " returned something");
    kinds[r.kind] = (kinds[r.kind] || 0) + 1;
    if (!r.ok) failures.push("1992 join for current code " + nis + " refused: " + r.reason);
  }
  console.log("  1992 against all 565 current codes:", JSON.stringify(kinds));
  ok((kinds[JOIN.AGGREGATE] || 0) > 0, "some current codes are aggregates in 1992", kinds);
  ok((kinds[JOIN.UNCHANGED] || 0) > 0, "most current codes are unchanged", kinds);
  eq(kinds[JOIN.REFUSED] || 0, 0, "no current code is refused");
}

/* ------------------------------------------------------------------ 9
 * joinForDisplay never hands back undefined                             */
{
  const d = joinForDisplay("11007", 2022, history, { value: 5, municipalities });
  eq(d.marked, true, "joinForDisplay marks an aggregate");
  eq(d.value, 5, "joinForDisplay returns the value");
  const d2 = joinForDisplay("99999", 2022, history, { value: 5, municipalities });
  eq(d2.value, null, "joinForDisplay withholds a refused value");
  ok(d2.note.length > 0, "and hands back the sentence instead");
}

/* ------------------------------------------------------------------ */
console.log("\n%d assertions passed, %d failed", pass, failures.length);
if (failures.length) {
  for (const f of failures.slice(0, 40)) console.error("  FAIL " + f);
  process.exit(1);
}
console.log("stats.js: acceptance test 3 is represented in code and passes.");
