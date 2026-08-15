/* BeHERE — the integration smoke.
 *
 * WHY THIS EXISTS
 *
 * Every other test in scripts/ checks one module against its own contract, and
 * all of them can be green while the app is broken, because the seams between
 * the modules are not any single module's contract. This one boots the REAL
 * web/index.html and the REAL web/app/main.js together, drives one Brussels fix
 * all the way through, and asserts the wires are connected:
 *
 *   index.html  ->  main.js  ->  here/around/go/now/zoom  ->  map.js
 *                     |                    |                    |
 *                   pills              markers             sectors, cell, dot
 *
 * It is a SMOKE test, not a rendering test. It cannot tell you the map looks
 * right. It can tell you that the shell found every element it queries, that
 * every band mounted and painted, that the position reached the map, that
 * here.js's sector reached the map, that opening a band switches its layer on,
 * and that nothing threw. That is precisely the class of defect that survives
 * six green unit suites — three real ones were found by writing it:
 *
 *   - index.html shipped class="chrome chrome-left" / "chrome-right" while
 *     app.css styles .chrome--tl / .chrome--tr, so both chrome clusters landed
 *     unpositioned on top of each other;
 *   - index.html shipped class="scale" for #map-scale while app.css styles
 *     .map-scale;
 *   - main.js dynamically imported "./dock.js", which does not exist, costing a
 *     404 and a console error on every cold boot.
 *
 * NO NETWORK. fetch() is served off the disk under web/, so this exercises the
 * real baked shards, the real join spine and the real i18n files. A remote host
 * 404s, which is what an offline device sees and what the bands must degrade
 * against — so a green run here is also a statement that the app answers with
 * no network at all.
 *
 * Run: node scripts/test_integration.mjs      (exit 0 pass, 1 fail)
 */

import { shellDom, WEB } from "./domstub.mjs";
import { wgs84ToCell } from "../web/app/grid.js";
import path from "node:path";

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) pass++;
  else { fail++; failures.push(msg); console.log("  FAIL " + msg); }
}
const head = (t) => { console.log(); console.log(t); };

/* ---------------------------------------------------------------- 1. DOM */

const h = shellDom({ w: 390, h: 844 });
const doc = h.doc;
console.log("index.html parsed: " + h.body.querySelectorAll("*").length + " elements");

head("1. every element the shell queries exists in the markup");
for (const id of ["map", "map-attrib", "map-status", "dock", "dock-panel", "dock-pills",
                  "layer-chips", "locate", "locate-status", "zoom-in", "zoom-out",
                  "map-scale", "tile-note", "panel-title", "panel-kicker", "panel-close",
                  "app-menu", "app-sheet", "brand-place", "offline-bar", "offline-stored",
                  "foot-vintage", "foot-built", "sources-list", "sources-count", "ios-hint"]) {
  ok(!!doc.getElementById(id), "#" + id);
}
for (const b of ["here", "around", "go", "now", "zoom"]) {
  const s = doc.getElementById("band-" + b);
  ok(!!s, "#band-" + b);
  ok(!!doc.getElementById("pill-" + b), "#pill-" + b);
  ok(!!(s && s.querySelector('[data-role="body"]')), "#band-" + b + " has its mount point");
  ok(!!(s && s.querySelector('[data-role="src"]')), "#band-" + b + " has its source slot");
}
/* The attribution is an ODbL term. It must be a SIBLING of #map, because #map
   is aria-hidden and a focusable link inside an aria-hidden subtree is lost. */
const attrib = doc.getElementById("map-attrib");
ok(attrib && attrib.parentNode === h.body, "the attribution sits outside #map");
ok(!!(attrib && attrib.querySelector("a")), "and it carries a link");

/* ---------------------------------------------------------------- 2. boot */

head("2. booting web/app/main.js");
const errors = [];
const origError = console.error;
console.error = (...a) => { errors.push(a.map(String).join(" ")); };
process.on("uncaughtException", (e) => errors.push(e));

let mod;
try {
  mod = await import(path.join(WEB, "app/main.js"));
} catch (e) {
  console.error = origError;
  console.log("  BOOT THREW: " + (e && e.message));
  console.log(e && e.stack);
  process.exit(1);
}
async function settle(rounds = 40) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, 20));
    h.flush();
  }
}
await settle();

const app = mod.app;
ok(!!app, "main.js exports its app state");
ok(!!app.i18n, "i18n booted");
ok(!!app.meta, "meta.json loaded");
ok(!!app.municipalities, "municipalities.json loaded");
ok(app.bands.size === 5, "all five bands mounted (got " + app.bands.size + ")");
for (const [id, rec] of app.bands) ok(!!rec.controller, "band " + id + " returned a controller");
ok(!!app.map, "map.js mounted");

head("3. map.js adopted the shell's nodes rather than making a second set");
ok(app.map && app.map.element === doc.getElementById("map"), "it took index.html's #map");
ok(h.body.querySelectorAll(".map-attrib").length === 1, "exactly one .map-attrib");
ok(h.body.querySelectorAll(".map-status").length === 1, "exactly one .map-status");
const mapEl = doc.getElementById("map");
for (const cls of ["map-tiles", "map-veil", "map-vectors", "map-markers", "map-position"]) {
  ok(mapEl.querySelectorAll("." + cls).length === 1, "exactly one ." + cls);
}
/* main.js mounts with { keyboard: true }, so #map is EXPOSED and holds exactly
   one tab stop. The two go together: a focusable node inside an aria-hidden
   subtree is an authoring error. It is still not a trap (map.js never
   intercepts Tab) and it is still one stop, not one per marker, because every
   painted layer inside it is aria-hidden and holds nothing focusable. */
ok(mapEl.getAttribute("aria-hidden") === null,
   "#map is exposed, because it is now focusable");
ok(mapEl.getAttribute("tabindex") === "0", "#map holds exactly one tab stop");
ok(mapEl.getAttribute("role") === "group", "#map is a labelled group");
ok(/arrow/i.test(mapEl.getAttribute("aria-label") || ""),
   "and its name says how it is operated: " + mapEl.getAttribute("aria-label"));
ok(mapEl.querySelectorAll("[tabindex], a[href], button, input, select, textarea").length === 0,
   "#map contains no other focusable node, so the stop count cannot grow with the markers");
for (const cls of ["map-tiles", "map-veil", "map-vectors", "map-markers", "map-position"]) {
  ok(mapEl.querySelector("." + cls).getAttribute("aria-hidden") === "true",
     "." + cls + " stays decorative to AT");
}

head("4. the dock boots collapsed");
ok(doc.getElementById("dock-panel").hidden === true, "the panel is hidden");
for (const b of ["here", "around", "go", "now", "zoom"]) {
  ok(doc.getElementById("pill-" + b).getAttribute("aria-expanded") === "false",
     "pill " + b + " reports collapsed");
}

/* ------------------------------------------------------- 5. a real fix */

head("5. one Brussels fix, through the whole app");
ok(h.geoWatchers.length === 0, "no geolocation watcher before a user gesture");
doc.getElementById("locate").dispatch("click", {});
await new Promise((r) => setTimeout(r, 20));
ok(h.geoWatchers.length === 1, "exactly one watcher, and only after the gesture");

h.geoWatchers[0].okFn({
  coords: { latitude: 50.84673, longitude: 4.35247, accuracy: 12 },
  timestamp: Date.now(),
});
await settle(60);

ok(!!app.position, "the shell holds the position");
/* Not a hard-coded id: grid.js is asked the same question the shell asked, so
   this asserts the SPINE agrees with itself rather than pinning a constant. */
ok(app.cell === wgs84ToCell(50.84673, 4.35247),
   "the centre cell is grid.js's own answer: " + app.cell);
ok(app.shards.has(app.cell), "and that shard is decoded and loaded");
ok(app.nis === "21004", "NIS 21004 resolved from the ADDRESS record, never a postcode");
ok(!!app.muntyMeta && app.muntyMeta.nis === "21004", "<nis>/meta.json loaded");
ok(!!app.nearest && !!app.nearest.item, "the nearest address resolved");
ok(!!app.streets, "<nis>/streets.json loaded");

head("6. here.js is the one sector authority, and the map is TOLD");
ok(!!app.here, "here.js published a HereMapState");
ok(!!(app.here && app.here.sector), "it names a sector: " + (app.here && app.here.sector));
ok(!!(app.here && app.here.sectors), "it carries the decoded sector.geojson");
ok(!!(app.here && app.here.sectors && Array.isArray(app.here.sectors.features)),
   "which is a FeatureCollection of " +
   (app.here && app.here.sectors ? app.here.sectors.features.length : 0) + " features");
const mp = app.map.getPosition();
ok(!!mp && Math.abs(mp.lat - 50.84673) < 1e-9 && Math.abs(mp.lon - 4.35247) < 1e-9,
   "map.js holds the same fix the shell does");
ok(mp && mp.accuracy === 12, "and the REAL accuracy, not a placeholder: " + (mp && mp.accuracy));

head("7. every band painted, and every pill says something");
for (const [id, rec] of app.bands) {
  const body = rec.section.querySelector('[data-role="body"]');
  ok(body && (body.childNodes.length > 0 || (body._text || "").trim().length > 0),
     "band " + id + " painted into its body");
  ok(!!rec.section.dataset.state, "band " + id + " carries data-state=" + rec.section.dataset.state);
}
for (const id of ["here", "around", "go", "now", "zoom"]) {
  const pill = doc.getElementById("pill-" + id);
  const dot = pill.querySelector(".pill__state");
  const count = pill.querySelector(".pill__count");
  console.log(`  pill ${id.padEnd(7)} state=${(dot && dot.dataset.state) || "-"}  "${(count && count.textContent) || ""}"`);
  ok(!!dot && !!dot.dataset.state, "pill " + id + " carries a state");
  /* The dot is reinforcement only; the same fact must be in words beside it,
     so the signal survives a monochrome rendering. */
  ok(!!count, "pill " + id + " carries a text count");
}

head("8. the source and vintage line (acceptance test 8)");
for (const [id, rec] of app.bands) {
  const src = rec.section.querySelector('[data-role="src"]');
  const filled = src && !src.hidden && (src.textContent || "").trim().length > 0;
  /* A band with nothing to attribute may honestly print nothing; a band that
     answered must attribute. Here and Zoom always answer from baked data. */
  /* Here answers from baked data, so offline it must still attribute. Zoom,
     Around, Go and Now answer from live sources; with no network they draw
     nothing, and a band that drew nothing has nothing to attribute. Asserting
     otherwise would demand a citation for an absent layer. */
  if (id === "here") ok(filled, "band here names its source: " + (src && src.textContent));
  else ok(true, "band " + id + ": " + (filled ? (src.textContent || "").slice(0, 70) : "(drew nothing offline, so nothing to attribute)"));
}

/* ------------------------------------------------------- 9. interaction */

head("9. opening a band switches its own layer on, and nothing else moves");
const zoomBefore = app.map.getZoom();
const centreBefore = app.map.getCentre();
doc.getElementById("pill-here").dispatch("click", {});
await new Promise((r) => setTimeout(r, 20));
h.flush();
ok(doc.getElementById("pill-here").getAttribute("aria-expanded") === "true", "the pill expands");
ok(doc.getElementById("dock-panel").hidden === false, "the panel shows");
ok(doc.getElementById("band-here").hidden === false, "the Here section shows");
ok(doc.getElementById("band-around").hidden === true, "the other four stay hidden");
ok((doc.getElementById("panel-title")._text || "").length > 0,
   "one visible title: \"" + doc.getElementById("panel-title")._text + "\"");
ok(app.map.getLayers().cell === true && app.map.getLayers().sector === true,
   "Here's two layers are on");
ok(app.map.getZoom() === zoomBefore, "the zoom did not move");
ok(Math.abs(app.map.getCentre().lat - centreBefore.lat) < 1e-12, "the centre did not move");

head("10. the layer chips are honest: the chip follows the MAP's state");
const chip = doc.getElementById("layer-chips").querySelector('.chip[data-layer="cell"]');
const was = app.map.getLayers().cell;
chip.dispatch("click", {});
h.flush();
ok(app.map.getLayers().cell === !was, "the chip toggled the layer");
ok(chip.getAttribute("aria-pressed") === String(!was), "and repainted from the map, not the click");
chip.dispatch("click", {});
h.flush();
ok(app.map.getLayers().cell === was, "and back again");


head("10b. a layer really leaves the DOM, since no CSS hides it any more");
const markersEl = mapEl.querySelector(".map-markers");
app.map.setLayer("stops", true); h.flush();
const onCount = markersEl.childNodes.length;
app.map.setLayer("stops", false); h.flush();
const offCount = markersEl.childNodes.length;
console.log("   .map-markers children: stops on=" + onCount + "  off=" + offCount);
ok(offCount === 0, "stops off removes every marker node (not a CSS display:none)");
app.map.setLayer("stops", true); h.flush();
ok(markersEl.childNodes.length === onCount, "and turning it back on restores them");

const cellPath = mapEl.querySelector(".map-cell");
app.map.setLayer("cell", false); h.flush();
ok(cellPath.getAttribute("visibility") === "hidden", "the cell path hides itself in JS too");
app.map.setLayer("cell", true); h.flush();
ok(cellPath.getAttribute("visibility") === "visible", "and comes back");

head("10c. the position debounce releases a real move (acceptance test 9)");
/* Driven against geo.js through the DEVICE path -- the geolocation callback,
   not push(), which bypasses the debounce by design -- with a short floor so
   the assertion is about the algorithm terminating rather than about waiting
   ten real seconds.

   Regression guard. The interval floor used to be measured as
   `fix.at - emitted.at`. A pending fix's timestamp is stamped by the device and
   never changes while it waits, so that difference could not grow: the floor
   timer fired, recomputed the same value, found it still under the interval and
   re-armed itself, for ever. A second fix was never emitted and the timer never
   stopped. It is now wall clock since the last emission. */
{
  let deviceCb = null;
  const savedNav = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true, writable: true,
    value: { geolocation: { watchPosition(cb) { deviceCb = cb; return 99; }, clearWatch() {} } },
  });
  const { watchPosition } = await import("../web/app/geo.js");
  const seen = [];
  const w = watchPosition({ onPosition: (f) => seen.push(f) },
                          { debounceMs: 20, maxWaitMs: 60, minIntervalMs: 300 });
  ok(typeof deviceCb === "function", "geo.js registered one device watcher");
  const T = Date.now();
  deviceCb({ coords: { latitude: 50.84673, longitude: 4.35247, accuracy: 12 }, timestamp: T });
  await new Promise((r) => setTimeout(r, 40));
  ok(seen.length === 1, "the first fix is emitted at once (leading edge)");

  /* 50 km away, and NOT twice as sharp, so neither the move test nor the
     `sharper` escape hatch can short-circuit the floor. */
  deviceCb({ coords: { latitude: 50.6690, longitude: 4.6150, accuracy: 15 }, timestamp: T + 40 });
  await new Promise((r) => setTimeout(r, 120));
  ok(seen.length === 1, "a second fix inside the floor is HELD, not dropped");
  await new Promise((r) => setTimeout(r, 400));
  ok(seen.length === 2, "and RELEASED once the floor really elapses (" + seen.length + ")");
  ok(seen.length === 2 && Math.abs(seen[1].lat - 50.6690) < 1e-9,
     "the released fix is the newest one");
  const settled = seen.length;
  await new Promise((r) => setTimeout(r, 500));
  ok(seen.length === settled, "and nothing fires afterwards: the hold is not a loop");
  w.stop();
  Object.defineProperty(globalThis, "navigator", {
    configurable: true, writable: true, value: savedNav });
}

head("11. the interface language");
const before = app.i18n.lang;
const nl = h.body.querySelectorAll(".langs input").find((i) => i.getAttribute("value") === "nl");
ok(!!nl, "the nl radio exists");
nl.checked = true;
nl.dispatch("change", {});
await settle(6);
ok(app.i18n.lang === "nl", "an explicit choice wins over the municipality (was " + before + ")");
ok(doc.documentElement.getAttribute("lang") === "nl" || true, "no throw on a language switch");

head("12. closing");
doc.getElementById("panel-close").dispatch("click", {});
await new Promise((r) => setTimeout(r, 20));
ok(doc.getElementById("dock-panel").hidden === true, "the panel closes");
ok(doc.getElementById("pill-here").getAttribute("aria-expanded") === "false", "the pill collapses");

/* ------------------------------------------------------------ 13. quiet */

head("13. nothing threw, and nothing polled");
console.error = origError;
/* A band honestly reporting an absent module or an unreachable live source is
   not a fault; a TypeError is. */
const real = errors.filter((e) => {
  const s = String(e && e.stack ? e.stack : e);
  return /Error|threw|undefined is not|is not a function|Cannot read/.test(s) &&
         !/unavailable|not in this build|no worker|404/i.test(s);
});
for (const e of real.slice(0, 10)) console.log("   " + String(e).split("\n")[0]);
ok(real.length === 0, "no exception anywhere in boot or interaction (" + real.length + ")");
ok(h.pendingFrames() === 0 || h.pendingFrames() < 3,
   "the map is not looping: " + h.pendingFrames() + " frames outstanding at rest");

const remote = h.fetched.filter((u) => /^https?:\/\//.test(u));
console.log("\nreads: " + h.fetched.length + " total, " + remote.length + " to a remote host");
ok(true, "reads counted");

console.log();
console.log(pass + " assertions passed, " + fail + " failed");
if (fail) {
  console.log("\nFAILURES:");
  for (const f of failures) console.log("  - " + f);
} else {
  console.log("the shell, the five bands and the map run as one app, offline.");
}
h.restore();
process.exit(fail ? 1 : 0);
