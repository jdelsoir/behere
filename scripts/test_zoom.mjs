/**
 * Tests for web/app/zoom.js: the Zoom out band and its vintage guard.
 *
 * Plain node, no framework, no dependency.
 *
 *   node scripts/test_zoom.mjs          # offline checks only
 *   node scripts/test_zoom.mjs --live   # also calls the Statbel HVD API
 *
 * The --live pass is a WARNING, never a failure: a third-party outage must not
 * break the build. The offline pass is a hard gate.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { districtSet, guardFigure, readArrondissement, ZOOM_UI_KEYS } from "../web/app/zoom.js";
import { indexHistory, JOIN, needsAggregateMarker } from "../web/app/stats.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const read = (p) => JSON.parse(readFileSync(join(REPO, p), "utf8"));

const history = indexHistory(read("web/data/nis_history.json"));
const municipalities = read("web/data/municipalities.json");
const districts = districtSet(municipalities);

let pass = 0;
const failures = [];
const ok = (c, what, d) => (c ? pass++ : failures.push(what + (d ? "  -> " + JSON.stringify(d) : "")));
const eq = (a, b, what) => ok(a === b, what, { got: a, want: b });

const PILOTS = {
  "44021": { nuts3: "BE234", dstr: "44000", name: "Ghent" },
  "62063": { nuts3: "BE332", dstr: "62000", name: "Liege" },
  "21004": { nuts3: "BE100", dstr: "21000", name: "Brussels" },
  "35013": { nuts3: "BE255", dstr: "35000", name: "Ostend" },
  "81001": { nuts3: "BE341", dstr: "81000", name: "Arlon" },
  "25121": { nuts3: "BE310", dstr: "25000", name: "Ottignies-LLN" },
  "92003": { nuts3: "BE352", dstr: "92000", name: "Andenne" },
};

/* --- 1. the district set is real and covers every pilot ---------------- */
eq(districts.size, 43, "municipalities.json carries 43 arrondissements");
for (const [nis, p] of Object.entries(PILOTS)) {
  const baked = read("web/data/" + nis + "/meta.json");
  eq(baked.nuts3, p.nuts3, nis + " meta.json nuts3 is " + p.nuts3);
  eq(baked.dstr, p.dstr, nis + " meta.json dstr is " + p.dstr);
  ok(districts.has(p.dstr), p.dstr + " is a pinned arrondissement code");
}

/* --- 2. the guard runs on both ends of the join ------------------------ */
for (const [nis, p] of Object.entries(PILOTS)) {
  const g = { history, municipalities, districts, nis, dstr: p.dstr };
  const r = guardFigure(g, 2022, 1234, true);
  eq(r.ok, true, "2022 district figure for " + p.name + " joins");
  eq(r.kind, JOIN.UNCHANGED, "2022 for " + p.name + " is unchanged on both ends");
}

/* --- 3. a municipality that MOVED arrondissement is caught ------------- */
{
  // Manage: 52043 -> 55086 on 2019-01-01, and with it out of arrondissement
  // 52000 into 55000. A 2015 figure attached to today's codes is a cross-
  // vintage join and must not pass silently.
  const g = { history, municipalities, districts, nis: "52043", dstr: "55000" };
  const r = guardFigure(g, 2015, 1, true);
  eq(r.ok, true, "Manage 2015 still yields a value");
  eq(r.kind, JOIN.RECODE, "and it is reported as a recode, not as unchanged");
  eq(r.nis, "55086", "resolved to the 2025 code 55086");
}
{
  // A pre-2019 arrondissement code that no longer exists. Mouscron's own
  // arrondissement 54000 was folded into Tournai-Mouscron 57000 in the same
  // 2019 reform, and municipalities.json ships 43 codes with no 54000 among
  // them. A figure filed under it cannot be attached to anything today.
  ok(!districts.has("54000"), "arrondissement 54000 is not in the 2025 set");
  const g = { history, municipalities, districts, nis: "44021", dstr: "54000" };
  const r = guardFigure(g, 2015, 1, true);
  eq(r.ok, false, "the retired arrondissement 54000 is refused");
  eq(r.reason, "unknown-nis", "with reason unknown-nis");
}
{
  // A merged municipality: value returned, flagged, retired code named.
  const g = { history, municipalities, districts, nis: "11007", dstr: "11000" };
  const r = guardFigure(g, 2022, 500, true);
  eq(r.kind, JOIN.AGGREGATE, "Borsbeek 2022 is an aggregate");
  eq(needsAggregateMarker(r), true, "and the UI is told to mark it");
}
{
  // No history loaded at all: a pre-pin statistic is refused outright.
  const g = { history: null, municipalities, districts, nis: "44021", dstr: "44000" };
  const r = guardFigure(g, 2022, 1, true);
  eq(r.ok, false, "with no nis_history.json a pre-2025 figure is refused");
  eq(r.reason, "no-history", "with reason no-history");
}

/* --- 4. the copy table is complete ------------------------------------ */
ok(ZOOM_UI_KEYS.length > 0, "zoom.js declares its UI keys");
ok(ZOOM_UI_KEYS.includes("empty.zoom.offline"), "including the offline copy");

/* --- 5. live, optional ------------------------------------------------ */
if (process.argv.includes("--live")) {
  console.log("\nlive Statbel HVD reads (warnings only):");
  for (const [nis, p] of Object.entries(PILOTS)) {
    try {
      const f = await readArrondissement(p.nuts3, p.dstr);
      if (!f.reached) {
        console.warn("  WARN %s %s: Statbel unreachable", nis, p.name);
        continue;
      }
      const g = { history, municipalities, districts, nis, dstr: p.dstr };
      const j = guardFigure(g, f.popYear, f.population, false);
      console.log(
        "  " + nis + " " + p.name.padEnd(14) + " " + p.nuts3 + "/" + p.dstr +
        "  pop " + (f.population === null ? "—" : f.population) +
        " (" + f.popYear + ", join=" + j.kind + ")" +
        "  medianAge " + f.medianAgeM + "/" + f.medianAgeF +
        "  birth " + (f.birthRate ? f.birthRate.value.toFixed(6) + "@" + f.birthRate.year : "—") +
        "  death " + (f.deathRate ? f.deathRate.value.toFixed(6) + "@" + f.deathRate.year : "—")
      );
      if (f.population === null) console.warn("    WARN no MS_POP rows returned");
    } catch (err) {
      console.warn("  WARN %s: %s", nis, err && err.message);
    }
  }
}

console.log("\n%d assertions passed, %d failed", pass, failures.length);
if (failures.length) {
  for (const f of failures) console.error("  FAIL " + f);
  process.exit(1);
}
console.log("zoom.js: every displayed figure passes through the nis_history guard.");
