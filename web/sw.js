/* BeHERE service worker.
 *
 * NEVER RENAME THIS FILE. Browsers byte-compare the service worker URL; a
 * versioned or hashed name means an update is never fetched, and the recovery
 * path for a bad worker is to overwrite THIS exact URL with kill-sw.js.
 *
 * Caching, straight from PLAN section 6 and UI_SPEC section 1.2:
 *
 *   cache-first ............. hashed shards, sector geometry, app shell
 *   network-first ........... navigations, statistics, live departures
 *   stale-while-revalidate .. POI layers, OSM basemap tiles
 *   offline fallback ........ last-known departures with an explicit "as of"
 *
 * Four caches, because they have four different lifetimes:
 *
 *   SHELL  rotates on every deploy. The VERSION placeholder below is replaced
 *          with a content hash of the shell by the deploy step
 *          (scripts/stamp_cache_version.py). Precached at install.
 *   DATA   the baked shards. Deliberately NOT rotated per deploy: a cosmetic
 *          CSS change must not wipe a city the user carries around offline.
 *          It is dropped when web/data/meta.json reports a new `built`, which
 *          the page detects and sends here as {type:"PURGE_DATA"}.
 *   LIVE   runtime API responses. Every entry is stamped with
 *          x-behere-cached-at so the UI can always say how old a number is.
 *   TILES  the OSM basemap. RUNTIME ONLY, never precached, capped at 300
 *          entries and evicted least-recently-used. Read "THE TILE RULES"
 *          below before touching anything in it.
 *
 * ---------------------------------------------------------------------------
 * THE DATA IS PRECACHED AT INSTALL, NOT ON FIRST USE
 * ---------------------------------------------------------------------------
 * PLAN phase 1's exit criterion is "all seven cities resolve offline from a
 * COLD cache", and PLAN section 11 says "a cold start must work with no cache".
 * A cache-first fetch rule alone cannot deliver that: it only ever fills the
 * cache with squares the user has already stood in while online. Someone who
 * warmed Brussels and then lands in Ghent in airplane mode would get nothing
 * for Ghent, which is a correct-sounding sentence and a failed acceptance test.
 *
 * So install() reads web/data/precache.json, the manifest scripts/bake.py emits
 * alongside the shards, and stores every file it names in the DATA cache: the
 * 631 grid shards, the 7 cities' meta/streets/sector files, and the shared
 * meta, municipalities, nis_history and i18n documents. That is 6.2 MB raw and
 * about 1.48 MB gzipped for all seven cities, well inside PLAN section 8's
 * 3 MB budget.
 *
 * It is fenced so it can never break the app: the whole pass is wrapped in
 * try/catch, every file goes through Promise.allSettled in batches, and files
 * already in the cache are skipped. A missing manifest, a 404 shard or a full
 * disk degrades to the old lazy behaviour instead of failing the install.
 *
 * ---------------------------------------------------------------------------
 * THE TILE RULES, WHICH ARE A LICENCE OBLIGATION AND NOT A PREFERENCE
 * ---------------------------------------------------------------------------
 * The basemap under the vector layers is https://tile.openstreetmap.org,
 * served under the OSMF tile usage policy. One clause of it is load-bearing
 * here: bulk downloading is forbidden, and downloading an area of tiles for
 * offline use is bulk downloading.
 *
 * So a tile is cached ONLY as a side effect of a tile the user actually looked
 * at. There is no prefetch, no ring of neighbours, no warming loop, and above
 * all NO PRECACHE. precacheData() below stores the baked shards for all seven
 * pilot cities at install; putting the basemap through that same door would be
 * exactly the bulk download the policy forbids, 674 cells wide, at up to seven
 * zoom levels each.
 *
 * Three independent mechanisms keep that true, so no single edit can undo it:
 *
 *   1. scripts/bake.py precache_doc() refuses any manifest entry that is not a
 *      plain relative path under web/data/. A scheme, a host or a leading
 *      slash raises BakeError, so no absolute URL can be listed at all.
 *   2. precacheData() re-checks every entry with safeDataPath() before it is
 *      turned into a URL, so a hand-edited manifest still cannot name a host.
 *   3. scripts/gen_precache.py --check greps the shipped manifest AND this
 *      file, and fails CI if the tile host appears in precache.json, in any
 *      shell list, or anywhere near a cache.add()/cache.addAll() call.
 *
 * Attribution is a separate and equally non-optional obligation, and a worker
 * cannot discharge it: the visible "(c) OpenStreetMap contributors" link to
 * openstreetmap.org/copyright lives on the map itself (UI_SPEC 1.8).
 *
 * WHY THIS CACHE IS DOING REAL WORK. OSM answers with `cache-control: no-cache`
 * and a strong ETag, which tells the HTTP cache "keep this, but revalidate
 * before you reuse it". Cache Storage is deliberately outside that rule:
 * entries here are reused without asking anyone. That is what makes panning
 * back over ground you already covered cost nothing, and it is why the TTL and
 * the cap below are ours to get right rather than the server's.
 *
 * REVALIDATION IS A PLAIN RE-FETCH, with the default fetch cache mode. The
 * browser's own HTTP cache still holds the ETag, so the request goes out
 * conditional and comes back 304 with no body in the common case. Setting
 * cache:"reload", or hanging a cache-buster on the URL, would throw those
 * validators away and turn every refresh into a full PNG, which is the exact
 * opposite of being a good citizen on someone else's donated bandwidth. We
 * never set If-None-Match ourselves either: an <img> tile is a no-cors request
 * and that header is not CORS-safelisted, so it would simply be dropped.
 *
 * TILES ARE OPAQUE, WHICH IS WHY THEY HAVE A SIDECAR INDEX. A no-cors response
 * has status 0 and no readable headers or body, so put() below -- which
 * re-wraps a response to stamp it with x-behere-cached-at -- CANNOT be used on
 * a tile: res.blob() on an opaque body yields nothing and it would store a
 * 0-byte PNG. Tiles therefore go in untouched through cache.put(), and their
 * timestamps live in one small JSON index entry beside them. That index is
 * also what makes the eviction genuinely least-recently-USED rather than
 * merely oldest-stored.
 *
 * There is no key, token or credential anywhere in this file, because there is
 * none to have: all nine runtime hosts are keyless (acceptance test 7), and
 * the tile URL carries no query string.
 */

const VERSION = "__CACHE_VERSION__";
const SHELL = "behere-shell-" + VERSION;
const DATA = "behere-data-v1";
const LIVE = "behere-live-v1";
const TILES = "behere-tiles-v1";
const KEEP = [SHELL, DATA, LIVE, TILES];

/* The app shell. Precache LESS rather than more: this is the shell only, no
 * data, no full icon set. If one of these 404s the install fails and the user
 * simply has no worker, which is the correct outcome for a broken shell.
 *
 * THE FONTS ARE REQUIRED, NOT OPTIONAL. tokens.css sets the whole interface in
 * Caprasimo and Figtree; a shell that precaches the stylesheet but not its
 * faces installs happily and then renders offline in system-ui, which is not
 * the product. woff2 is already Brotli-compressed, so all four subsets cost
 * about 53 kB on the wire, once, and they never touch the 3 MB DATA budget
 * (that gate walks web/data only). latin-ext is here for runtime strings --
 * iRail headsigns, Opendatasoft event titles -- not for the baked data, which
 * contains nothing above U+00FF; unicode-range keeps it lazy at render time
 * but the bytes still have to be on the device before the network is cut. */
const SHELL_REQUIRED = [
  "./",
  "./index.html",
  "./offline.html",
  "./manifest.webmanifest",
  "./app/tokens.css",
  "./app/app.css",
  "./app/map.css",
  "./app/main.js",
  "./app/map.js",
  "./app/mercator.js",
  "./app/grid.js",
  "./app/geo.js",
  "./app/i18n.js",
  "./app/icons.js",
  "./app/stats.js",
  "./app/sw-register.js",
  "./app/offline.js",
  "./fonts/figtree-var-latin.woff2",
  "./fonts/figtree-var-latin-ext.woff2",
  "./fonts/caprasimo-400-latin.woff2",
  "./fonts/caprasimo-400-latin-ext.woff2",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

/* The manifest of baked data files, emitted by scripts/bake.py so it can never
 * drift from what was actually baked. Relative, like everything else here: the
 * site is a project page under /behere/ and a leading slash would 404. */
const DATA_MANIFEST = "./data/precache.json";

/* How many shards to request at once during the install precache. Small enough
 * that a phone on a slow link is not asked to open 658 sockets, large enough
 * that the whole pass is a handful of round trips over HTTP/2. */
const PRECACHE_BATCH = 24;

/* SHELL, but still landing. map.css, map.js and mercator.js have shipped and
 * are in SHELL_REQUIRED above, where a rename fails the install loudly and
 * turns scripts/test_sw_offline.mjs red before a build can reach Pages.
 *
 * This middle tier is EMPTY, and that is the finished state rather than an
 * oversight. It held "./app/dock.js" while the revamp was in flight; the dock
 * ended up living inside main.js (openBand / wireDock / watchPillState), which
 * is the second outcome this comment always allowed for. Nothing on disk is
 * named dock.js, main.js imports nothing by that name, and index.html links no
 * such module, so listing it here would have made every install log a warning
 * about a file the app does not want.
 *
 * The tier is kept, empty, because it is the right home for the NEXT module
 * that ships mid-flight: entries here are added one at a time rather than
 * through addAll, since cache.addAll rejects the WHOLE install on a single 404
 * and a not-yet-committed chrome module would otherwise leave every user with
 * no worker, and therefore no offline data -- a chrome file taking out
 * acceptance test 1. A failure here is reported to the console, never
 * swallowed. Move an entry up into SHELL_REQUIRED once it has shipped. */
const SHELL_EXPECTED = [];

/* Band modules are written by other agents and may not exist in every build.
 * A missing one collapses its band with honest copy; it must never take the
 * whole worker down, so these are cached individually and failures ignored. */
const SHELL_OPTIONAL = [
  "./404.html",
  "./favicon-32.png",
  "./icons/icon-512-maskable.png",
  "./icons/apple-touch-icon.png",
  "./app/gtfsrt.js",
  "./app/here.js",
  "./app/around.js",
  "./app/go.js",
  "./app/now.js",
  "./app/zoom.js",
];

/* Runtime TTLs, from CONTRACT section 10. Seconds. */
const TTL = {
  "api.irail.be": 30,                                            // 10.1
  "api-management-discovery-production.azure-api.net": 30,        // 10.2
  "opendata-api.statbel.fgov.be": 86400,                          // 10.3
  "data.stad.gent": 3600,                                         // 10.4
  "www.odwb.be": 3600,
  "opendata.brussels.be": 3600,
  "geoservices.wallonie.be": 21600,                               // 10.5
  "geo.onroerenderfgoed.be": 21600,                               // 10.6
  "catalog.datastore.brussels": 86400,                            // 10.7
};

/* Which strategy a live host gets. Departures and statistics must be as fresh
 * as the network allows; POI layers are happy to be a moment old. */
const NETWORK_FIRST_HOSTS = new Set([
  "api.irail.be",
  "api-management-discovery-production.azure-api.net",
  "opendata-api.statbel.fgov.be",
]);

const STAMP = "x-behere-cached-at";

/* ------------------------------------------------------- the basemap */

/* The one place this host is named in executable code. gen_precache.py greps
 * for any second occurrence outside a comment, and for the string appearing on
 * a line with cache.add( or cache.addAll( on it. */
const TILE_HOST = "tile.openstreetmap.org";

/* Seven days, in seconds. Long on purpose: a Belgian street changes on the
 * order of months, and every re-request is traffic on a volunteer-funded CDN.
 * Inside this window a stored tile is served with no network call at all. */
const TILE_TTL = 7 * 24 * 60 * 60;

/* The cap, in entries. Roughly 15 kB per 256 px PNG puts 300 tiles at about
 * 4.5 MB: a fraction of the ~6 MB of baked shards already stored, so the
 * basemap can never be the reason the browser evicts a city. Geometrically it
 * is also what a phone genuinely needs -- a 400x800 viewport covers 2x4 tiles,
 * so 300 entries is roughly 37 screenfuls, which is a walk across a city and
 * back at one zoom plus room to have visited two other levels. Past the cap
 * the least recently USED tile goes, not the oldest stored: the index below
 * is touched on every cache hit, so the ground you keep walking over stays. */
const TILE_MAX = 300;

/* How stale an LRU stamp may get before the index is written back to disk.
 * One minute is far below any resolution the cap actually needs, and far above
 * the rate at which a pan re-requests the same tile. */
const TILE_TOUCH_MS = 60 * 1000;

/* Where the timestamps live. A synthetic same-origin key, kept INSIDE the tile
 * cache so purging the basemap purges its bookkeeping with it in one call. It
 * is never counted against TILE_MAX and never served as an asset: the fetch
 * handler 404s it explicitly. */
const TILE_INDEX_URL = new URL("__behere_tile_index__", self.location.href).href;

/* In-memory mirror of that entry: {tileUrl: [fetchedAtMs, lastUsedMs]}.
 *
 * TWO timestamps, and collapsing them into one is a bug that hides for weeks.
 * The TTL asks "how old is this picture", the LRU asks "when did anyone last
 * want it", and they are not the same question: a tile on the user's own
 * street is looked at every single day, so if a cache hit refreshed the
 * fetched-at stamp it would stay "fresh" for ever and never once revalidate.
 * The tiles that would rot are exactly the ones the user cares most about.
 * So a hit moves [1] only, and a network store rewrites both.
 *
 * Hydrated once per worker lifetime, written back through a serialised,
 * coalescing chain so a burst of twenty tiles costs at most two writes. */
let tileIndex = null;
let tileIndexLoad = null;
let tileIndexDirty = false;
let tileIndexWrite = Promise.resolve();

/* ------------------------------------------------------------- install */

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await cache.addAll(SHELL_REQUIRED);
    const absent = await addEach(cache, SHELL_EXPECTED);
    if (absent.length) {
      // Loud, because a missing map module is a hole in the shell rather than
      // a band that can honestly collapse. It is still not fatal: see the note
      // on SHELL_EXPECTED.
      console.warn("BeHERE sw: shell module not in this build: " + absent.join(", "));
    }
    await addEach(cache, SHELL_OPTIONAL);
    // The seven cities, stored before they are ever asked for, so a cold cache
    // in airplane mode still answers "where am I" (PLAN phase 1, test 1).
    // NOTE: baked shards ONLY. No tile is ever added here, by construction --
    // see THE TILE RULES at the top of this file.
    await precacheData();
    // Do NOT skipWaiting here: the page prompts, then posts SKIP_WAITING.
  })());
});

/** cache.add every URL independently, tolerating failures, and return the ones
 *  that did not store. Never rejects, so an install can never die of it. */
async function addEach(cache, urls) {
  const results = await Promise.allSettled(urls.map((u) => cache.add(u)));
  const absent = [];
  for (let i = 0; i < urls.length; i++) {
    if (results[i].status === "rejected") absent.push(urls[i]);
  }
  return absent;
}

/* ------------------------------------------------------- data precache */

/** Read web/data/precache.json. Returns null rather than throwing. */
async function readDataManifest() {
  try {
    // cache:"reload" because Pages forces Cache-Control: max-age=600 on every
    // file and a stale manifest would precache last release's shard list.
    const res = await fetch(DATA_MANIFEST, { cache: "reload" });
    if (!res.ok) return null;
    const doc = await res.json();
    if (!doc || !Array.isArray(doc.files) || !doc.files.length) return null;
    return doc;
  } catch (err) {
    return null;
  }
}

/** "grid/1kmN3123E3881.json" -> "./data/grid/1kmN3123E3881.json" */
function dataUrlOf(rel) {
  return new URL("data/" + rel, self.location.href).href;
}

/**
 * A manifest entry may only ever be a plain relative path to a baked file
 * under web/data/. Anything carrying a scheme, an authority, a leading slash,
 * a backslash or a parent segment is refused and never fetched.
 *
 * This is the runtime half of the promise that the basemap is never precached
 * (THE TILE RULES, mechanism 2). bake.py already refuses to WRITE such an
 * entry; this refuses to ACT on one, so a manifest edited by hand, served from
 * a stale CDN copy or tampered with in transit still cannot make this worker
 * bulk-download tiles -- or anything else off-origin.
 */
function safeDataPath(rel) {
  return typeof rel === "string" && rel.length > 0 &&
    rel.indexOf(":") === -1 &&
    rel.indexOf("//") === -1 &&
    rel.indexOf("\\") === -1 &&
    rel.indexOf("..") === -1 &&
    rel.charAt(0) !== "/";
}

/**
 * Store every baked file the manifest names, in batches, tolerating failures.
 *
 * NOTHING in here may reject: install() awaits it, and a failed install leaves
 * the user with no worker at all. A shard that 404s, a quota error or a missing
 * manifest all degrade to the pre-existing lazy cache-first behaviour.
 *
 * @returns {Promise<{stored: number, total: number}>}
 */
async function precacheData() {
  const summary = { stored: 0, total: 0 };
  try {
    const doc = await readDataManifest();
    if (!doc) return summary;

    const cache = await caches.open(DATA);
    // Keep the manifest itself, so the page can report offline readiness with
    // no network of its own.
    await Promise.allSettled([cache.add(DATA_MANIFEST)]);

    // Filtered, not trusted; but `total` still counts what the manifest ASKED
    // for. A rejected entry is never fetched, so stored falls short of total
    // and the page reports itself not ready, which is the honest outcome for a
    // manifest that has been tampered with rather than a silently smaller one.
    const urls = doc.files.filter(safeDataPath).map(dataUrlOf);
    summary.total = doc.files.length;

    // Skip what is already stored: a shell-only redeploy must not re-download
    // 6 MB, and the DATA cache deliberately survives a new shell version.
    const present = new Set(
      (await cache.keys()).map((req) => req.url)
    );
    const missing = urls.filter((u) => !present.has(u));
    summary.stored = urls.length - missing.length;

    for (let i = 0; i < missing.length; i += PRECACHE_BATCH) {
      const batch = missing.slice(i, i + PRECACHE_BATCH);
      const results = await Promise.allSettled(batch.map((u) => cache.add(u)));
      for (const r of results) if (r.status === "fulfilled") summary.stored++;
    }
  } catch (err) {
    // Quota exceeded, storage denied, offline install: all survivable.
  }
  return summary;
}

/**
 * How much of the baked data is actually on this device.
 * The page asks for this to print an honest "stored offline" line rather than
 * promising an offline capability it may not have (PLAN section 11).
 */
async function dataStatus() {
  const out = { total: 0, stored: 0, cities: [], vintage: "", ready: false };
  try {
    const cache = await caches.open(DATA);
    const stored = new Set((await cache.keys()).map((req) => req.url));
    let doc = null;
    const cached = await cache.match(DATA_MANIFEST, { ignoreVary: true });
    if (cached) doc = await cached.json();
    if (!doc) doc = await readDataManifest();
    if (!doc) return out;

    out.vintage = doc.vintage || "";
    out.total = doc.files.length;
    for (const rel of doc.files) if (stored.has(dataUrlOf(rel))) out.stored++;

    for (const nis of doc.cities || []) {
      // A city's files are its own three documents plus every 1 km shard the
      // bake listed for it. Shards are shared between neighbouring cities, so
      // these per-city totals deliberately overlap and do not sum to the whole.
      const cells = new Set((doc.cells && doc.cells[nis]) || []);
      const want = doc.files.filter(
        (f) => f.indexOf(nis + "/") === 0 || cells.has(f));
      const have = want.filter((f) => stored.has(dataUrlOf(f))).length;
      out.cities.push({ nis, stored: have, total: want.length });
    }
    out.ready = out.total > 0 && out.stored >= out.total;
  } catch (err) {
    // An unreadable cache is reported as "nothing stored", never as an error.
  }
  return out;
}

/* ------------------------------------------------------------ activate */

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch (e) { /* not supported */ }
    }
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith("behere-") && KEEP.indexOf(k) === -1)
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

/* ------------------------------------------------------------- message */

self.addEventListener("message", (event) => {
  const data = event.data;
  if (data === "SKIP_WAITING" || (data && data.type === "SKIP_WAITING")) {
    self.skipWaiting();
    return;
  }
  if (data && data.type === "PURGE_DATA") {
    // A new data vintage was published. Drop the shards, then warm the new
    // ones straight away: purging without re-warming would leave the device
    // with LESS offline coverage than before the update.
    event.waitUntil(caches.delete(DATA).then(() => precacheData()));
    return;
  }
  if (data && data.type === "WARM_DATA") {
    // The install ran offline, or was interrupted. Try again on demand.
    event.waitUntil(precacheData().then((s) => reply(event, "DATA_WARMED", s)));
    return;
  }
  if (data && data.type === "DATA_STATUS") {
    event.waitUntil(dataStatus().then((s) => reply(event, "DATA_STATUS", s)));
    return;
  }
  if (data && data.type === "PURGE_TILES") {
    // "Clear the basemap", and the Save-Data path. ONLY the tiles go: a purge
    // that also dropped a shard would trade a decoration for a pilot city.
    event.waitUntil(purgeTiles().then((n) => reply(event, "TILES_PURGED", { removed: n })));
    return;
  }
  if (data && data.type === "TILE_STATUS") {
    event.waitUntil(tileStatus().then((s) => reply(event, "TILE_STATUS", s)));
  }
});

/** Answer on the MessagePort when there is one, otherwise broadcast. */
function reply(event, type, payload) {
  const message = Object.assign({ type }, payload);
  const port = event.ports && event.ports[0];
  if (port) {
    try { port.postMessage(message); return; } catch (err) { /* fall through */ }
  }
  return self.clients.matchAll({ includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      try { c.postMessage(message); } catch (err) { /* a closed client */ }
    }
  });
}

/* --------------------------------------------------------------- fetch */

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Navigations: network-first, then cache, then the offline page.
  if (req.mode === "navigate") {
    event.respondWith(handleNavigate(event));
    return;
  }

  // The OSM basemap. Cross-origin, opaque, RUNTIME-CACHED ONLY, capped and
  // evicted least-recently-used. Never precached: see THE TILE RULES above.
  if (url.host === TILE_HOST) {
    event.respondWith(tileResponse(event));
    return;
  }

  if (url.origin === self.location.origin) {
    if (url.href === TILE_INDEX_URL) {
      // Worker bookkeeping parked under a synthetic same-origin key. The shell
      // route below is a catch-all backed by caches.match(), which searches
      // EVERY cache, so without this the index would be servable as an asset.
      event.respondWith(new Response("", { status: 404 }));
      return;
    }
    if (isDataShard(url)) {
      event.respondWith(cacheFirst(req, DATA));       // shards, sector geometry
    } else if (isDataManifest(url)) {
      event.respondWith(networkFirst(req, DATA));     // meta.json must be fresh
    } else {
      event.respondWith(cacheFirst(req, SHELL));      // app shell
    }
    return;
  }

  if (TTL[url.host] !== undefined) {
    if (NETWORK_FIRST_HOSTS.has(url.host)) {
      event.respondWith(networkFirstLive(req));       // departures, statistics
    } else {
      event.respondWith(staleWhileRevalidate(event)); // POI layers
    }
  }
  // Anything else is not ours: let the browser handle it. The CSP would have
  // blocked it long before this point anyway.
});

/* ------------------------------------------------------------ handlers */

async function handleNavigate(event) {
  try {
    const preload = await event.preloadResponse;
    if (preload) {
      event.waitUntil(put(SHELL, event.request, preload.clone()));
      return preload;
    }
    const fresh = await fetch(event.request);
    event.waitUntil(put(SHELL, event.request, fresh.clone()));
    return fresh;
  } catch (err) {
    const cached = await caches.match(event.request, { ignoreSearch: true });
    if (cached) return cached;
    const shell = await caches.match("./index.html");
    if (shell) return shell;
    return (await caches.match("./offline.html")) ||
      new Response("Offline.", { status: 503, headers: { "content-type": "text/plain" } });
  }
}

/** Cache-first. The shell cache rotates per deploy and the data cache is
 *  purged on a new vintage, so nothing here can serve a stale generation. */
async function cacheFirst(req, cacheName) {
  const cached = await caches.match(req, { ignoreVary: true });
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (cacheable(res)) await put(cacheName, req, res.clone());
    return res;
  } catch (err) {
    return offlineJson(req);
  }
}

/** Network-first for same-origin JSON that must reflect the newest build. */
async function networkFirst(req, cacheName) {
  try {
    const res = await fetch(req);
    if (cacheable(res)) await put(cacheName, req, res.clone());
    return res;
  } catch (err) {
    const cached = await caches.match(req, { ignoreVary: true });
    return cached || offlineJson(req);
  }
}

/** Network-first for live departures and statistics.
 *  On failure the cached body is returned UNCHANGED, still carrying its
 *  x-behere-cached-at stamp, which is what lets the Go band say
 *  "Live departures unavailable. Showing the timetable, last updated {date}."
 *  instead of showing a spinner or an empty band. */
async function networkFirstLive(req) {
  try {
    const res = await fetch(req);
    if (cacheable(res)) await put(LIVE, req, res.clone());
    return res;
  } catch (err) {
    const cached = await caches.match(req, { ignoreVary: true });
    if (cached) return cached;
    return offlineJson(req);
  }
}

/** Stale-while-revalidate for the POI layers.
 *
 *  Inside the host's TTL the cached copy is returned and NO network call is
 *  made at all: these portals have per-portal daily quotas (250,000 / 100,000 /
 *  20,000) and panning around a city must not burn them. Past the TTL, the
 *  stale copy is still returned immediately and the refresh continues under
 *  waitUntil, so the worker is not killed mid-revalidation. */
async function staleWhileRevalidate(event) {
  const req = event.request;
  const cached = await caches.match(req, { ignoreVary: true });
  if (cached && !isExpired(req, cached)) return cached;

  const network = fetch(req)
    .then(async (res) => {
      if (cacheable(res)) await put(LIVE, req, res.clone());
      return res;
    })
    .catch(() => null);

  if (cached) {
    event.waitUntil(network);
    return cached;
  }
  return (await network) || offlineJson(req);
}

/* ----------------------------------------------------- basemap handlers */

/**
 * Stale-while-revalidate for one basemap tile, with a bounded, LRU-evicted
 * cache. THE TILE RULES at the top of this file are the why; this is the how.
 *
 * Inside TILE_TTL the stored tile is returned and NO network request is made
 * at all. Past it the stored tile is STILL returned immediately -- a week-old
 * street is a correct street -- and the refresh runs under waitUntil so the
 * worker is not killed mid-flight. Only a tile that has never been seen waits
 * on the network, and if that fails the <img> fires `error`, map.js counts it,
 * and three of them fold the basemap away and leave the vector map drawn from
 * baked shards (UI_SPEC 1.2). Nothing here can stop "where am I" answering.
 */
async function tileResponse(event) {
  const req = event.request;
  const key = req.url;
  let cache = null;
  let index = null;
  let cached = null;

  try {
    cache = await caches.open(TILES);
    index = await tileState(cache);
    cached = await cache.match(key);
  } catch (err) {
    // An unusable Cache Storage (private mode, quota, a racing purge) must not
    // take the basemap down with it: go straight to the network, store nothing.
    return (await fetchTile(req, null, null, key)) || tileUnavailable();
  }

  const now = Date.now();
  const entry = tileEntry(index, key);

  if (cached && (now - entry[0]) / 1000 <= TILE_TTL) {
    const worthWriting = now - entry[1] > TILE_TOUCH_MS;
    entry[1] = now;                   // an LRU touch. NOT entry[0]: looking at
    index[key] = entry;               // a tile does not make the picture newer
    // The touch is always recorded in memory, where it is free and where
    // eviction reads it, so the ordering stays exact. Writing it back is what
    // is throttled: a pan re-requests the same tiles several times a second,
    // and re-serialising a 300-entry index each time would cost more than the
    // basemap it is bookkeeping for. Worst case of a lost write is a tile
    // evicted slightly early, which costs one conditional request.
    if (worthWriting) event.waitUntil(persistTileIndex(cache, index));
    return cached;
  }

  if (saveDataOn()) {
    // Save-Data, or prefers-reduced-data: not one byte on decoration. A stored
    // tile is still shown, and a STALE stored tile is still shown too -- a
    // week-old street is a correct street and costs nothing -- but nothing is
    // fetched and nothing is revalidated. map.js stops asking as well; this is
    // the belt, and it keeps the rule true even if that changes.
    return cached || tileUnavailable();
  }

  const revalidating = fetchTile(req, cache, index, key);
  if (cached) {
    event.waitUntil(revalidating);
    return cached;
  }
  return (await revalidating) || tileUnavailable();
}

/**
 * Fetch one tile and store it. Never rejects; returns null when the network
 * could not answer at all.
 *
 * The fetch is deliberately PLAIN. No cache:"reload", no cache-buster: the
 * browser's HTTP cache still holds OSM's ETag, so a revalidation goes out
 * conditional and usually comes back 304 with no body. Forcing a reload would
 * turn every seven-day refresh into a full PNG download.
 */
async function fetchTile(req, cache, index, key) {
  let res = null;
  try {
    res = await fetch(req);
  } catch (err) {
    return null;                      // offline, DNS, blocked: the img errors
  }
  if (!cache || !index || !tileStorable(res)) return res;
  try {
    // cache.put, NOT put(): an opaque response cannot be re-wrapped to carry
    // an x-behere-cached-at header, and trying would store an empty body.
    // The timestamp goes in the sidecar index instead.
    await cache.put(key, res.clone());
    const at = Date.now();
    index[key] = [at, at];            // freshly fetched, and freshly used
    await evictTiles(cache, index);
    await persistTileIndex(cache, index);
  } catch (err) {
    // Quota, or a response Cache.put refuses. The tile still reaches the page.
  }
  return res;
}

function tileStorable(res) {
  if (!res) return false;
  // An <img> tile is a no-cors request, so a successful fetch comes back
  // OPAQUE: status 0, no readable headers, no readable body. That is storable
  // and it is the normal case. It also means a 404 tile cannot be told apart
  // from a real one; the TTL is what eventually clears such an entry and the
  // LRU cap is what bounds it meanwhile. A readable response (if the page ever
  // asks with crossorigin) is judged the usual way.
  if (res.type === "opaque") return true;
  return res.ok && res.status !== 206;
}

/** One index entry as [fetchedAtMs, lastUsedMs], normalised. Anything that is
 *  not a pair of numbers reads as [0, 0]: age unknown, therefore stale, and
 *  first in line for eviction. Erring old is the safe direction -- it costs a
 *  conditional request, where erring new would serve a tile for ever. */
function tileEntry(index, key) {
  const raw = index[key];
  if (Array.isArray(raw) && typeof raw[0] === "number" && typeof raw[1] === "number") {
    return [raw[0], raw[1]];
  }
  return [0, 0];
}

/** Hydrate the tile index once per worker lifetime, reconciling it against
 *  what is really stored. A tile in the cache but not the index is adopted
 *  as [0, 0], i.e. "age unknown, therefore stale": it counts against the cap
 *  immediately and revalidates the next time it is looked at. */
async function tileState(cache) {
  if (tileIndex) return tileIndex;
  if (!tileIndexLoad) {
    tileIndexLoad = (async () => {
      let index = {};
      try {
        const hit = await cache.match(TILE_INDEX_URL);
        if (hit) {
          const doc = await hit.json();
          if (doc && doc.tiles && typeof doc.tiles === "object") index = doc.tiles;
        }
      } catch (err) {
        index = {};                   // an unreadable index is not an error
      }
      try {
        const live = new Set();
        for (const stored of await cache.keys()) {
          if (stored.url === TILE_INDEX_URL) continue;
          live.add(stored.url);
          index[stored.url] = tileEntry(index, stored.url);
        }
        for (const url of Object.keys(index)) {
          if (!live.has(url)) delete index[url];
        }
      } catch (err) {
        // Reconciliation is best effort; the cap is still enforced on what we
        // do know about.
      }
      tileIndex = index;
      return index;
    })();
  }
  return tileIndexLoad;
}

/** Drop least-recently-USED tiles until the cache is back inside TILE_MAX.
 *  Sorted on [1], last used, so the street you keep walking down outlives the
 *  one you passed through once a month ago. Ties break on the URL, so the
 *  eviction is deterministic and therefore testable. */
async function evictTiles(cache, index) {
  const urls = Object.keys(index);
  if (urls.length <= TILE_MAX) return 0;
  urls.sort((a, b) =>
    (tileEntry(index, a)[1] - tileEntry(index, b)[1]) ||
    (a < b ? -1 : a > b ? 1 : 0));
  const drop = urls.slice(0, urls.length - TILE_MAX);
  for (const url of drop) {
    try { await cache.delete(url); } catch (err) { /* already gone */ }
    delete index[url];
  }
  return drop.length;
}

/** Write the index back, serialised and coalescing: concurrent callers queue
 *  behind one write, and a queued write that has already been superseded skips
 *  itself. A lost write only makes a tile look older than it is. */
function persistTileIndex(cache, index) {
  tileIndexDirty = true;
  tileIndexWrite = tileIndexWrite.then(async () => {
    if (!tileIndexDirty) return;
    tileIndexDirty = false;
    try {
      await cache.put(TILE_INDEX_URL, new Response(
        JSON.stringify({ v: 1, max: TILE_MAX, ttl: TILE_TTL, tiles: index }),
        { headers: { "content-type": "application/json" } }
      ));
    } catch (err) {
      // Quota, or the cache was purged underneath us. Bookkeeping, not data.
    }
  });
  return tileIndexWrite;
}

/** Drop the basemap and its index. Baked shards are untouched: turning the
 *  map off must never cost someone the city they carry around offline. */
async function purgeTiles() {
  let removed = 0;
  try {
    removed = Object.keys(tileIndex || {}).length;
    await caches.delete(TILES);
  } catch (err) {
    // Nothing to do; the next open() makes a fresh, empty cache.
  }
  tileIndex = null;
  tileIndexLoad = null;
  tileIndexDirty = false;
  return removed;
}

/** What the basemap is costing this device, so the UI can say it out loud. */
async function tileStatus() {
  const out = { host: TILE_HOST, stored: 0, max: TILE_MAX, ttl: TILE_TTL, oldest: 0 };
  try {
    const cache = await caches.open(TILES);
    const index = await tileState(cache);
    const urls = Object.keys(index);
    out.stored = urls.length;
    for (const url of urls) {
      const at = tileEntry(index, url)[0];
      if (!out.oldest || at < out.oldest) out.oldest = at;
    }
  } catch (err) {
    // Report zero rather than throw: this feeds a line of copy, not a decision.
  }
  return out;
}

/** True when the user has asked the platform to spend less data. `navigator`
 *  is read defensively because it is absent in the headless test harness and
 *  NetworkInformation is not implemented everywhere. */
function saveDataOn() {
  try {
    if (typeof navigator === "undefined") return false;
    const conn = navigator.connection;
    return !!(conn && conn.saveData);
  } catch (err) {
    return false;
  }
}

/* --------------------------------------------------------------- utils */

function isDataShard(url) {
  return /\/data\/(grid\/|[0-9]{5}\/|i18n\/)/.test(url.pathname) ||
    url.pathname.endsWith(".geojson");
}

function isDataManifest(url) {
  // precache.json is in this list, not in isDataShard: it is the index of what
  // to store, so serving a stale one would precache the previous release's
  // shard list. Network-first, DATA cache, so it still answers offline.
  return /\/data\/(meta|municipalities|nis_history|precache)\.json$/.test(url.pathname);
}

function cacheable(res) {
  // 206 is deliberately excluded: Cache.put throws a TypeError on a partial
  // response, and Statbel's exact-count probe (Prefer: count=exact + Range)
  // returns 206. Its count lives in a header the caller reads directly.
  return res && res.ok && res.status !== 206;
}

/** Store a response with the moment it was fetched, so every layer can state
 *  the age of what it is showing (CONTRACT 10.0). */
async function put(cacheName, req, res) {
  if (!cacheable(res)) return;
  try {
    const headers = new Headers(res.headers);
    headers.set(STAMP, new Date().toISOString());
    const body = await res.blob();
    const cache = await caches.open(cacheName);
    await cache.put(req, new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    }));
  } catch (err) {
    // Quota, an opaque response, or a partial: not worth failing the request.
  }
}

function isExpired(req, res) {
  const ttl = TTL[new URL(req.url).host];
  if (ttl === undefined) return false;
  const at = res.headers.get(STAMP);
  if (!at) return true;
  return (Date.now() - Date.parse(at)) / 1000 > ttl;
}

/** Last resort for a tile with nothing cached and no network, or one refused
 *  under Save-Data. A 504 makes the <img> fire `error`, which is precisely
 *  what map.js counts: three of them and the basemap folds away, leaving the
 *  vector map. Failing loudly here is what keeps that degradation honest. */
function tileUnavailable() {
  return new Response("", {
    status: 504,
    headers: { "content-type": "text/plain" },
  });
}

/** Last resort for a JSON request with nothing cached. A structured body beats
 *  a network error: the caller can name the layer that is missing rather than
 *  render a blank card. */
function offlineJson(req) {
  return new Response(
    JSON.stringify({ offline: true, url: req.url }),
    { status: 503, headers: { "content-type": "application/json", [STAMP]: "" } }
  );
}
