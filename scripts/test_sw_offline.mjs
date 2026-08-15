/**
 * The cold-cache, airplane-mode test. PLAN acceptance test 1.
 *
 *   "Cold start, airplane mode, in each of the 7 cities: Here resolves to an
 *    address, sector and municipality."
 *
 * This runs web/sw.js for real, in a Node sandbox with a minimal CacheStorage
 * and a fetch backed by the files on disk, and then CUTS THE NETWORK and
 * resolves every pilot city out of the cache alone, using the shipped
 * geo.js decoder and here.js's own sector logic.
 *
 * Nothing is stubbed on the BeHERE side: sw.js, geo.js decodeShard, nearest,
 * findSectorAt and grid.js are the shipped files, imported unmodified.
 *
 *   node scripts/test_sw_offline.mjs
 *
 * Exits 1 on any failure. Plain node, no dependency.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

import {
  decodeShard, nearest, findSectorAt, haversineMetres, wgs84ToCell, neighbours,
} from "../web/app/geo.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const WEB = join(REPO, "web");
const ORIGIN = "https://example.github.io/behere/";

let pass = 0;
const failures = [];
const ok = (c, what, d) => (c ? pass++ : failures.push(what + (d ? "  -> " + JSON.stringify(d) : "")));
const eq = (a, b, what) => ok(a === b, what, { got: a, want: b });

/* ------------------------------------------------------------ the network */

let online = true;
let networkHits = 0;

function pathOf(url) {
  const u = new URL(url, ORIGIN);
  if (!u.href.startsWith(ORIGIN.slice(0, ORIGIN.length - 1))) return null;
  let rel = u.pathname.replace(/^\/behere\/?/, "");
  if (rel === "" || rel.endsWith("/")) rel += "index.html";
  return join(WEB, rel);
}

async function diskFetch(input) {
  const url = typeof input === "string" ? input : input.url;
  if (!online) throw new TypeError("Failed to fetch (airplane mode)");
  networkHits++;
  const path = pathOf(url);
  if (!path || !existsSync(path)) {
    return new Response("not found", { status: 404 });
  }
  const body = readFileSync(path);
  const type = path.endsWith(".json") ? "application/json"
    : path.endsWith(".geojson") ? "application/geo+json"
    : path.endsWith(".js") ? "text/javascript"
    : path.endsWith(".css") ? "text/css"
    : path.endsWith(".html") ? "text/html"
    : path.endsWith(".webmanifest") ? "application/manifest+json"
    : "application/octet-stream";
  return new Response(body, { status: 200, headers: { "content-type": type } });
}

/* ------------------------------------------------- a minimal CacheStorage */

class FakeCache {
  constructor() { this.store = new Map(); }
  static key(req) {
    const url = typeof req === "string" ? new URL(req, ORIGIN).href : req.url;
    return url;
  }
  async put(req, res) { this.store.set(FakeCache.key(req), res); }
  async add(req) {
    const res = await diskFetch(typeof req === "string" ? new URL(req, ORIGIN).href : req);
    if (!res.ok) throw new TypeError("cache.add failed: " + FakeCache.key(req));
    this.store.set(FakeCache.key(req), res);
  }
  async addAll(list) { for (const r of list) await this.add(r); }
  async match(req) {
    const hit = this.store.get(FakeCache.key(req));
    return hit ? hit.clone() : undefined;
  }
  async keys() {
    return Array.from(this.store.keys()).map((url) => ({ url }));
  }
  async delete(req) { return this.store.delete(FakeCache.key(req)); }
}

class FakeCacheStorage {
  constructor() { this.caches = new Map(); }
  async open(name) {
    if (!this.caches.has(name)) this.caches.set(name, new FakeCache());
    return this.caches.get(name);
  }
  async keys() { return Array.from(this.caches.keys()); }
  async delete(name) { return this.caches.delete(name); }
  async match(req) {
    for (const c of this.caches.values()) {
      const hit = await c.match(req);
      if (hit) return hit;
    }
    return undefined;
  }
}

/* ------------------------------------------------------- run sw.js for real */

const listeners = new Map();
const cacheStorage = new FakeCacheStorage();

const self_ = {
  addEventListener(type, fn) {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  },
  location: { href: ORIGIN + "sw.js", origin: "https://example.github.io" },
  registration: { navigationPreload: null },
  clients: { claim: async () => {}, matchAll: async () => [] },
  skipWaiting() {},
};

const sandbox = {
  self: self_, caches: cacheStorage, fetch: diskFetch,
  URL, Response, Request, Headers, Date, Math, JSON, console,
  setTimeout, clearTimeout, Promise, Set, Map, Object, Array, String, Number,
  RegExp, Error, TypeError,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(WEB, "sw.js"), "utf8"), sandbox, { filename: "sw.js" });

ok(listeners.has("install"), "sw.js registered an install handler");
ok(listeners.has("fetch"), "sw.js registered a fetch handler");
ok(listeners.has("message"), "sw.js registered a message handler");

/* --- install, online --------------------------------------------------- */

async function dispatch(type, event) {
  const waits = [];
  event.waitUntil = (p) => waits.push(p);
  const responses = [];
  event.respondWith = (p) => responses.push(p);
  for (const fn of listeners.get(type) || []) await fn(event);
  await Promise.all(waits);
  return responses.length ? responses[0] : null;
}

const manifest = JSON.parse(readFileSync(join(WEB, "data", "precache.json"), "utf8"));
console.log("precache.json: %d files, %d cities, vintage %s",
  manifest.count, manifest.cities.length, manifest.vintage);

await dispatch("install", {});

const data = await cacheStorage.open("behere-data-v1");
const shell = await cacheStorage.open("behere-shell-__CACHE_VERSION__");
const dataKeys = (await data.keys()).map((r) => r.url);
const shellKeys = (await shell.keys()).map((r) => r.url);

console.log("after install: SHELL %d entries, DATA %d entries (%d network hits)",
  shellKeys.length, dataKeys.length, networkHits);

eq(dataKeys.length, manifest.count + 1,
  "the DATA cache holds every manifest file plus the manifest itself");
// Derived from the manifest, never hardcoded: a pilot city added to bake.py
// changes this count, and a test that pinned it would fail for the one reason
// that is not a defect.
const manifestGrid = manifest.files.filter((f) => f.startsWith("grid/")).length;
ok(dataKeys.filter((u) => u.includes("/data/grid/")).length === manifestGrid,
  "every one of the " + manifestGrid + " grid shards in the manifest is precached",
  dataKeys.filter((u) => u.includes("/data/grid/")).length);
for (const nis of manifest.cities) {
  for (const f of ["meta.json", "streets.json", "sector.geojson"]) {
    ok(dataKeys.includes(ORIGIN + "data/" + nis + "/" + f),
      nis + "/" + f + " is precached");
  }
}
for (const f of ["meta.json", "municipalities.json", "nis_history.json",
                 "i18n/en.json", "i18n/nl.json", "i18n/fr.json"]) {
  ok(dataKeys.includes(ORIGIN + "data/" + f), "data/" + f + " is precached");
}

/* --- cut the network --------------------------------------------------- */

online = false;
const hitsAtCut = networkHits;

async function swFetch(url) {
  const req = new Request(new URL(url, ORIGIN).href);
  const promise = await dispatch("fetch", { request: req, preloadResponse: undefined });
  if (!promise) throw new Error("sw.js did not respond to " + url);
  return await promise;
}

/* --- resolve every pilot city from the cache alone --------------------- */

// Landmark coordinates for the larger cities; for the two Walloon Brabant
// villages the coordinate is the median of their own baked addresses, decoded
// with web/app/geo.js, because neither has a landmark worth naming.
const CITIES = [
  { nis: "44021", name: "Ghent", lat: 51.05363, lon: 3.72530 },
  { nis: "62063", name: "Liege", lat: 50.64504, lon: 5.57364 },
  { nis: "21004", name: "Brussels", lat: 50.84673, lon: 4.35247 },
  { nis: "35013", name: "Ostend", lat: 51.22890, lon: 2.91860 },
  { nis: "81001", name: "Arlon", lat: 49.68390, lon: 5.81670 },
  { nis: "25121", name: "Ottignies-LLN", lat: 50.66900, lon: 4.61180 },
  { nis: "92003", name: "Andenne", lat: 50.48940, lon: 5.09640 },
  { nis: "25023", name: "Court-Saint-Etienne", lat: 50.64495, lon: 4.56066 },
  { nis: "25068", name: "Mont-Saint-Guibert", lat: 50.64016, lon: 4.61463 },
];

// The whole point of the pilot set is that no city may go untested. If a NIS
// reaches the shipped manifest without a coordinate here, this test would
// silently skip it, so fail instead.
{
  const covered = new Set(CITIES.map((c) => c.nis));
  const missing = manifest.cities.filter((n) => !covered.has(n));
  ok(missing.length === 0,
    "every shipped pilot city has a test coordinate", missing.join(","));
}

async function readJSON(rel) {
  const res = await swFetch("data/" + rel);
  if (!res.ok) return null;
  return await res.json();
}

console.log("\nairplane mode, cold page load, cache only:");
for (const city of CITIES) {
  const centre = wgs84ToCell(city.lat, city.lon);
  const cells = neighbours(centre);

  const shards = [];
  let served = 0;
  for (const id of cells) {
    const res = await swFetch("data/grid/" + id + ".json");
    if (res.status === 200) {
      served++;
      const s = decodeShard(await res.json());
      if (s) shards.push(s);
    }
  }

  const addresses = shards.flatMap((s) => s.addresses);
  const near = addresses.length ? nearest(city.lat, city.lon, addresses) : null;
  ok(!!near, city.name + ": an address resolves offline");
  if (!near) continue;

  const nis = near.item.nis;
  const meta = await readJSON(nis + "/meta.json");
  const streetTable = await readJSON(nis + "/streets.json");
  const sectorFC = await readJSON(nis + "/sector.geojson");

  // Expand streets.json the way geo.js readStreets does, to name the street.
  let street = "";
  if (streetTable && Array.isArray(streetTable.id)) {
    let acc = 0;
    for (let i = 0; i < streetTable.id.length; i++) {
      acc += streetTable.id[i];
      if (acc === near.item.streetId) {
        street = (streetTable.nl && streetTable.nl[i]) ||
          (streetTable.fr && streetTable.fr[i]) ||
          (streetTable.de && streetTable.de[i]) || "";
        break;
      }
    }
  }

  const feature = sectorFC ? findSectorAt(city.lat, city.lon, sectorFC) : null;
  const sector = feature && feature.properties ? feature.properties.s : near.item.sector;

  eq(nis, city.nis, city.name + ": municipality resolves to " + city.nis);
  ok(!!meta, city.name + ": <nis>/meta.json served from cache");
  ok(!!sector, city.name + ": a statistical sector resolves");
  ok(!!street, city.name + ": the street name resolves from streets.json");
  ok(near.distanceM < 200, city.name + ": nearest address is close", near.distanceM);

  console.log(
    "  " + city.nis + " " + city.name.padEnd(14) +
    " " + served + "/9 shards, " + addresses.length.toString().padStart(6) + " addr" +
    ", nearest '" + street + " " + near.item.house + "' d=" +
    near.distanceM.toFixed(1) + "m" +
    ", sector " + sector + " (" + (feature ? "polygon" : "address") + ")" +
    ", NIS " + nis + ", " + (meta ? meta.name.nl : "?") +
    ", vintage " + (meta ? meta.vintage : "?")
  );
}

eq(networkHits, hitsAtCut, "not one byte was fetched from the network after the cut");

/* --- the shared documents answer offline too --------------------------- */
for (const rel of ["meta.json", "municipalities.json", "nis_history.json",
                   "i18n/en.json", "i18n/nl.json", "i18n/fr.json",
                   "precache.json"]) {
  const doc = await readJSON(rel);
  ok(doc !== null && typeof doc === "object", "data/" + rel + " answers offline");
}

/* --- the status message the footer line is built from ------------------ */
{
  const replies = [];
  const port = { postMessage: (m) => replies.push(m) };
  await dispatch("message", { data: { type: "DATA_STATUS" }, ports: [port] });
  const s = replies[0];
  ok(!!s, "the worker answered DATA_STATUS");
  if (s) {
    eq(s.stored, s.total, "it reports every file stored");
    eq(s.ready, true, "and reports itself ready for offline use");
    eq(s.cities.length, manifest.cities.length,
      "with a per-city breakdown of all " + manifest.cities.length);
    eq(s.vintage, manifest.vintage, "stamped with the pinned vintage");
    // Mont-Saint-Guibert displaced Ottignies-LLN as the thinnest city. Pick it
    // from the data rather than naming it, so the next addition cannot make
    // this assertion quietly test the wrong city.
    const thin = s.cities.reduce((a, b) => (b.total < a.total ? b : a));
    ok(thin && thin.stored === thin.total && thin.total > 0,
      "including " + thin.nis + ", the thinnest city", thin);
  }
}

console.log("\n%d assertions passed, %d failed", pass, failures.length);
if (failures.length) {
  for (const f of failures) console.error("  FAIL " + f);
  process.exit(1);
}
console.log("acceptance test 1: all " + CITIES.length + " cities resolve from a COLD cache with " +
  "the network cut.");
