/* BeHERE — application shell and entry module.
 *
 * Plain ES module, loaded directly by the browser. No build step, no bundler,
 * no CDN, no dependency. Everything it imports is a static file in this repo.
 *
 * WHAT THIS FILE OWNS
 *   - the single geolocation watcher, and the context it hands to every band
 *   - the 9-cell read, ordered centre-first, and the position -> NIS spine
 *   - the UI language: municipality default, user override, persistence
 *   - mounting here / around / go / now / zoom into their band bodies
 *   - the source and vintage line under every band (acceptance test 8)
 *   - booting map.js, wiring the dock, and pushing position, geometry, markers
 *     and selection between them and the bands
 *
 * WHAT IT DELIBERATELY DOES NOT OWN
 *   - shard decoding, distance, fetch caching, position debounce .... geo.js
 *   - the label resolver and the language policy .................... i18n.js
 *   - the content of any band ................................ <band>.js
 *   - projection, tiles, vector layers, markers, the dot ............. map.js
 *
 * Everything below is orchestration over geo.js. There is no second decoder and
 * no second resolver in this file: two implementations of one contract is how a
 * bake and a runtime drift apart. The same rule now covers geometry: the map
 * never re-derives which sector you are in, it is TOLD, by here.js, which is
 * the one sector authority in this app (UI_SPEC 1.4).
 *
 * ---------------------------------------------------------------------------
 * THE ONE WATCHER
 * ---------------------------------------------------------------------------
 * here.js states the rule and this file implements it: a band controller does
 * not own geolocation. One watcher belongs to the shell so Here, Around, Go and
 * Now all answer from the same fix.
 *
 * So there is exactly one geo.watchPosition() in the app, started only after a
 * user gesture or an already-granted permission. It is event-driven and
 * trailing-debounced inside geo.js. This file contains no setInterval and no
 * poll of any kind (acceptance test 9).
 *
 * ---------------------------------------------------------------------------
 * THE CENTRE-FIRST READ
 * ---------------------------------------------------------------------------
 * CONTRACT 7.5 measures the worst 9-cell read at 629 KB raw and requires the
 * app to render from the centre cell first, then correct. So a fix produces up
 * to three paints: centre shard, then the municipality files, then all nine
 * cells. Each paint hands the bands a complete context; none of them blocks on
 * the next.
 *
 * ---------------------------------------------------------------------------
 * BAND MODULE INTERFACE
 * ---------------------------------------------------------------------------
 * The nominal contract is:
 *
 *     export function mount(host, ctx) -> { update(ctx) }
 *
 *   host  the band's div[data-role="body"]. The module owns everything inside
 *         it and clears it on its first paint.
 *   ctx   the object built by makeContext() below.
 *
 * The four bands were written in parallel and did not all land on it, so the
 * entry point is probed by name and each band's real signature is reconciled in
 * the BAND_ADAPTER table below, which quotes the declaration it is adapting.
 * Names accepted, in order:
 *
 *     mount, init, createBand, create<Band>Band, render, create, setup, default
 *
 * The returned controller may implement update, setPosition, setLang,
 * setLanguage, setMunicipality, setAddress, fail and destroy. Each is called
 * only when present. A missing module collapses its own band with copy naming
 * what is absent, and never touches the other four.
 *
 * Since the revamp the controller may ALSO implement the map-marker contract
 * the three point bands share (`getMarkers`, `onMarkers`, `select`,
 * `getSelected`, `onSelect`, `getSummary`). Every one of those is optional and
 * probed before it is called, so a band that has not adopted it yet still
 * mounts, still paints and still answers.
 */

import {
  watchPosition,
  readCellsAround, addressesOf, stopsOf, foreignOf, nearest,
  readRootMeta, readMunicipalities, readMunicipalityMeta, readStreets,
  readOverride, dataJSON,
  haversineMetres, formatDistance,
} from "./geo.js";

import { createI18n, resolveLabel } from "./i18n.js";
import { setIcon } from "./icons.js";

/* =====================================================================
 * 0. Constants
 * ===================================================================== */

const BANDS = ["here", "around", "go", "now", "zoom"];

const BAND_MODULE = {
  here: "./here.js",
  around: "./around.js",
  go: "./go.js",
  now: "./now.js",
  zoom: "./zoom.js",
};

const STORE = {
  built: "behere.built",
  departures: "behere.departures",
};

/**
 * How each band wants to be mounted and driven.
 *
 * The four band modules were written in parallel and did not converge on one
 * signature. Reconciling that is the shell's job, and doing it here in one
 * visible table beats bending four finished modules or pretending they agree.
 * Every line below is copied from the module's own declaration:
 *
 *   here.js    mount(host, ctx)                -> { update(ctx) }
 *   around.js  createAroundBand(root, options) -> { update(fixLike), refresh, destroy }
 *   go.js      createGoBand(section, ctx)      -> { setPosition(fix), setLanguage, refresh, destroy }
 *   now.js     createNowBand(section, ctx)     -> { setPosition(fix), setAddress,
 *                                                   setMunicipality, setLanguage, ... }
 *
 * `root`: which element the entry point takes. here.js and around.js own the
 * band BODY and render into it. go.js and now.js take the whole SECTION: they
 * look the body up inside it and they set section[data-state] themselves, which
 * is the attribute the stylesheet keys on.
 *
 * `position`: how a new fix reaches the band. around.js's update() takes an
 * object carrying lat, lon, nis and uiLang together, which is exactly the shape
 * of the context this shell builds, so it and here.js share one call.
 *
 * A band not listed here (zoom.js) falls through to the generic probe in
 * pushPosition().
 */
const BAND_ADAPTER = {
  here: {
    root: "body",
    position: (c, ctx) => c.update(ctx),
  },
  around: {
    root: "body",
    // around.js draws its own <section><h2> so it can also be mounted alone.
    // Inside the shell that would put a second "Around" heading inside the
    // band that already has one, so the shell asks for the body only. Since
    // the revamp the visible title is the panel's single <h2>, which makes
    // this doubly right: there is exactly one heading per open band.
    mountOptions: { chrome: false },
    position: (c, ctx) => c.update(ctx),
  },
  go: {
    root: "section",
    // go.js resolves stop names through <nis>/meta.json lang.default, so the
    // municipality has to reach it. It is null at mount, because the position
    // is not known yet, and go.js exposes no way to hear about it later, so
    // the shell pushes it before every position.
    position: (c, ctx, rec) => {
      // Guard on the OBJECT, not on ctx.nis. The NIS is known one paint before
      // <nis>/meta.json has loaded, so a guard keyed on the NIS pushes null
      // once and then suppresses the real record as "unchanged" forever.
      if (changed(rec, "munty", ctx.muntyMeta) && typeof c.setMunicipality === "function") {
        c.setMunicipality(ctx.muntyMeta);
      }
      c.setPosition(fixOf(ctx));
    },
    lang: (c, lang) => c.setLanguage(lang),
  },
  now: {
    root: "section",
    position: (c, ctx, rec) => {
      // Guard on the OBJECT, not on ctx.nis. The NIS is known one paint before
      // <nis>/meta.json has loaded, so a guard keyed on the NIS pushes null
      // once and then suppresses the real record as "unchanged" forever.
      if (changed(rec, "munty", ctx.muntyMeta) && typeof c.setMunicipality === "function") {
        c.setMunicipality(ctx.muntyMeta);
      }
      const a = ctx.address;
      const key = a ? a.nis + "/" + a.streetId + "/" + a.house + "/" + a.street : "";
      if (changed(rec, "addr", key) && typeof c.setAddress === "function") {
        c.setAddress(a);
      }
      c.setPosition(fixOf(ctx));
    },
    lang: (c, lang) => c.setLanguage(lang),
  },
};

/**
 * True when `value` differs from the last one pushed to this band under `slot`.
 *
 * A single fix produces up to three paints, and now.js and go.js re-run their
 * whole collection on every setter call. Without this guard one position cost
 * nine round trips to the same Opendatasoft dataset, which is exactly the
 * quota burn PLAN section 3 warns about. The shell pushes a setter only when
 * the value behind it actually moved.
 */
function changed(rec, slot, value) {
  if (!rec) return true;
  if (!rec.pushed) rec.pushed = {};
  if (rec.pushed[slot] === value) return false;
  rec.pushed[slot] = value;
  return true;
}

/**
 * The i18n key that names each band.
 *
 * web/data/i18n/*.json calls the fifth band `band.zoomout`, while the DOM id
 * and module name are `zoom`. One table beats a rename in six files, and the
 * question line is the same key with `.q`.
 */
const BAND_KEY = {
  here: "band.here", around: "band.around", go: "band.go",
  now: "band.now", zoom: "band.zoomout",
};

/**
 * Which map layer a band owns (UI_SPEC 3.3, rule 2).
 *
 * Opening a band switches its own layer on, HONESTLY: the chip's aria-pressed
 * flips with it and the reader can switch it straight back off. Nothing is
 * ever force-drawn behind a chip that says "off".
 *
 * Around is deliberately absent. Its markers exist (`around.getMarkers()`) but
 * the map has one marker plane governed by one chip, and that chip is labelled
 * "Stops". Drawing recycling points under it would make the legend lie, and
 * UI_SPEC 3.3 says Around draws nothing until CONTRACT 7.2's baked `p` key
 * ships and earns its own layer.
 */
const BAND_LAYERS = {
  here: ["cell", "sector"],
  around: [],
  go: ["stops"],
  now: [],
  zoom: [],
};

/**
 * The nearest address, with its street NAME attached.
 *
 * A decoded shard row carries `streetId`, not a name: the names live in
 * <nis>/streets.json, keyed by that id. now.js queries the waste-collection
 * calendars by street name, so handing it the raw row would mean it could
 * never find one. The name is resolved through the same four steps as every
 * other label, which for a street always lands on the local official name:
 * street names are never translated (PLAN, CONTRACT 9.3).
 */
function namedAddress() {
  const item = app.nearest ? app.nearest.item : null;
  if (!item) return null;
  const names = app.streets ? app.streets.get(item.streetId) : null;
  const out = Object.assign({}, item, {
    names: names || null,
    street: "",
    distanceM: app.nearest.distanceM,
  });
  if (names) {
    const r = resolveLabel({ id: item.streetId, name: names }, "street",
      app.i18n ? app.i18n.lang : "en",
      { override: app.override,
        regionDefault: app.i18n ? app.i18n.regionDefault : "nl" });
    out.street = r.text;
    out.streetLang = r.lang;
  }
  return out;
}

/** The plain {lat, lon, cell} a band asks for when it does not want a context. */
function fixOf(ctx) {
  return ctx.position
    ? { lat: ctx.position.lat, lon: ctx.position.lon,
        accuracy: ctx.position.accuracy, at: ctx.position.at, cell: ctx.cell }
    : null;
}

/** Last-ditch chrome, only for the band titles the shell itself prints when a
 *  module is missing. Everything else comes from web/data/i18n/<lang>.json. */
const BAND_TITLE = {
  here: "Here", around: "Around", go: "Go", now: "Now", zoom: "Zoom out",
};

/* =====================================================================
 * 1. Helpers
 * ===================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function readStore(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeStore(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Call a band method that may not exist, and never let it take the shell
 *  down. Used everywhere the optional marker contract is probed. */
function ask(controller, method, ...args) {
  if (!controller || typeof controller[method] !== "function") return undefined;
  try {
    return controller[method](...args);
  } catch (err) {
    console.error("BeHERE: " + method + "() failed", err);
    return undefined;
  }
}

/** One grid shard, undecoded.
 *
 *  go.js and around.js read the raw wire format; here.js reads geo.js's decoded
 *  form. Both arrive through geo.js's single-flight cache on the same URL, so
 *  asking for a cell twice costs one request. */
function rawCell(cellId) {
  return dataJSON("grid/" + cellId + ".json")
    .then((r) => (r.ok ? r.data : null))
    .catch(() => null);
}

/* =====================================================================
 * 2. State
 * ===================================================================== */

const app = {
  i18n: null,
  chrome: {},            // {nl?, fr?, en?}, the parsed i18n docs
  override: null,        // en.json, which is also the curated override
  meta: null,            // web/data/meta.json
  municipalities: null,  // web/data/municipalities.json

  position: null,        // {lat, lon, accuracy, at}
  cell: null,            // centre GRD_NEWID
  shards: new Map(),     // cell id -> decoded shard (geo.js shape)
  rawShards: [],         // the same cells, undecoded, centre FIRST
  nearest: null,         // {item, distanceM} from geo.nearest
  nis: null,
  muntyMeta: null,       // web/data/<nis>/meta.json
  streets: null,         // Map<streetId, {nl?, fr?, de?}>
  foreign: null,         // merged `fm`: municipalities in these cells we do not ship

  online: navigator.onLine,
  bands: new Map(),      // id -> {section, host, controller}
  watcher: null,
  fixToken: 0,           // guards against an out-of-order stale read

  // --- the revamp -----------------------------------------------------------
  map: null,             // the map.js handle, or null when it did not load
  toMarkers: null,       // map.js's stopsToMarkers, the no-band-contract path
  here: null,            // the last HereMapState here.js published
  markers: [],           // the last marker set, replayed when the map arrives
  openBand: null,        // which band the dock has expanded, or null
  selected: null,        // the selected marker key, one for the whole app
  pushDock: null,        // re-measure .dock and hand the height to the map
};

/* =====================================================================
 * 3. Chrome strings
 * ===================================================================== */

/** Chrome lookup for the shell's own markup.
 *
 *  The policy lives in i18n.js so the band lookup and the shell lookup cannot
 *  drift, and so scripts/test_i18n_marker.mjs can test the real implementation
 *  rather than a copy of it. i18n.tChrome() falls back to the English already
 *  authored into index.html on a total miss, and marks a string the active
 *  language does not carry (acceptance test 4, second clause). */
function chromeText(key, current) {
  if (!app.i18n) return current;
  return app.i18n.tChrome(key, current);
}

/** The ctx.t() handed to band modules.
 *
 *  here.js treats a returned value equal to the key as a miss and falls back to
 *  its own defaults, so a miss must return the KEY, not "[key]" and not "".
 *  The band modules mark their own defaults; i18n.tBand marks the case where
 *  i18n has the key but not in the active language. */
function bandT(key) {
  if (!app.i18n) return key;
  return app.i18n.tBand(key);
}

/**
 * The Lucide glyphs, drawn once per element from app/icons.js.
 *
 * The markup carries `data-icon="map-pin" data-icon-size="14"` and this fills
 * it in. icons.js builds the svg with createElementNS and parses the path data
 * with DOMParser, so there is no innerHTML anywhere on this path, which is the
 * rule around.js states for the whole app.
 */
function paintIcons(root = document) {
  for (const el of $$("[data-icon]", root)) {
    const name = el.dataset.icon;
    if (!name || el.dataset.iconDrawn === name) continue;
    try {
      setIcon(el, name, Number(el.dataset.iconSize) || 16);
      el.dataset.iconDrawn = name;
    } catch (err) {
      // A missing glyph is a missing decoration, never a missing control:
      // every icon in this shell sits beside a text label or an aria-label.
      console.warn("BeHERE: icon " + name + " unavailable", err);
    }
  }
}

function paintChrome() {
  for (const el of $$("[data-i18n]")) {
    el.textContent = chromeText(el.dataset.i18n, el.textContent);
  }
  const lang = app.i18n ? app.i18n.lang : "en";
  const source = app.i18n ? app.i18n.langSource : "browser";
  document.documentElement.lang = lang;

  // "auto" is checked while the language still follows the ground. Choosing
  // nl/fr/en is an explicit override that persists across a cold start;
  // choosing auto hands the choice back to the municipality (test 5).
  //
  // This is a radio group, so the state is `checked`. The old markup used
  // aria-pressed on four buttons, which is the toggle-button semantic and the
  // wrong one for a single-select: it told a screen reader that all four could
  // be on at once.
  for (const input of $$(".langs input[name=lang]")) {
    const v = input.value;
    input.checked = v === "auto" ? source !== "user" : (source === "user" && v === lang);
    // The visible text is the language TAG. The endonym is the accessible name,
    // and these four keys already ship in all three languages.
    const name = v === "nl" ? chromeText("lang.nl", "Nederlands")
      : v === "fr" ? chromeText("lang.fr", "Français")
        : v === "en" ? chromeText("lang.en", "English")
          : chromeText("lang.auto", "Match where I am");
    input.setAttribute("aria-label", name);
  }

  paintControlLabels();
  paintPills();
}

/**
 * The labels that live on an attribute rather than in a text node.
 *
 * Every one of these keys is asked for with a literal string so
 * scripts/check_i18n.py can see it and gate it in all three languages.
 */
function paintControlLabels() {
  const menu = $("#app-menu");
  if (menu) menu.setAttribute("aria-label", chromeText("menu.open", "BeHERE menu"));

  const close = $("#panel-close");
  if (close) close.setAttribute("aria-label", chromeText("panel.close", "Close"));

  const zin = $("#zoom-in");
  if (zin) zin.setAttribute("aria-label", chromeText("map.zoom.in", "Zoom in"));
  const zout = $("#zoom-out");
  if (zout) zout.setAttribute("aria-label", chromeText("map.zoom.out", "Zoom out"));

  // The chip titles are the legend's own footnotes: which file each stroke was
  // drawn from. The sector one names the municipality whose polygons are
  // loaded, so it is filled per position rather than written into the string.
  const nis = app.nis || (app.muntyMeta && app.muntyMeta.nis) || "";
  const titles = {
    cell: chromeText("map.layer.cell.title",
      "The Statbel GRD_NEWID square, projected with grid.js"),
    sector: chromeText("map.layer.sector.title",
      "2025 statistical sectors, from {nis}/sector.geojson").replace("{nis}", nis || "…"),
    stops: chromeText("map.layer.stops.title",
      "Baked NAP GTFS stops from the loaded shard"),
  };
  for (const chip of $$("#layer-chips .chip")) {
    const t = titles[chip.dataset.layer];
    if (t) chip.title = t;
  }

  if (app.map) app.map.setStrings(mapStrings());
  paintLocateButton();
  paintScale();
}

async function loadChrome() {
  // en.json is both the English chrome file and the curated override, and it is
  // the only source of English anywhere in this app (CONTRACT 8).
  const en = await readOverride();
  if (en.ok && en.data) {
    app.chrome.en = en.data;
    app.override = en.data;
  }
  // NL and FR chrome are optional: CONTRACT 8.3 fixes no filename for them, so
  // a miss is silent and the resolver falls back through i18n.js.
  const rest = await Promise.all(["nl", "fr"].map((l) => dataJSON("i18n/" + l + ".json")));
  ["nl", "fr"].forEach((l, i) => {
    if (rest[i].ok && rest[i].data) app.chrome[l] = rest[i].data;
  });
}

/* =====================================================================
 * 4. The context handed to every band
 * ===================================================================== */

/**
 * @typedef {Object} BeHereContext
 * @property {string}   lang           active UI language, "nl" | "fr" | "en"
 * @property {function} t              chrome string; returns the key on a miss
 * @property {function} label          (entity, kind) -> resolver result
 * @property {function} resolveLabel   CONTRACT 9.1, four steps
 * @property {Object}   override       parsed web/data/i18n/en.json
 * @property {string}   regionDefault  "nl" | "fr" | "de", from the municipality
 * @property {Object}   meta           web/data/meta.json
 * @property {Object}   municipalities web/data/municipalities.json, whole doc
 * @property {?Object}  position       {lat, lon, accuracy, at}
 * @property {?string}  cell           centre GRD_NEWID
 * @property {Map}      shards         cell id -> decoded shard
 * @property {Array}    addresses      every address in the cells read so far
 * @property {Array}    stops          every stop in the cells read so far
 * @property {?Object}  nearest        {item, distanceM}, nearest address
 * @property {?string}  nis            resolved municipality, never from a postcode
 * @property {?Object}  muntyMeta      web/data/<nis>/meta.json
 * @property {?Map}     streets        street id -> {nl?, fr?, de?}
 * @property {?Object}  foreign        merged `fm`: addresses here we do not ship
 * @property {boolean}  online
 * @property {function} distance       (lat, lon) -> metres from the user
 * @property {function} metres         (m) -> localised display string
 * @property {function} setSources     (bandId, ...sourceIds) writes the src line
 * @property {function} rememberDepartures  persists last-known departures
 * @property {function} onHere         here.js's HereMapState sink (UI_SPEC 1.4)
 */
function makeContext(bandId) {
  const shards = Array.from(app.shards.values());
  const lang = app.i18n ? app.i18n.lang : "en";
  const m = app.muntyMeta;

  const ctx = {
    lang,
    t: bandT,
    override: app.override,
    regionDefault: app.i18n ? app.i18n.regionDefault : "nl",
    meta: app.meta,
    municipalities: app.municipalities,

    position: app.position,
    cell: app.cell,
    shards: app.shards,
    addresses: addressesOf(shards),
    stops: stopsOf(shards),
    nearest: app.nearest,
    nis: app.nis,
    muntyMeta: app.muntyMeta,
    streets: app.streets,
    foreign: app.foreign,

    online: app.online,
    metres: (d) => formatDistance(d, lang),
    distance: (lat, lon) => (app.position
      ? haversineMetres(app.position.lat, app.position.lon, lat, lon)
      : NaN),
    setSources,
    rememberDepartures,

    // here.js publishes the frozen HereMapState through this sink AND as a
    // bubbling `behere:here` event. The shell takes the sink because it is
    // synchronous and cannot be missed by a listener attached one tick late.
    onHere: acceptHereState,

    // --- aliases the sibling bands declare under other names ---------------
    // Cheaper and more honest than renaming fields in four finished modules.
    uiLang: lang,
    municipality: m,                                   // go.js, now.js
    address: namedAddress(),                           // now.js
    lat: app.position ? app.position.lat : undefined,  // around.js reads the
    lon: app.position ? app.position.lon : undefined,  // position off the ctx
    rgn: m ? m.rgn : "",
    prov: m ? m.prov : null,
    vintage: (m && m.vintage) || (app.meta && app.meta.vintage) || "2025-01-01",
    loadCell: rawCell,                                 // go.js
  };

  // around.js reads the UNDECODED shard (shard.o, shard.p, shard.fm) because
  // the baked POI key `p` is Phase 2 and not yet pinned in the contract, so it
  // decodes defensively itself. here.js reads geo.js's decoded Map. Both come
  // from the same cached fetch, so this costs nothing.
  if (bandId === "around") ctx.shards = app.rawShards;

  // The bare four-argument resolver of CONTRACT 9.1, passed through unchanged
  // so a caller can ask for a language other than the active one. ctx carries
  // `override` and `regionDefault`, which is exactly the resolver's ctx.
  ctx.resolveLabel = resolveLabel;

  if (app.i18n) {
    ctx.label = (entity, kind) => app.i18n.label(entity, kind);
    ctx.cat = (key) => app.i18n.cat(key);
    // The `cat` group lives in nl.json and fr.json as well as en.json, but
    // ctx.override is en.json ALONE. A band resolving a category through the
    // raw resolver therefore gets nothing under a Dutch or French interface
    // and prints "[playground]". catFull is the bound lookup that reads all
    // three chrome documents, and it returns the full resolver result so the
    // caller can still make its own marker decision (CONTRACT 9.3).
    ctx.catFull = (key) => app.i18n.catFull(key);
  }
  return ctx;
}

/* =====================================================================
 * 5. Bands
 * ===================================================================== */

const ENTRY_NAMES = (id) => [
  "mount", "init", "createBand", "create" + cap(id) + "Band",
  "render", "create", "setup", "default",
];

/** Collapse a band with copy that names what is missing. Never a blank card,
 *  and never error styling: for two of the pilot cities "nothing is published
 *  here" is the correct answer rather than a fault. */
function collapse(host, text) {
  host.textContent = "";
  const p = document.createElement("p");
  p.className = "quiet";
  p.textContent = text;
  host.appendChild(p);
}

/** Acceptance test 8: every layer shows its source and its vintage date.
 *  The band names the source ids; the shell joins them to meta.json.sources so
 *  no other file has to repeat source text (CONTRACT 2). */
function setSources(bandId, ...ids) {
  const rec = app.bands.get(bandId);
  if (!rec) return;
  const el = rec.section.querySelector('[data-role="src"]');
  if (!el) return;

  const list = (app.meta && app.meta.sources) || [];
  const parts = [];
  const seen = new Set();
  for (const id of ids.flat()) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const s = list.find((x) => x && x.id === id);
    if (!s) {
      // A band named a source id that meta.json does not carry. Say so rather
      // than dropping the line: an unattributed layer is worse than an ugly one.
      console.warn("BeHERE: band " + bandId + " named unknown source id " + id);
      continue;
    }
    parts.push(s.title + " (" + s.publisher + "), " +
      (s.vintage === "live" ? "live" : s.vintage));
  }
  // "source.label" is the key the shipped i18n files actually use; asking for
  // "ui.source" printed the key itself in front of every source line.
  el.textContent = parts.length
    ? chromeText("source.label", "Source") + ": " + parts.join(" · ")
    : "";
  el.hidden = !parts.length;
}

async function mountBands() {
  for (const id of BANDS) {
    const section = document.getElementById("band-" + id);
    if (!section) continue;
    const host = section.querySelector('[data-role="body"]');
    const adapter = BAND_ADAPTER[id] || {};
    const rec = { section, host, adapter, controller: null };
    app.bands.set(id, rec);

    const title = () => chromeText(BAND_KEY[id], BAND_TITLE[id]);
    const absent = (why) =>
      chromeText("band.missing", "The {band} band is not part of this build.")
        .replace("{band}", title()) + (why ? " " + why : "");

    let mod = null;
    try {
      mod = await import(BAND_MODULE[id]);
    } catch (err) {
      // Not built yet. Name the band; never take the other four down with it.
      console.warn("BeHERE: " + BAND_MODULE[id] + " unavailable", err);
      collapse(host, absent(""));
      section.dataset.state = "empty";
      continue;
    }

    const name = ENTRY_NAMES(id).find((n) => typeof mod[n] === "function");
    if (!name) {
      console.warn("BeHERE: " + BAND_MODULE[id] + " exports no band entry point");
      collapse(host, absent("It loaded but exports no entry point."));
      section.dataset.state = "error";
      continue;
    }

    try {
      const root = adapter.root === "section" ? section : host;
      const ctx = makeContext(id);
      if (adapter.mountOptions) Object.assign(ctx, adapter.mountOptions);
      const controller = mod[name](root, ctx);
      rec.controller = (controller && typeof controller.then === "function")
        ? await controller
        : controller;
    } catch (err) {
      console.error("BeHERE: band " + id + " failed to mount", err);
      collapse(host, absent("It could not be drawn from the data on this device."));
      section.dataset.state = "error";
    }

    if (rec.controller) bridgeBandToMap(id, rec);
  }
}

function callBand(rec, method, arg) {
  if (!rec.controller || typeof rec.controller[method] !== "function") return;
  try {
    rec.controller[method](arg);
  } catch (err) {
    console.error("BeHERE: band " + method + "() failed", err);
    rec.section.dataset.state = "error";
  }
}

/** Push the current position and context to one band, its own way. */
function pushPosition(id, rec) {
  const c = rec.controller;
  if (!c) return;
  const ctx = makeContext(id);
  if (rec.adapter && rec.adapter.mountOptions) Object.assign(ctx, rec.adapter.mountOptions);
  try {
    if (rec.adapter && typeof rec.adapter.position === "function") {
      rec.adapter.position(c, ctx, rec);
    } else if (typeof c.setPosition === "function") {
      c.setPosition(fixOf(ctx));           // the go.js / now.js convention
    } else if (typeof c.update === "function") {
      c.update(ctx);                       // the here.js / around.js convention
    }
  } catch (err) {
    console.error("BeHERE: band " + id + " rejected the position", err);
    rec.section.dataset.state = "error";
  }
}

/** Tell one band the UI language changed, its own way.
 *  here.js exposes setLang, go.js and now.js setLanguage, around.js neither:
 *  it re-reads uiLang from the context, so it gets a plain refresh. */
function pushLang(id, rec, lang) {
  const c = rec.controller;
  if (!c) return;
  try {
    if (rec.adapter && typeof rec.adapter.lang === "function") rec.adapter.lang(c, lang);
    else if (typeof c.setLang === "function") c.setLang(lang);
    else if (typeof c.setLanguage === "function") c.setLanguage(lang);
    else pushPosition(id, rec);
  } catch (err) {
    console.error("BeHERE: band " + id + " rejected the language", err);
  }
}

/** Hand the current position and context to every mounted band. */
function refreshBands(stateName) {
  for (const [id, rec] of app.bands) {
    if (!rec.controller) continue;
    if (stateName) rec.section.dataset.state = stateName;
    pushPosition(id, rec);
  }
  markersFromShards();
  paintPills();
}

/* =====================================================================
 * 6. Language
 * ===================================================================== */

/** PLAN section 5 / acceptance test 5: the UI language defaults from the
 *  municipality the user is standing in, not the browser locale, and an
 *  explicit choice wins and persists. The policy lives in i18n.js; the shell
 *  only reacts to the outcome. */
function applyMunicipalityLanguage() {
  if (!app.i18n) return;
  const before = app.i18n.lang;
  const after = app.i18n.setMunicipality(app.muntyMeta);
  if (after !== before) {
    paintChrome();
    for (const [id, rec] of app.bands) pushLang(id, rec, after);
  }
}

function setLanguage(lang) {
  if (!app.i18n) return;
  const next = app.i18n.setUiLang(lang);   // "auto" hands it back to the ground
  paintChrome();
  for (const [id, rec] of app.bands) pushLang(id, rec, next);
}

/* =====================================================================
 * 7. Position, and the centre-first 9-cell read
 * ===================================================================== */

function startWatching(userAsked) {
  const status = $("#locate-status");

  if (app.watcher) {
    if (userAsked && app.position) refreshBands();
    return;
  }
  if (!navigator.geolocation) {
    status.textContent = chromeText("here.unavailable",
      "Your device did not return a position.");
    return;
  }
  if (userAsked) {
    status.dataset.i18n = "here.locating";
    status.textContent = chromeText("here.locating", "Finding your position…");
  }

  // ONE watcher for the whole app. geo.watchPosition emits the first fix at
  // once, then debounces on the trailing edge and drops fixes that did not move
  // far enough to change any answer. A stationary device does no work at all.
  app.watcher = watchPosition({
    onPosition(fix) {
      // An accuracy is a number, not a translatable sentence. Dropping the key
      // is what stops paintChrome() overwriting "±12 m" with "Location not
      // requested yet." the next time the reader switches language.
      status.removeAttribute("data-i18n");
      status.textContent = "±" + Math.round(fix.accuracy || 0) + " m";
      onFix(fix).catch((err) => console.error("BeHERE: fix failed", err));
    },
    onError(err) {
      const denied = !!(err && err.kind === "denied");
      status.dataset.i18n = denied ? "here.denied" : "here.unavailable";
      status.textContent = denied
        ? chromeText("here.denied",
            "Location is switched off for this page. Turn it on to answer “where am I”.")
        : chromeText("here.unavailable", "Your device did not return a position.");
      for (const rec of app.bands.values()) callBand(rec, "fail", err);
      paintPills();
    },
  });

  // Desktop testing of the pilot cities without flying to Belgium (PLAN phase
  // 5). Injected through the same debounce as a real device.
  window.behere = Object.assign(window.behere || {}, {
    at: (lat, lon, accuracy) => app.watcher.push(lat, lon, accuracy || 20),
    lang: setLanguage,
    map: () => app.map,
  });
}

/**
 * Resolve one fix into a context, in up to three paints.
 *
 * Every read goes through geo.js, which single-flights and caches, so the eight
 * neighbours are already in flight while the centre paint is drawn.
 */
async function onFix(fix) {
  const token = ++app.fixToken;
  app.position = fix;

  // The dot moves on the FIRST paint, before any shard has landed. "Where am
  // I" is answered by the device, not by the data, and making the dot wait for
  // a 629 KB read would be a lie about which of the two is slow.
  if (app.map) app.map.setPosition(fix);

  const nine = readCellsAround(fix.lat, fix.lon);
  app.cell = nine.cell;
  if (app.map) app.map.setCell(app.cell);
  refreshBands("locating");

  // Paint 1: the centre cell alone answers "where am I".
  const centre = await nine.centre;
  if (token !== app.fixToken) return;
  app.shards = new Map(centre ? [[centre.cell, centre]] : []);
  app.rawShards = (await Promise.all([rawCell(nine.cell)])).filter(Boolean);
  if (token !== app.fixToken) return;
  resolvePlace();
  refreshBands(centre ? "partial" : "locating");

  // Paint 2: the municipality files the centre cell identified.
  await loadMunicipality(token);
  if (token !== app.fixToken) return;
  refreshBands("ready");

  // Paint 3: all nine cells. Only changes the answer within ~50 m of an edge.
  const all = await nine.all;
  if (token !== app.fixToken) return;
  app.shards = new Map(all.map((s) => [s.cell, s]));
  // Same cells, undecoded, centre first. Served from the cache geo.js already
  // filled, so this is not a second round of requests.
  app.rawShards = (await Promise.all(nine.cells.map(rawCell))).filter(Boolean);
  if (token !== app.fixToken) return;
  resolvePlace();
  await loadMunicipality(token);
  if (token !== app.fixToken) return;
  refreshBands("ready");
}

/** Nearest address, and therefore the NIS.
 *
 *  The municipality comes from the address record, never from the postcode:
 *  City of Brussels spans ten postcodes, so a postcode cannot name a
 *  municipality (PLAN trap 2, acceptance test 2). */
function resolvePlace() {
  const shards = Array.from(app.shards.values());
  const addresses = addressesOf(shards);
  app.foreign = foreignOf(shards);

  app.nearest = (app.position && addresses.length)
    ? nearest(app.position.lat, app.position.lon, addresses)
    : null;

  let nis = null;
  if (app.nearest && app.nearest.item && app.nearest.item.nis) {
    nis = app.nearest.item.nis;
  } else if (shards.length === 1 && shards[0].municipalities &&
             shards[0].municipalities.length === 1) {
    // A cell wholly inside one municipality still names it with no address.
    nis = shards[0].municipalities[0];
  }

  // Walking off the edge of the release must CLEAR the municipality, not keep
  // the last one. Leaving it set told a user standing in a field near Tienen
  // that they were in Andenne, sixty kilometres away, and defaulted the
  // interface to that municipality's language on top of it. No answer is the
  // correct answer here, and here.js already has honest copy for it.
  if (nis !== app.nis) {
    app.nis = nis;
    // Drop the old municipality's files on ANY change, not only on leaving the
    // release. go.js and now.js do not re-check that muntyMeta.nis still
    // matches, so carrying Ghent's meta into a Liege paint would resolve
    // Walloon stop names against "nl" for one frame.
    app.muntyMeta = null;
    app.streets = null;
    if (!nis) applyMunicipalityLanguage();
  }
  paintPlaceLabel();
}

async function loadMunicipality(token) {
  const nis = app.nis;
  if (!nis) return;
  if (app.muntyMeta && app.muntyMeta.nis === nis && app.streets) return;

  const [meta, streets] = await Promise.all([
    readMunicipalityMeta(nis),
    readStreets(nis),
  ]);
  if (token !== app.fixToken) return;

  if (meta && meta.ok && meta.data) app.muntyMeta = meta.data;
  app.streets = streets || null;
  applyMunicipalityLanguage();
  paintPlaceLabel();
  paintControlLabels();
}

/* =====================================================================
 * 8. Offline snapshot
 * ===================================================================== */

/** PLAN section 6: the offline fallback serves last-known departures with an
 *  explicit "as of" timestamp. The Go band calls this after every successful
 *  live fetch; offline.html reads it back and always shows the age. */
function rememberDepartures(items, place) {
  if (!Array.isArray(items) || !items.length) return;
  writeStore(STORE.departures, JSON.stringify({
    as_of: new Date().toISOString(),
    place: place || "",
    items: items.slice(0, 12),
  }));
}

/* =====================================================================
 * 8b. Offline readiness
 * ===================================================================== */

/**
 * Ask the service worker how much of the baked data it actually holds.
 *
 * sw.js precaches the whole release at install (631 grid shards, the pilot
 * cities' files and the shared documents), but an install that ran offline, or
 * hit a storage quota, stores less than all of it. PLAN section 11 says a cold
 * start must work with no cache, so the app has to be able to SAY whether it
 * can. This is the only place that claim is made, and it is made from the
 * worker's own cache keys rather than from an assumption.
 *
 * Basemap tiles are NOT part of this number and never will be. They live in
 * their own runtime cache and are never precached, so "stored on this device"
 * stays a claim about baked data only.
 *
 * One message, on demand. No polling (acceptance test 9).
 *
 * @returns {Promise<?{total:number, stored:number, cities:Array, ready:boolean}>}
 */
function askDataStatus(timeoutMs = 4000) {
  return new Promise((resolve) => {
    const sw = navigator.serviceWorker;
    if (!sw || !sw.controller || typeof MessageChannel !== "function") {
      resolve(null);
      return;
    }
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const channel = new MessageChannel();
    channel.port1.onmessage = (e) => done(e.data && e.data.type === "DATA_STATUS" ? e.data : null);
    setTimeout(() => done(null), timeoutMs);
    try {
      sw.controller.postMessage({ type: "DATA_STATUS" }, [channel.port2]);
    } catch (err) {
      done(null);
    }
  });
}

async function paintOfflineReadiness() {
  const el = $("#offline-stored");
  if (!el) return;
  const status = await askDataStatus();
  if (!status || !status.total) {
    // No worker, or no manifest. Say nothing rather than guess: an unproven
    // claim about offline capability is worse than an absent one.
    el.hidden = true;
    return;
  }
  const cities = String((status.cities || []).length || (app.meta && app.meta.municipalities
    ? app.meta.municipalities.length : 0));
  if (status.stored <= 0) {
    el.textContent = chromeText("offline.none",
      "No baked data is stored on this device yet, so Here needs a network for now.");
  } else if (status.ready) {
    el.textContent = chromeText("offline.stored",
      "Stored on this device: all {total} data files of {cities} cities.")
      .replace("{total}", String(status.total)).replace("{cities}", cities);
  } else {
    el.textContent = chromeText("offline.storing",
      "Storing the {cities} cities for offline use: {stored} of {total} files so far.")
      .replace("{stored}", String(status.stored))
      .replace("{total}", String(status.total))
      .replace("{cities}", cities);
    // An incomplete store is worth one retry, not a loop: the worker skips
    // what it already holds, so this is cheap and idempotent.
    try {
      navigator.serviceWorker.controller.postMessage({ type: "WARM_DATA" });
    } catch (err) { /* no controller */ }
  }
  el.hidden = false;
}

/* =====================================================================
 * 9. The menu sheet
 * ===================================================================== */

function paintFooter(meta) {
  $("#foot-vintage").textContent = (meta && meta.vintage) || "—";
  $("#foot-built").textContent = (meta && meta.built) || "—";

  const sources = meta && Array.isArray(meta.sources) ? meta.sources : [];
  $("#sources-count").textContent = sources.length ? String(sources.length) : "";
  if (!sources.length) return;

  const list = $("#sources-list");
  list.textContent = "";
  for (const s of sources) {
    const li = document.createElement("li");

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = s.title + " — " + s.publisher;

    const detail = document.createElement("span");
    detail.className = "sub";
    detail.textContent = (s.vintage === "live" ? "live" : "vintage " + s.vintage) +
      " · retrieved " + s.retrieved + " · " + s.licence +
      " · " + (s.runtime ? "called live" : "baked");

    li.appendChild(name);
    li.appendChild(document.createElement("br"));
    li.appendChild(detail);
    list.appendChild(li);
  }
}

/** The place under the wordmark: the municipality you are standing in.
 *
 *  Resolved through the same four steps as every other label, so it is the
 *  official local name unless web/data/i18n/en.json carries a curated English
 *  one. Nothing here is machine-translated. */
function paintPlaceLabel() {
  const el = $("#brand-place");
  if (!el) return;
  const m = app.muntyMeta;
  if (!m) { el.textContent = ""; el.hidden = true; return; }
  // i18n.municipality() is the override-aware resolver of CONTRACT 9.1, the
  // same one here.js uses. Nothing here is machine-translated: the four steps
  // land on the official local name unless web/data/i18n/en.json carries a
  // curated English one (Brussel -> City of Brussels, and nothing else).
  let name = "";
  if (app.i18n && typeof app.i18n.municipality === "function") {
    try {
      const r = app.i18n.municipality(m.nis, m);
      name = (r && r.text) || "";
    } catch (err) { name = ""; }
  }
  el.textContent = name ? name + " · " + m.nis : String(m.nis || "");
  el.hidden = !el.textContent;
}

function wireSheet() {
  const button = $("#app-menu");
  const sheet = $("#app-sheet");
  if (!button || !sheet) return;

  const setOpen = (open) => {
    sheet.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
  };
  setOpen(false);

  button.addEventListener("click", () => {
    setOpen(sheet.hidden);
    if (!sheet.hidden) {
      const first = sheet.querySelector("input, button, summary, a");
      if (first && typeof first.focus === "function") first.focus();
    }
  });

  // Escape closes it and puts focus back on the control that opened it. The
  // sheet is NOT modal: nothing is trapped and the map keeps drawing.
  sheet.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    setOpen(false);
    button.focus();
  });

  // A click anywhere else closes it. Pointerdown rather than click so a drag
  // that starts on the map closes the sheet before the map begins to pan.
  document.addEventListener("pointerdown", (e) => {
    if (sheet.hidden) return;
    if (sheet.contains(e.target) || button.contains(e.target)) return;
    setOpen(false);
  });
}

/* =====================================================================
 * 10. The map
 * ===================================================================== */

/**
 * Boot map.js.
 *
 * Dynamically imported, exactly like the five band modules, for the same
 * reason: a map that cannot be drawn must not take the answer down with it.
 * With no map the page is the dock over the ground colour, and every question
 * the map answers visually is still answered as text in a band.
 *
 * The container is <body>. map.js reuses the #map, p.map-attrib and
 * p.map-status that index.html already ships, and writes --dock-height onto
 * the container, so passing the body puts that variable where the attribution
 * and the dock can both read it.
 */
async function mountMap() {
  let mod = null;
  try {
    mod = await import("./map.js");
  } catch (err) {
    console.warn("BeHERE: ./map.js unavailable, the bands answer without it", err);
    return;
  }
  if (typeof mod.createMap !== "function") {
    console.warn("BeHERE: ./map.js exports no createMap()");
    return;
  }

  try {
    app.map = mod.createMap(document.body, {
      layers: readChips(),
      // The map is a real, operable control, so it is operable from the
      // keyboard: arrows pan, +/- zoom, Home recentres. map.js does the rest
      // of the work this flag implies -- it drops aria-hidden from #map and
      // makes it a labelled group with ONE tab stop, because a focusable node
      // inside an aria-hidden subtree is an authoring error. Tab is never
      // intercepted, so the single stop cannot become a trap, and the map
      // still answers nothing that a band does not also answer as text.
      keyboard: true,
      strings: mapStrings(),
    });
  } catch (err) {
    console.error("BeHERE: the map could not be mounted", err);
    return;
  }
  app.toMarkers = typeof mod.stopsToMarkers === "function" ? mod.stopsToMarkers : null;

  wireMapChrome();

  // Anything that arrived before the map did. The bands mount before this,
  // because a band is the answer and the map is the answer drawn.
  if (app.position) app.map.setPosition(app.position);
  if (app.cell) app.map.setCell(app.cell);
  if (app.here) applyHereToMap(app.here);
  if (app.markers.length) pushMarkers(app.markers);
  if (app.pushDock) app.pushDock();
  if (app.openBand) onBandOpened(app.openBand);
}

/**
 * The two strings map.js resolves, built once so mount and re-translate can
 * never drift apart.
 *
 * `label` is the accessible name of the map group AND, because the group is a
 * tab stop that answers to keys with no visible affordance, it carries the key
 * hint. WCAG 3.3.2: a control whose operation is not self-evident says how it
 * is operated. It is one string rather than an aria-describedby target because
 * a description on a group is announced inconsistently, and because a hidden
 * paragraph inside the group would be read as the group's content.
 */
function mapStrings() {
  const label = chromeText("map.label", "Map of where you are");
  const hint = chromeText("map.keys",
    "Arrow keys pan, plus and minus zoom, Home returns to where you are.");
  return {
    status: chromeText("map.status",
      "Map at {m} m per 100 pixels, centred on your position."),
    label: hint ? label + ". " + hint : label,
  };
}

/** The chips' current pressed state, read as map.js's {cell, sector, stops}. */
function readChips() {
  const out = {};
  for (const chip of $$("#layer-chips .chip")) {
    out[chip.dataset.layer] = chip.getAttribute("aria-pressed") !== "false";
  }
  return out;
}

function paintChips(layers) {
  for (const chip of $$("#layer-chips .chip")) {
    const on = !!layers[chip.dataset.layer];
    chip.setAttribute("aria-pressed", String(on));
  }
}

/** The scale readout: metres of ground per 100 screen pixels. */
function paintScale(mpp) {
  const el = $("#map-scale");
  if (!el) return;
  const value = typeof mpp === "number"
    ? mpp
    : (app.map ? app.map.metresPerPixel() : NaN);
  if (!isFinite(value)) { el.textContent = ""; el.removeAttribute("aria-label"); return; }
  const m = Math.round(value * 100);
  el.textContent = m + " m";
  el.setAttribute("aria-label",
    chromeText("map.scale", "{m} m per 100 pixels").replace("{m}", String(m)));
}

/**
 * The locate button has two jobs and says which one it is doing.
 *
 * Before a fix it asks for one. After a fix, once the reader has panned away,
 * it offers to come back. When there is a fix and the map is already centred
 * on it, the button has nothing to do and is hidden rather than left there
 * pretending.
 */
function paintLocateButton(offCentre) {
  const button = $("#locate");
  if (!button) return;
  const label = button.querySelector(".btn__label") || button;
  const away = offCentre === undefined
    ? (app.map ? app.map.isOffCentre() : false)
    : !!offCentre;

  if (!app.position) {
    label.dataset.i18n = "locate.action";
    label.textContent = chromeText("locate.action", "Find where I am");
    button.hidden = false;
    return;
  }
  label.dataset.i18n = "map.recentre";
  label.textContent = chromeText("map.recentre", "Back to where I am");
  // With no map there is nothing to recentre, so the button keeps its first
  // job rather than offering a second one it cannot do.
  button.hidden = !!app.map && !away;
}

function paintTileNote(state) {
  const el = $("#tile-note");
  if (!el) return;
  const live = state === "live";
  el.dataset.state = state || "off";
  el.dataset.i18n = live ? "map.tiles.live" : "map.tiles.none";
  el.textContent = live
    ? chromeText("map.tiles.live", "Tiles: openstreetmap.org · live")
    : chromeText("map.tiles.none",
        "No tiles. Everything drawn is baked on this device.");
}

function wireMapChrome() {
  const map = app.map;
  if (!map) return;

  map.on("move", (e) => {
    paintScale(e.metresPerPixel);
    paintLocateButton(e.offCentre);
  });
  map.on("zoom", (e) => {
    const out = $("#zoom-out");
    const zin = $("#zoom-in");
    if (out) out.disabled = e.zoom <= e.min;
    if (zin) zin.disabled = e.zoom >= e.max;
  });
  map.on("tiles", (e) => paintTileNote(e.state));
  map.on("layers", (e) => paintChips(e));
  map.on("select", (e) => {
    if (e.source === "api") return;      // we asked for it; do not echo it back
    selectKey(e.key, "map");
  });

  const out = $("#zoom-out");
  if (out) out.addEventListener("click", () => map.zoomBy(-1));
  const zin = $("#zoom-in");
  if (zin) zin.addEventListener("click", () => map.zoomBy(1));

  for (const chip of $$("#layer-chips .chip")) {
    chip.addEventListener("click", () => {
      const on = chip.getAttribute("aria-pressed") !== "false";
      map.setLayer(chip.dataset.layer, !on);
      // map.js only emits "layers" when the value really changed, so the chip
      // is repainted from the map's own state rather than from the click.
      paintChips(map.getLayers());
    });
  }

  paintChips(map.getLayers());
  paintTileNote(map.getTileState());
  paintScale();
  paintLocateButton();
}

/**
 * here.js's HereMapState, the one authority on which sector you are standing
 * in (UI_SPEC 1.4). The map is told; it never re-derives.
 */
function acceptHereState(state) {
  // The same frozen object arrives twice per publish, once through ctx.onHere
  // and once as the bubbling `behere:here` event. Identity is the exact test:
  // here.js already dedupes by signature before it publishes at all, so two
  // different objects really are two different answers.
  if (!state || state === app.here) return;
  app.here = state;
  applyHereToMap(state);
  paintPills();
}

function applyHereToMap(state) {
  if (!app.map) return;
  app.map.setCell(state.cell || app.cell || null);
  app.map.setSectors(state.sectors || null, state.sector || null);
  if (state.position) app.map.setPosition(state.position);
}

/* =====================================================================
 * 10b. Markers and selection
 * ===================================================================== */

/**
 * Wire one band's optional map-marker contract.
 *
 * Only Go feeds the marker plane today. The `stops` chip is the plane's
 * legend, and a legend that says "Stops" over a recycling park is a lie, so
 * Around's markers stay in its own list until CONTRACT 7.2's baked `p` key
 * earns them a chip of their own (UI_SPEC 3.3).
 *
 * Selection is bidirectional but never circular: a tap on the map calls
 * `select(key, {silent: true})` on the band, and a tap on a card calls
 * `map.select(key)`, whose "select" event carries `source: "api"` and is
 * dropped by the listener above.
 */
function bridgeBandToMap(id, rec) {
  const c = rec.controller;

  if (typeof c.onMarkers === "function") {
    ask(c, "onMarkers", (markers) => {
      if (id === "go") pushMarkers(markers);
      paintPills();
    });
  }
  if (typeof c.onSelect === "function") {
    ask(c, "onSelect", (key) => selectKey(key, id));
  }
}

/**
 * The Go band's boarding points become the marker plane.
 *
 * The map does NOT re-read a shard, re-group platforms or re-sort: go.js's
 * `groupStops` already decided which places to stand there are and in what
 * order, and re-deriving that in map.js would be a second opinion about the
 * same fact. Every marker therefore has a card in the panel, in the same
 * order, which is what makes the panel the marker's keyboard equivalent.
 */
function pushMarkers(markers) {
  app.markers = Array.isArray(markers) ? markers : [];
  if (!app.map) return;   // replayed by mountMap() when it arrives
  app.map.setMarkers(app.markers.map((m) => ({
    key: m.key,
    lat: m.lat,
    lon: m.lon,
    label: m.label || "",
    operator: m.op || m.operator || "",
    kind: m.kind || "stops",
  })));
}

/**
 * The fallback for a build whose Go band has not adopted the marker contract.
 *
 * It reads the same decoded stops the band reads, through map.js's own
 * `stopsToMarkers`, which groups platforms by `ps` exactly as `groupStops`
 * does. It runs ONLY when the band publishes nothing, so the two can never
 * both be drawing: there is still one authority per fact, it is just a
 * different one when the first is absent.
 */
function markersFromShards() {
  if (!app.map || !app.toMarkers) return;
  const rec = app.bands.get("go");
  if (rec && rec.controller && typeof rec.controller.onMarkers === "function") return;
  try {
    app.map.setMarkers(app.toMarkers(stopsOf(Array.from(app.shards.values()))));
  } catch (err) {
    console.warn("BeHERE: could not derive stop markers", err);
  }
}

/**
 * One selected key for the whole app.
 *
 * `origin` is who said so, and it is what stops the echo: the band that raised
 * it is not told again, and the map is only told when the reader picked in a
 * panel rather than on the ground.
 */
function selectKey(key, origin) {
  const next = key === undefined || key === null ? null : String(key);
  if (next === app.selected) return;
  app.selected = next;

  for (const [id, rec] of app.bands) {
    if (id === origin) continue;
    // `scroll` brings the card into view in the panel, `silent` stops the
    // band re-announcing a selection it did not make (UI_SPEC 3.3, rule 3).
    ask(rec.controller, "select", next, { scroll: true, silent: true });
  }
  if (origin !== "map" && app.map) app.map.select(next);

  // Picking a stop on the ground opens the band that can name it.
  if (origin === "map" && next && app.openBand !== "go") openBand("go");
}

/* =====================================================================
 * 11. The dock: pills, panel, and what the map does when one opens
 * ===================================================================== */

/**
 * The dock: expanding, collapsing, the roving tabindex and focus.
 *
 * This lives HERE rather than in a dock.js of its own. During the revamp the
 * dock was planned as a sixth chrome module and this function dynamically
 * imported "./dock.js", falling back to an inline implementation when the file
 * was absent. The file was never written, the inline implementation is the
 * whole behaviour, and an import of a module that does not exist is a
 * guaranteed 404 and a console error on every cold boot -- paid on every load,
 * forever, to reach a `catch` that runs the code directly below it.
 *
 * So the fallback IS the implementation and the probe is gone. The division of
 * labour the probe existed to allow is preserved inside this file: wireDock()
 * writes `aria-expanded`, `hidden` and `tabindex` and nothing else, and
 * paintPills() writes `.pill__count` and `.pill__state[data-state]` and nothing
 * else. Those two never touch the same attribute, so splitting them back out
 * into a module later is a move, not a rewrite.
 *
 * watchPillState() still observes `aria-expanded` rather than listening for a
 * click, so whoever opens a band -- this file, a future dock.js, or a test
 * driving the DOM directly -- is reacted to identically.
 */
function mountDock() {
  wireDock();
  watchPillState();
  watchDockHeight();
}

/** Which section belongs to which pill, straight off aria-controls. */
function pillOf(id) { return $("#pill-" + id); }
function sectionOf(id) { return document.getElementById("band-" + id); }

function openBand(id) {
  applyOpen(id);
}

/** The whole disclosure behaviour. See mountDock() for why it lives here. */
function wireDock() {
  const pills = $$("#dock-pills .pill");
  if (!pills.length) return;

  for (const pill of pills) {
    pill.addEventListener("click", () => {
      const id = pill.dataset.band;
      applyOpen(app.openBand === id ? null : id);
    });
  }

  // ONE tab stop for the row, arrow keys within it. This is the disclosure
  // pattern rather than the tabs pattern, because "no panel at all" is a real
  // state here and the tabs pattern has no name for it (UI_SPEC 3.6).
  const row = $("#dock-pills");
  row.addEventListener("keydown", (e) => {
    const i = pills.indexOf(document.activeElement);
    if (i < 0) return;
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % pills.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + pills.length) % pills.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = pills.length - 1;
    if (next < 0) return;
    e.preventDefault();
    rovePillFocus(pills[next]);
    pills[next].focus();
    if (typeof pills[next].scrollIntoView === "function") {
      pills[next].scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  });

  const close = $("#panel-close");
  if (close) close.addEventListener("click", () => applyOpen(null));

  const panel = $("#dock-panel");
  if (panel) {
    panel.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const open = app.openBand;
      applyOpen(null);
      const pill = open ? pillOf(open) : null;
      if (pill) pill.focus();
    });
  }

  applyOpen(null);
}

function rovePillFocus(active) {
  for (const pill of $$("#dock-pills .pill")) {
    pill.tabIndex = pill === active ? 0 : -1;
  }
}

function applyOpen(id) {
  const panel = $("#dock-panel");
  const pills = $$("#dock-pills .pill");
  app.openBand = id || null;

  for (const pill of pills) {
    pill.setAttribute("aria-expanded", String(pill.dataset.band === app.openBand));
  }
  for (const band of BANDS) {
    const section = sectionOf(band);
    if (section) section.hidden = band !== app.openBand;
  }
  if (panel) panel.hidden = !app.openBand;

  const kicker = $("#panel-kicker");
  const title = $("#panel-title");
  if (app.openBand) {
    if (title) title.textContent = chromeText(BAND_KEY[app.openBand], BAND_TITLE[app.openBand]);
    if (kicker) kicker.textContent = chromeText(BAND_KEY[app.openBand] + ".q", "");
  }

  rovePillFocus(app.openBand ? pillOf(app.openBand) : pills[0]);
  if (app.openBand) {
    const section = sectionOf(app.openBand);
    // Focus lands on the section, not on the first control inside it, so the
    // next Tab reaches the content instead of jumping back to the top of the
    // page (UI_SPEC 3.6).
    if (section && typeof section.focus === "function") section.focus();
  }
  onBandOpened(app.openBand);
}

/**
 * Whoever flipped `aria-expanded` — wireDock() here, a future dock.js, or a
 * test driving the DOM — this is what
 * reacts to it. A MutationObserver rather than a click handler, so the two
 * implementations need no shared convention beyond the ARIA attribute they
 * both have to set anyway.
 */
function watchPillState() {
  const pills = $$("#dock-pills .pill");
  if (!pills.length || typeof MutationObserver !== "function") return;
  const ob = new MutationObserver(() => {
    const open = pills.find((p) => p.getAttribute("aria-expanded") === "true");
    const id = open ? open.dataset.band : null;
    if (id === app.openBand) return;
    app.openBand = id;
    onBandOpened(id);
  });
  for (const pill of pills) {
    ob.observe(pill, { attributes: true, attributeFilter: ["aria-expanded"] });
  }
}

/**
 * UI_SPEC 3.3: opening a band switches its own layer on, and nothing else.
 * No zoom change, no re-request of tiles, no move of the centre.
 */
function onBandOpened(id) {
  if (!app.map || !id) return;
  for (const name of BAND_LAYERS[id] || []) app.map.setLayer(name, true);
  paintChips(app.map.getLayers());
}

/**
 * --dock-height: how much of the map the dock covers.
 *
 * The map reads it to lift its optical centre, and the attribution reads it to
 * sit above the dock. Without it, opening a band on a phone puts the panel
 * over the position dot, which is the one thing a "where am I" app must never
 * do.
 */
function watchDockHeight() {
  const dock = $("#dock");
  if (!dock) return;
  const push = () => {
    const h = Math.round(dock.getBoundingClientRect().height);
    // app.css declares --dock-height on :root and reads it from .map-attrib,
    // which sits OUTSIDE the dock, so the variable has to live on the root
    // element rather than on .dock itself.
    document.documentElement.style.setProperty("--dock-height", h + "px");
    if (app.map) app.map.setDockHeight(h);
  };
  app.pushDock = push;
  if (typeof ResizeObserver === "function") new ResizeObserver(push).observe(dock);
  else window.addEventListener("resize", push);
  push();
}

/* =====================================================================
 * 11b. What each pill says
 * ===================================================================== */

/**
 * The pill count is words, never a colour.
 *
 * `.pill__state` is a 10 px dot and it is reinforcement only: the same fact is
 * written out beside it, so the state survives a monochrome rendering and a
 * reader who cannot tell sage from terracotta.
 *
 * Three ways to have nothing to say, and only the third is a fault
 * (UI_SPEC 2.5). All three take the hollow dot; the difference is the note the
 * band itself writes, and it is the band that knows which one it is.
 */
function pillModel(id) {
  const rec = app.bands.get(id);
  const c = rec ? rec.controller : null;
  const summary = ask(c, "getSummary") || null;
  const count = summary && typeof summary.count === "number" ? summary.count : null;

  if (!app.position) {
    return { state: "idle", text: chromeText("pill.idle", "waiting for a position") };
  }

  const none = () => ({ state: "nothing", text: chromeText("pill.none", "nothing baked") });

  if (id === "here") {
    const h = app.here;
    if (h && h.sector) return { state: "answers", text: String(h.sector) };
    if (app.nis) {
      return { state: "answers",
        text: chromeText("pill.here.nis", "NIS {nis}").replace("{nis}", app.nis) };
    }
    return none();
  }

  if (id === "zoom") {
    const n3 = app.muntyMeta && app.muntyMeta.nuts3;
    if (!n3) return none();
    return { state: "answers", text: chromeText("pill.zoom", "{nuts3}").replace("{nuts3}", n3) };
  }

  if (id === "around") {
    if (count === null) return { state: "idle", text: "" };
    if (!count) return none();
    return { state: "answers",
      text: (count === 1
        ? chromeText("pill.around.one", "{n} dataset")
        : chromeText("pill.around", "{n} datasets")).replace("{n}", String(count)) };
  }

  if (id === "go") {
    if (count === null) return { state: "idle", text: "" };
    if (!count) return none();
    return { state: "answers",
      text: chromeText("pill.go", "{n} stops here").replace("{n}", String(count)) };
  }

  // now
  if (count === null) return { state: "idle", text: "" };
  if (!count) return { state: "nothing", text: chromeText("pill.now.none", "none published") };
  return { state: "answers",
    text: (count === 1
      ? chromeText("pill.now.one", "{n} calendar")
      : chromeText("pill.now", "{n} calendars")).replace("{n}", String(count)) };
}

function paintPills() {
  for (const id of BANDS) {
    const pill = pillOf(id);
    if (!pill) continue;
    const model = pillModel(id);
    const dot = pill.querySelector(".pill__state");
    const count = pill.querySelector(".pill__count");
    if (dot) dot.dataset.state = model.state;
    if (count) count.textContent = model.text;
  }
}

/* =====================================================================
 * 12. Boot
 * ===================================================================== */

async function boot() {
  paintIcons();
  wireChrome();
  wireSheet();

  await loadChrome();
  app.i18n = createI18n({
    chrome: app.chrome,
    override: app.override,
    navLangs: navigator.languages || [navigator.language],
  });
  paintChrome();

  // municipalities.json and meta.json are the two files every band needs before
  // it can name anything, so they are read before the bands mount.
  const [meta, munis] = await Promise.all([readRootMeta(), readMunicipalities()]);
  if (meta.ok && meta.data) {
    app.meta = meta.data;
    paintFooter(meta.data);
    const built = meta.data.built || "";
    if (readStore(STORE.built) && readStore(STORE.built) !== built) {
      // A new data vintage was published. Drop the shard cache rather than
      // serve last month's city from it forever.
      navigator.serviceWorker && navigator.serviceWorker.controller &&
        navigator.serviceWorker.controller.postMessage({ type: "PURGE_DATA" });
    }
    writeStore(STORE.built, built);
  } else {
    $("#foot-built").textContent = "unavailable";
  }
  if (munis.ok && munis.data) app.municipalities = munis.data;

  await mountBands();

  // The bands first, then the dock that shows them, then the map that draws
  // them. That order is the app's whole thesis: the band is the answer, the
  // map is the answer drawn, and if the two ever disagree the text is the one
  // that has to be right.
  mountDock();
  await mountMap();
  paintPills();

  // Resolve silently when permission was granted on an earlier visit, so a
  // returning user does not have to press anything.
  if (navigator.permissions && navigator.permissions.query) {
    try {
      const p = await navigator.permissions.query({ name: "geolocation" });
      if (p.state === "granted") startWatching(false);
    } catch { /* older Safari has no geolocation permission name */ }
  }

  maybeShowIosHint();

  // Last, and never awaited by anything above it: an unreachable worker must
  // not delay the bands.
  paintOfflineReadiness().catch(() => { /* no worker, no claim */ });
}

function wireChrome() {
  $("#locate").addEventListener("click", () => {
    // One button, two jobs, and never both at once: with no fix it asks for
    // one; with a fix it comes back to it (UI_SPEC 3.4).
    if (app.position && app.map) app.map.recentre();
    else startWatching(true);
  });

  for (const input of $$(".langs input[name=lang]")) {
    input.addEventListener("change", () => {
      if (input.checked) setLanguage(input.value);
    });
  }

  // here.js publishes its map state through ctx.onHere AND as a bubbling
  // event, so a band mounted outside this shell can still drive a map. Both
  // land on the same handler, and the handler is idempotent.
  document.addEventListener("behere:here", (e) => acceptHereState(e.detail));

  const bar = $("#offline-bar");
  const paintOnline = () => {
    app.online = navigator.onLine;
    bar.hidden = app.online;
    refreshBands();
  };
  window.addEventListener("online", paintOnline);
  window.addEventListener("offline", paintOnline);
  bar.hidden = navigator.onLine;
}

function maybeShowIosHint() {
  const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia("(display-mode: standalone)").matches ||
    navigator.standalone === true;
  // iOS has no beforeinstallprompt, so this hint is the only install path.
  if (iOS && !standalone) $("#ios-hint").hidden = false;
}

boot().catch((err) => {
  console.error("BeHERE: boot failed", err);
  const status = $("#locate-status");
  if (status) status.textContent = "BeHERE could not load its data manifest.";
});

export { app, makeContext, setLanguage, startWatching, rememberDepartures };
