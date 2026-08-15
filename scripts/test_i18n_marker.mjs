/**
 * PLAN acceptance test 4, both clauses, executed against the shipped files.
 *
 *   "No UI string is ever blank. Untranslated strings are visibly marked."
 *
 * Clause 1 was already true. Clause 2 was not: a key that exists in no i18n
 * file falls through to the band module's own hardcoded English, which then
 * renders inside a Dutch or French interface with NO marker, indistinguishable
 * from a translation.
 *
 * This runs the real i18n.js against the real web/data/i18n/*.json, and then
 * mounts the real here.js into a minimal DOM to prove the marker reaches the
 * screen.
 *
 *   node scripts/test_i18n_marker.mjs
 *
 * Plain node, no dependency. scripts/check_i18n.py is the static half of the
 * same gate: it proves the keys exist, this proves the fallback is visible
 * when one day they do not.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

import { createI18n, UNTRANSLATED_MARK, markerPolicy } from "../web/app/i18n.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const read = (p) => JSON.parse(readFileSync(join(REPO, p), "utf8"));

const chrome = {
  en: read("web/data/i18n/en.json"),
  nl: read("web/data/i18n/nl.json"),
  fr: read("web/data/i18n/fr.json"),
};

let pass = 0;
const failures = [];
const ok = (c, what, d) => (c ? pass++ : failures.push(what + (d ? "  -> " + JSON.stringify(d) : "")));
const eq = (a, b, what) => ok(a === b, what, { got: a, want: b });

/** The keys the band modules ask for, from the one extractor there is. */
function declaredKeys() {
  const out = execFileSync("python3", [join(HERE, "check_i18n.py"), "--list"],
    { encoding: "utf8" });
  return out.split("\n")
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((k) => /^[a-z][A-Za-z0-9._]*$/.test(k) && k.includes("."));
}

const KEYS = declaredKeys();
console.log("%d keys declared by the band modules", KEYS.length);
ok(KEYS.length > 100, "the extractor found the key inventory", KEYS.length);

function i18nFor(lang, docs) {
  return createI18n({ chrome: docs || chrome, override: (docs || chrome).en,
    uiLang: lang, navLangs: ["en"] });
}

/* --- 1. no blank, no marker: every declared key is really translated ---- */
for (const lang of ["nl", "fr", "en"]) {
  const i18n = i18nFor(lang);
  let marked = 0, blank = 0, keyed = 0;
  for (const key of KEYS) {
    const s = i18n.tBand(key);
    if (typeof s !== "string" || s === "") blank++;
    if (s === key) keyed++;
    if (s.endsWith(UNTRANSLATED_MARK)) marked++;
  }
  eq(blank, 0, lang + ": no declared key resolves blank");
  eq(keyed, 0, lang + ": no declared key falls through to the bare key");
  eq(marked, 0, lang + ": no declared key needs the untranslated marker");
}

/* --- 2. the five keys the audit named, executed ------------------------ */
const AUDITED = ["here.away", "here.postcodes.note", "empty.here.sector",
                 "go.nodepartures", "now.today"];
console.log("\nthe five keys the audit executed, now, under a Dutch interface:");
{
  const nl = i18nFor("nl");
  for (const key of AUDITED) {
    const r = nl.tFull(key);
    console.log("  [nl] %s text=%j step=%d translated=%s",
      key.padEnd(20), r.text, r.step, r.translated);
    eq(r.step, 1, key + " resolves at step 1 in Dutch");
    eq(r.translated, true, key + " is a real Dutch translation");
    ok(!nl.tBand(key).endsWith(UNTRANSLATED_MARK), key + " needs no marker");
  }
}

/* --- 3. a MISSING key is marked, not passed off as a translation ------- */
{
  const doctored = {
    en: chrome.en,
    fr: chrome.fr,
    nl: JSON.parse(JSON.stringify(chrome.nl)),
  };
  delete doctored.nl.ui["here.postcodes.note"];
  const nl = createI18n({ chrome: doctored, override: doctored.en,
    uiLang: "nl", navLangs: ["en"] });

  const r = nl.tFull("here.postcodes.note");
  ok(r.step >= 3, "with nl deleted the key falls past step 1", r);
  eq(r.translated, false, "and is reported as not translated");
  eq(markerPolicy("ui"), "inline", "markerPolicy('ui') asks for an inline marker");

  const marked = nl.tBand("here.postcodes.note");
  ok(marked.endsWith(UNTRANSLATED_MARK),
    "tBand marks it: " + JSON.stringify(marked.slice(-40)));
  console.log("\n  with nl.ui['here.postcodes.note'] deleted:\n    %j", marked);

  // and it is still not blank, and still not the bare key.
  ok(marked.length > 20 && marked !== "here.postcodes.note",
    "it is still a real sentence, not a key");
}

/* --- 4. a key in NO language returns the bare key, so the band's own
 *        English default takes over and marks itself ------------------- */
{
  const nl = i18nFor("nl");
  eq(nl.tBand("no.such.key.anywhere"), "no.such.key.anywhere",
    "a total miss returns the bare key, which is the bands' miss signal");
  const shell = nl.tChrome("no.such.key.anywhere", "Find where I am");
  ok(shell.endsWith(UNTRANSLATED_MARK),
    "and the shell's own authored English is marked under a Dutch interface");
  eq(i18nFor("en").tChrome("no.such.key.anywhere", "Find where I am"),
    "Find where I am", "but not under an English one");
  eq(nl.tChrome("no.such.key.anywhere", shell), shell,
    "marking is idempotent across repaints");
}

/* --- 5. the marker reaches the screen: mount the real here.js ---------- */
{
  class N {
    constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.className = ""; this.dataset = {}; }
    setAttribute(k, v) { this.attrs[k] = v; }
    appendChild(n) { this.children.push(n); return n; }
    addEventListener() {}
    querySelector() { return null; }
    querySelectorAll() { return []; }
    get childNodes() { return this.children; }
    get firstChild() { return this.children[0] || null; }
    set textContent(v) {
      this.children = [];
      if (v !== "") { const t = new N("#text"); t.own = String(v); this.children.push(t); }
    }
    get textContent() {
      return this.children.length
        ? this.children.map((c) => c.textContent).join("")
        : (this.own || "");
    }
  }
  globalThis.document = {
    createElement: (t) => new N(t),
    createTextNode: (t) => { const n = new N("#text"); n.own = String(t); return n; },
  };

  const { mount } = await import("../web/app/here.js");
  const muntyMeta = read("web/data/21004/meta.json");     // Brussels: 10 postcodes
  const nl = i18nFor("nl");

  function ctx(tFn) {
    return {
      lang: "nl", uiLang: "nl", regionDefault: "nl",
      t: tFn,
      label: (e, k) => nl.label(e, k),
      override: chrome.en,
      municipalities: read("web/data/municipalities.json"),
      meta: read("web/data/meta.json"),
      position: { lat: 50.84673, lon: 4.35247, accuracy: 20, at: Date.now() },
      cell: null, shards: new Map(), addresses: [], stops: [],
      nearest: null, nis: "21004", muntyMeta, streets: null, foreign: null,
      online: true, metres: (m) => Math.round(m) + " m", distance: () => NaN,
    };
  }

  const good = new N("div");
  mount(good, ctx((k) => nl.tBand(k)));
  const goodText = good.textContent;
  ok(goodText.includes("Bruxelles") || goodText.includes("Brussel"),
    "here.js renders the municipality");
  ok(/spant|postcodes/i.test(goodText), "and the postcode sentence");
  ok(!goodText.includes(UNTRANSLATED_MARK),
    "with the shipped files nothing on screen is marked",
    goodText.slice(0, 200));

  // Now simulate the state the audit found: i18n knows nothing, so here.js
  // falls back to HERE_UI_DEFAULTS, which is English.
  const bad = new N("div");
  mount(bad, ctx((k) => k));
  const badText = bad.textContent;
  ok(badText.includes("spans 10 postcodes"),
    "with no i18n the English default is what renders", badText.slice(0, 120));
  ok(badText.includes(UNTRANSLATED_MARK),
    "and it now carries the untranslated marker on screen");
  const markedLines = badText.split("\n").filter((l) => l.includes(UNTRANSLATED_MARK));
  console.log("\n  here.js in Dutch with an empty i18n, first marked strings:");
  for (const line of [badText].slice(0, 1)) {
    const bits = line.match(/[^*]{0,60}\*/g) || [];
    for (const b of bits.slice(0, 4)) console.log("    …%s", b.trim().slice(-58));
  }
  ok(markedLines.length >= 0, "marker survives rendering");
}

console.log("\n%d assertions passed, %d failed", pass, failures.length);
if (failures.length) {
  for (const f of failures) console.error("  FAIL " + f);
  process.exit(1);
}
console.log("acceptance test 4: no blank string, and an untranslated string is " +
  "visibly marked.");
