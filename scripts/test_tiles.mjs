/**
 * The OSM basemap tests. UI_SPEC section 1.2, "Caching, and the precache
 * prohibition".
 *
 * Two questions, and the first one is a licence question rather than a
 * performance one:
 *
 *   1. CAN A TILE EVER BE PRECACHED?  The OSM tile usage policy forbids bulk
 *      downloading, and downloading an area of tiles for offline use IS bulk
 *      downloading. web/sw.js precaches 707 baked files at install across all
 *      seven pilot cities; a tile reaching that path would be exactly the
 *      thing the policy prohibits, 674 cells wide. This file installs the real
 *      worker -- including against a POISONED precache.json that names a tile
 *      host -- and proves nothing raster is stored.
 *
 *   2. IS THE RUNTIME CACHE ACTUALLY BOUNDED, AND ACTUALLY LRU?  A cap that is
 *      really oldest-stored-first would evict the ground you keep walking over.
 *      This drives the worker past the cap and checks that a recently USED tile
 *      outlives an older-but-untouched one.
 *
 * Nothing is stubbed on the BeHERE side: web/sw.js is read from disk and run
 * unmodified, exactly as scripts/test_sw_offline.mjs does. What is faked is the
 * platform: CacheStorage, fetch, the clock, and navigator.connection.
 *
 * Tiles are faked as OPAQUE responses on purpose. A no-cors <img> fetch cannot
 * be constructed in Node, and it is the single most consequential fact about
 * this code path: status 0, no readable headers, no readable body, which is
 * why the timestamps live in a sidecar index instead of a response header.
 *
 *   node scripts/test_tiles.mjs
 *
 * Exits 1 on any failure. Plain node, no dependency.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const WEB = join(REPO, "web");
const ORIGIN = "https://example.github.io/behere/";
const TILE_HOST = "tile.openstreetmap.org";

let pass = 0;
const failures = [];
const ok = (c, what, d) => (c ? pass++ : failures.push(what + (d === undefined ? "" : "  -> " + JSON.stringify(d))));
const eq = (a, b, what) => ok(a === b, what, { got: a, want: b });

/* ---------------------------------------------------------------- the clock */

let clockSkew = 0;
const realNow = Date.now.bind(Date);
class ShiftedDate extends Date {
  static now() { return realNow() + clockSkew; }
}
const tick = (ms) => { clockSkew += ms; };

/* -------------------------------------------------------------- the network */

let online = true;
let saveData = false;
let hits = 0;
let tileHits = 0;
const overrides = new Map();      // url -> () => Response, for the poisoned run

function tileUrl(z, x, y) {
  return "https://" + TILE_HOST + "/" + z + "/" + x + "/" + y + ".png";
}

/** A no-cors tile response: opaque, status 0, unreadable. */
function opaqueTile(url) {
  return {
    type: "opaque", status: 0, ok: false, url: "", redirected: false,
    headers: new Headers(),
    clone() { return opaqueTile(url); },
    _tile: url,
  };
}

function pathOf(url) {
  const u = new URL(url, ORIGIN);
  if (u.origin !== new URL(ORIGIN).origin) return null;
  let rel = u.pathname.replace(/^\/behere\/?/, "");
  if (rel === "" || rel.endsWith("/")) rel += "index.html";
  return join(WEB, rel);
}

async function fakeFetch(input) {
  // sw.js asks for "./data/precache.json" relative to its own scope, so this
  // must resolve exactly as a browser would before anything else looks at it.
  const url = new URL(typeof input === "string" ? input : input.url, ORIGIN).href;
  if (!online) throw new TypeError("Failed to fetch (airplane mode)");
  hits++;
  if (overrides.has(url)) return overrides.get(url)();
  if (new URL(url).host === TILE_HOST) {
    tileHits++;
    return opaqueTile(url);
  }
  const path = pathOf(url);
  if (!path || !existsSync(path)) return new Response("not found", { status: 404 });
  const body = readFileSync(path);
  const type = path.endsWith(".json") ? "application/json"
    : path.endsWith(".js") ? "text/javascript"
    : path.endsWith(".css") ? "text/css"
    : path.endsWith(".html") ? "text/html"
    : "application/octet-stream";
  return new Response(body, { status: 200, headers: { "content-type": type } });
}

/* ------------------------------------------------- a minimal CacheStorage */

class FakeCache {
  constructor() { this.store = new Map(); }
  static key(req) {
    return typeof req === "string" ? new URL(req, ORIGIN).href : req.url;
  }
  async put(req, res) { this.store.set(FakeCache.key(req), res); }
  async add(req) {
    const res = await fakeFetch(typeof req === "string" ? new URL(req, ORIGIN).href : req);
    if (!res.ok) throw new TypeError("cache.add failed: " + FakeCache.key(req));
    this.store.set(FakeCache.key(req), res);
  }
  async addAll(list) { for (const r of list) await this.add(r); }
  async match(req) {
    const hit = this.store.get(FakeCache.key(req));
    return hit ? hit.clone() : undefined;
  }
  async keys() { return Array.from(this.store.keys()).map((url) => ({ url })); }
  async delete(req) { return this.store.delete(FakeCache.key(req)); }
}

class FakeCacheStorage {
  constructor() { this.caches = new Map(); }
  async open(name) {
    if (!this.caches.has(name)) this.caches.set(name, new FakeCache());
    return this.caches.get(name);
  }
  async has(name) { return this.caches.has(name); }
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

/* ------------------------------------------------------ run sw.js for real */

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
  self: self_, caches: cacheStorage, fetch: fakeFetch,
  navigator: { get connection() { return { saveData }; } },
  URL, Response, Request, Headers, Date: ShiftedDate, Math, JSON, console,
  setTimeout, clearTimeout, Promise, Set, Map, Object, Array, String, Number,
  RegExp, Error, TypeError,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
const SW_SOURCE = readFileSync(join(WEB, "sw.js"), "utf8");
vm.runInContext(SW_SOURCE, sandbox, { filename: "sw.js" });

/**
 * Dispatch one event and settle everything it started.
 *
 * The drain loop matters and is not defensive padding. In stale-while-
 * revalidate the handler calls respondWith() first and waitUntil() only after
 * the cached response has been resolved, so a harness that awaits `waits`
 * straight after the listener returns awaits an EMPTY array, and then asserts
 * against a cache the background revalidation has not finished writing. That
 * reads as a worker bug and is a harness bug. So: run the listeners, resolve
 * the response, then drain waitUntil until nothing new is registered.
 */
async function dispatch(type, event) {
  const waits = [];
  event.waitUntil = (p) => waits.push(p);
  const responses = [];
  event.respondWith = (p) => responses.push(p);
  for (const fn of listeners.get(type) || []) await fn(event);
  const answer = responses.length ? await responses[0] : null;
  for (let guard = 0; guard < 100 && waits.length; guard++) {
    await Promise.all(waits.splice(0));
  }
  return answer;
}

async function swFetch(url) {
  const req = new Request(new URL(url, ORIGIN).href);
  const res = await dispatch("fetch", { request: req, preloadResponse: undefined });
  if (!res) throw new Error("sw.js did not respond to " + url);
  return res;
}

const TILES = "behere-tiles-v1";
const DATA = "behere-data-v1";
const INDEX_URL = ORIGIN + "__behere_tile_index__";

const allUrls = async () => {
  const out = [];
  for (const name of await cacheStorage.keys()) {
    const c = await cacheStorage.open(name);
    for (const k of await c.keys()) out.push([name, k.url]);
  }
  return out;
};
const tileUrlsIn = async (name) => {
  if (!(await cacheStorage.has(name))) return [];
  const c = await cacheStorage.open(name);
  return (await c.keys()).map((k) => k.url).filter((u) => u.includes(TILE_HOST));
};

/* =========================================================================
 * 1. THE PRECACHE PROHIBITION
 * ====================================================================== */

console.log("1. install: the full precache, then look for raster");
await dispatch("install", {});

{
  const everywhere = await allUrls();
  const rasters = everywhere.filter(([, u]) => u.includes(TILE_HOST));
  eq(rasters.length, 0,
    "no tile URL is in ANY cache after a full install of " + everywhere.length + " entries");
  eq(await cacheStorage.has(TILES), false,
    "the tile cache does not even exist until a tile is requested");
  const dataCache = await cacheStorage.open(DATA);
  const stored = (await dataCache.keys()).length;
  ok(stored > 700, "the baked data still precached in full", stored);
  eq(tileHits, 0, "install made zero requests to " + TILE_HOST);
}

/* The source itself: no shell list may name a host, and the only tile write
 * must be the runtime one. Mirrors gen_precache.py's gate from the JS side. */
{
  const shell = SW_SOURCE.match(/const\s+(SHELL_\w+)\s*=\s*\[(.*?)\]\s*;/gs) || [];
  const entries = shell.flatMap((b) => Array.from(b.matchAll(/["']([^"']*)["']/g), (m) => m[1]));
  ok(entries.length > 15, "found the shell lists in sw.js", entries.length);
  eq(entries.filter((e) => e.includes("://") || e.includes(TILE_HOST)).length, 0,
    "no shell list entry is an absolute URL");
  const adds = SW_SOURCE.split("\n").filter((l) => /\.add(All)?\s*\(/.test(l) && /TILE/.test(l));
  eq(adds.length, 0, "no cache.add()/addAll() line mentions a tile", adds);
}

/* A precache.json that HAS been tampered with. bake.py cannot write one, but
 * a CDN, a bad merge or a hand edit could serve one, so the worker refuses it
 * at runtime too. */
console.log("2. a poisoned precache.json");
{
  const good = JSON.parse(readFileSync(join(WEB, "data", "precache.json"), "utf8"));
  const poison = {
    vintage: good.vintage, cities: [], cells: {}, count: 6,
    files: [
      "https://" + TILE_HOST + "/15/16800/10990.png",
      "//" + TILE_HOST + "/15/16800/10991.png",
      "/etc/passwd",
      "../../secret.json",
      "grid/../../off.json",
      "meta.json",
    ],
  };
  overrides.set(ORIGIN + "data/precache.json", () =>
    new Response(JSON.stringify(poison), {
      status: 200, headers: { "content-type": "application/json" },
    }));
  await cacheStorage.delete(DATA);
  const before = tileHits;
  await dispatch("message", { data: { type: "WARM_DATA" }, ports: [{ postMessage() {} }] });
  overrides.delete(ORIGIN + "data/precache.json");

  eq(tileHits, before, "a manifest naming a tile host causes zero tile requests");
  const everywhere = await allUrls();
  eq(everywhere.filter(([, u]) => u.includes(TILE_HOST)).length, 0,
    "and stores no tile anywhere");
  const dataCache = await cacheStorage.open(DATA);
  const kept = (await dataCache.keys()).map((k) => k.url);
  ok(kept.some((u) => u.endsWith("/data/meta.json")),
    "the one legitimate entry in the poisoned manifest was still stored");
  eq(kept.filter((u) => u.includes("passwd") || u.includes("secret")).length, 0,
    "and every traversal or absolute entry was refused");

  // Put the real data back for the rest of the run.
  await cacheStorage.delete(DATA);
  await dispatch("message", { data: { type: "WARM_DATA" }, ports: [{ postMessage() {} }] });
}

/* =========================================================================
 * 2. THE RUNTIME CACHE
 * ====================================================================== */

console.log("3. one tile, cold");
const T0 = tileUrl(15, 16800, 10990);
{
  const before = tileHits;
  const res = await swFetch(T0);
  eq(res.type, "opaque", "an uncached tile is fetched and served opaque");
  eq(res._tile, T0, "and it is the tile that was asked for");
  eq(tileHits, before + 1, "exactly one network request");
  eq((await tileUrlsIn(TILES)).length, 1, "stored, in behere-tiles-v1");
  eq((await tileUrlsIn(DATA)).length, 0, "and not in the data cache");
  eq((await tileUrlsIn("behere-shell-__CACHE_VERSION__")).length, 0,
    "and not in the shell cache");
  const idx = await (await cacheStorage.open(TILES)).match(INDEX_URL);
  const doc = await idx.json();
  const entry = doc && doc.tiles && doc.tiles[T0];
  ok(Array.isArray(entry) && entry.length === 2 && entry[0] === entry[1],
    "the sidecar carries [fetchedAt, lastUsed], because an opaque response cannot",
    entry);
  eq(doc.max, 300, "the index records the cap it was written under");
}

const readIndex = async () =>
  (await (await (await cacheStorage.open(TILES)).match(INDEX_URL)).json()).tiles;

console.log("4. the same tile again, inside the 7 day TTL");
{
  tick(6 * 24 * 3600 * 1000);
  const before = tileHits;
  const res = await swFetch(T0);
  eq(res._tile, T0, "served from cache");
  eq(tileHits, before, "with NO network request at all, six days later");

  // The distinction that stops a daily-viewed tile from living for ever.
  const entry = (await readIndex())[T0];
  ok(ShiftedDate.now() - entry[1] < 1000, "the LRU stamp moved to now", entry);
  ok(ShiftedDate.now() - entry[0] > 5 * 24 * 3600 * 1000,
    "but the age stamp did NOT: looking at a tile does not make it newer", entry);

  // A pan asks for the same tile many times a second; the index must not be
  // re-serialised for each one.
  tick(200);
  await swFetch(T0);
  const again = (await readIndex())[T0];
  eq(again[1], entry[1],
    "a touch inside the write throttle does not rewrite the stored index");
}

console.log("5. past the TTL: stale first, revalidate behind it");
{
  tick(2 * 24 * 3600 * 1000);      // eight days since it was fetched
  const before = tileHits;
  const res = await swFetch(T0);
  eq(res._tile, T0, "the eight-day-old tile is still served immediately");
  eq(tileHits, before + 1, "and revalidated once in the background");
  const entry = (await readIndex())[T0];
  ok(ShiftedDate.now() - entry[0] < 1000, "its age stamp was refreshed", entry);

  tick(1000);
  const after = tileHits;
  await swFetch(T0);
  eq(tileHits, after, "so the very next request is free again");
}

console.log("6. the LRU cap");
{
  // Fill to the cap. Each tile gets its own millisecond so the ordering the
  // eviction sorts on is unambiguous.
  for (let i = 1; i < 300; i++) {
    tick(10);
    await swFetch(tileUrl(15, 16800 + i, 10990));
  }
  eq((await tileUrlsIn(TILES)).length, 300, "300 tiles stored, exactly at the cap");

  // T0 is now the OLDEST-STORED tile. Touch it, so it becomes the most
  // recently USED one. A FIFO cache would evict it next; an LRU must not.
  //
  // This touch also lands INSIDE the write throttle, so it is never persisted.
  // Surviving the eviction below therefore proves the second half of that
  // design: the throttle skips the disk write, never the in-memory ordering
  // the eviction actually reads.
  tick(10);
  await swFetch(T0);

  const overflow = [];
  for (let i = 0; i < 5; i++) {
    tick(10);
    const u = tileUrl(16, 33600 + i, 21980);
    overflow.push(u);
    await swFetch(u);
  }

  const stored = new Set(await tileUrlsIn(TILES));
  eq(stored.size, 300, "still exactly 300 after five more: the cap holds");
  ok(stored.has(T0),
    "the oldest-STORED tile survived, because it was the most recently USED");
  for (const u of overflow) ok(stored.has(u), "the newest tile is present");
  const evicted = [1, 2, 3, 4, 5].map((i) => tileUrl(15, 16800 + i, 10990));
  eq(evicted.filter((u) => stored.has(u)).length, 0,
    "and the five least recently used went instead");

  eq(Object.keys(await readIndex()).length, 300, "the index agrees with the cache");
  eq((await (await cacheStorage.open(TILES)).keys()).length, 301,
    "301 cache entries: 300 tiles plus the index, which never counts against the cap");
}

console.log("7. offline, and Save-Data");
{
  const cached = await swFetch(T0);
  eq(cached._tile, T0, "a stored tile is served while online");

  online = false;
  const missResponse = await swFetch(tileUrl(17, 67200, 43960));
  eq(missResponse.status, 504,
    "an unseen tile with no network 504s, so the <img> fires error and map.js can count it");
  const stillThere = await swFetch(T0);
  eq(stillThere._tile, T0, "a stored tile still answers offline");
  online = true;

  saveData = true;
  const before = tileHits;
  const refused = await swFetch(tileUrl(17, 67201, 43960));
  eq(refused.status, 504, "under Save-Data an unseen tile is refused");
  eq(tileHits, before, "without touching the network");
  const known = await swFetch(T0);
  eq(known._tile, T0,
    "but a tile already on the device is still shown: displaying it costs nothing");

  // Even an expired one. Serving it is free; revalidating it is not.
  tick(30 * 24 * 3600 * 1000);
  const beforeStale = tileHits;
  const stale = await swFetch(T0);
  eq(stale._tile, T0, "a month-stale stored tile is still shown under Save-Data");
  eq(tileHits, beforeStale, "and is NOT revalidated, because that would cost bytes");
  saveData = false;

  const revalidated = await swFetch(T0);
  eq(revalidated._tile, T0, "with Save-Data off it is served stale again");
  eq(tileHits, beforeStale + 1, "and revalidated once behind that");
}

console.log("8. the index is bookkeeping, not an asset");
{
  const res = await swFetch(INDEX_URL);
  eq(res.status, 404, "the sidecar index is never served as a shell asset");
}

console.log("9. PURGE_TILES drops the basemap and nothing else");
{
  const dataBefore = (await (await cacheStorage.open(DATA)).keys()).length;
  const replies = [];
  await dispatch("message", {
    data: { type: "PURGE_TILES" }, ports: [{ postMessage: (m) => replies.push(m) }],
  });
  eq(replies.length, 1, "the worker answered");
  ok(replies[0] && replies[0].removed === 300, "reporting the 300 tiles it dropped", replies[0]);
  eq(await cacheStorage.has(TILES), false, "the tile cache is gone");
  eq((await (await cacheStorage.open(DATA)).keys()).length, dataBefore,
    "and not one baked file went with it");
}

console.log("10. activate keeps the tile cache and drops a previous generation");
{
  await cacheStorage.open("behere-tiles-v0");     // a previous generation
  await cacheStorage.open("behere-junk");
  await swFetch(T0);                              // re-create behere-tiles-v1
  await dispatch("activate", {});
  const names = (await cacheStorage.keys()).filter((n) => n.startsWith("behere-")).sort();
  ok(names.includes(TILES), "behere-tiles-v1 is in KEEP and survives activate", names);
  ok(names.includes(DATA), "so does the baked data", names);
  ok(names.includes("behere-shell-__CACHE_VERSION__"), "so does the shell", names);
  eq(names.filter((n) => n === "behere-tiles-v0" || n === "behere-junk").length, 0,
    "and a superseded tile cache is deleted rather than left to rot", names);
  // behere-live-v1 is absent only because this run never touched a live API;
  // scripts/test_sw_offline.mjs and the KEEP array cover it.
}

console.log("\n%d assertions passed, %d failed", pass, failures.length);
if (failures.length) {
  for (const f of failures) console.error("  FAIL " + f);
  process.exit(1);
}
console.log("the basemap is runtime-only, bounded at 300 entries, evicted least-recently-used, " +
  "and cannot reach precache.json.");
