/* BeHERE service worker.
 *
 * NEVER RENAME THIS FILE. Browsers byte-compare the service worker URL; a
 * versioned or hashed name means an update is never fetched, and the recovery
 * path for a bad worker is to overwrite THIS exact URL with kill-sw.js.
 *
 * Caching, straight from PLAN section 6:
 *
 *   cache-first ............. hashed shards, sector geometry, app shell
 *   network-first ........... navigations, statistics, live departures
 *   stale-while-revalidate .. POI layers
 *   offline fallback ........ last-known departures with an explicit "as of"
 *
 * Three caches, because they have three different lifetimes:
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
 * There is no key, token or credential anywhere in this file, because there is
 * none to have: all nine runtime hosts are keyless (acceptance test 7).
 */

const VERSION = "__CACHE_VERSION__";
const SHELL = "behere-shell-" + VERSION;
const DATA = "behere-data-v1";
const LIVE = "behere-live-v1";
const KEEP = [SHELL, DATA, LIVE];

/* The app shell. Precache LESS rather than more: this is the shell only, no
 * data, no full icon set. If one of these 404s the install fails and the user
 * simply has no worker, which is the correct outcome for a broken shell. */
const SHELL_REQUIRED = [
  "./",
  "./index.html",
  "./offline.html",
  "./manifest.webmanifest",
  "./app/app.css",
  "./app/main.js",
  "./app/grid.js",
  "./app/geo.js",
  "./app/i18n.js",
  "./app/stats.js",
  "./app/sw-register.js",
  "./app/offline.js",
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

/* ------------------------------------------------------------- install */

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await cache.addAll(SHELL_REQUIRED);
    await Promise.allSettled(SHELL_OPTIONAL.map((u) => cache.add(u)));
    // The seven cities, stored before they are ever asked for, so a cold cache
    // in airplane mode still answers "where am I" (PLAN phase 1, test 1).
    await precacheData();
    // Do NOT skipWaiting here: the page prompts, then posts SKIP_WAITING.
  })());
});

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

    const urls = doc.files.map(dataUrlOf);
    summary.total = urls.length;

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

  if (url.origin === self.location.origin) {
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

/** Last resort for a JSON request with nothing cached. A structured body beats
 *  a network error: the caller can name the layer that is missing rather than
 *  render a blank card. */
function offlineJson(req) {
  return new Response(
    JSON.stringify({ offline: true, url: req.url }),
    { status: 503, headers: { "content-type": "application/json", [STAMP]: "" } }
  );
}
