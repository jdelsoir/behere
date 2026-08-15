/**
 * BeHERE geo layer.
 *
 * Four responsibilities, nothing else:
 *
 *   1. Geolocation, debounced. Event driven, never polled (acceptance test 9).
 *   2. Haversine distance in metres, and nearest-of ranking.
 *   3. The 9-cell grid read, centre cell first (CONTRACT 7.5).
 *   4. A fetch helper with per-source cache TTL, timeout, in-flight dedupe and
 *      stale-while-revalidate (CONTRACT 10.0).
 *
 * Plain ES module. No build step, no bundler, no CDN, no dependencies beyond
 * ./grid.js, which is the verified twin of scripts/grid.py.
 *
 * Everything here works offline from baked shards alone. The only functions
 * that touch the network are fetchJSON and dataJSON, and every baked read
 * goes through the service worker's cache-first rule.
 *
 * CONTRACT.md is authoritative for every wire shape decoded below.
 */

import { wgs84ToCell, neighbours, parseCell, formatCell, cellBounds3035 } from "./grid.js";

// Re-exported so a consumer needs one import, not two.
export { wgs84ToCell, neighbours, parseCell, formatCell, cellBounds3035 };

// ---------------------------------------------------------------------------
// 0. Where the data lives
// ---------------------------------------------------------------------------

/**
 * Resolved from this module's own URL, so the base path is never hardcoded.
 * At https://user.github.io/behere/app/geo.js this yields
 * https://user.github.io/behere/data/ , which is exactly the /behere/ scope.
 */
export const DATA_BASE = new URL("../data/", import.meta.url);

/** "grid/1kmN3126E3927.json" -> absolute URL under DATA_BASE. */
export function dataUrl(path) {
  return new URL(path, DATA_BASE).href;
}

// ---------------------------------------------------------------------------
// 1. Cache TTLs, one per source, straight from CONTRACT 10
// ---------------------------------------------------------------------------

/**
 * Milliseconds. `baked` is Infinity because every baked file is pinned to the
 * 2025-01-01 vintage: within one release its bytes never change, so a cached
 * shard is never wrong. A new release ships a new service worker.
 */
export const TTL = Object.freeze({
  baked: Infinity,
  irail: 30 * 1000,             // 10.1 liveboard
  gtfs_rt: 30 * 1000,           // 10.2 realtime
  statbel_hvd: 24 * 3600 * 1000, // 10.3
  opendatasoft: 3600 * 1000,    // 10.4
  wallonia_tourism: 6 * 3600 * 1000, // 10.5
  erfgoed: 6 * 3600 * 1000,     // 10.6
  brussels_catalog: 24 * 3600 * 1000, // 10.7
});

/** Default network timeout. A slow source must degrade, never hang a band. */
export const TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// 2. The fetch helper
// ---------------------------------------------------------------------------

/** key -> {at, data, status, notFound} */
const _cache = new Map();
/** key -> Promise<FetchResult> */
const _inflight = new Map();

/**
 * Acceptance test 7 in executable form. The repo is public and no BeHERE
 * source needs a credential, so a credential in a request is a bug, and a
 * loud throw is cheaper to find than a silent leak.
 */
const SECRET_PARAM = /[?&](api[-_]?key|apikey|key|token|access[-_]?token|auth|secret|password|signature)=/i;
const SECRET_HEADER = /^(authorization|x-api-key|x-auth-token|proxy-authorization)$/i;

function assertKeyless(url, headers) {
  const m = SECRET_PARAM.exec(String(url));
  if (m) {
    throw new Error(
      "BeHERE sends no credentials. Refusing a URL carrying '" + m[1] + "=': " + url
    );
  }
  if (headers) {
    for (const k of Object.keys(headers)) {
      if (SECRET_HEADER.test(k)) {
        throw new Error("BeHERE sends no credentials. Refusing header '" + k + "'.");
      }
    }
  }
}

/**
 * @typedef {Object} FetchResult
 * @property {boolean} ok         True when `data` is usable, fresh or stale.
 * @property {number}  status     HTTP status, 0 when the request never landed.
 * @property {*}       data       Parsed JSON, or null.
 * @property {number}  at         Epoch ms the data was fetched. 0 when absent.
 * @property {boolean} stale      True when served past its TTL.
 * @property {boolean} fromCache  True when no network was touched for this call.
 * @property {boolean} notFound   True on 404. Distinct from an error.
 * @property {boolean} aborted    True when the caller's signal fired.
 * @property {Error|null} error   Network or parse failure.
 * @property {Promise<FetchResult>|null} revalidating  Set when stale data was
 *           returned and a background refresh is running.
 */

const EMPTY = Object.freeze({
  ok: false, status: 0, data: null, at: 0, stale: false,
  fromCache: false, notFound: false, aborted: false, error: null, revalidating: null,
});

function result(patch) {
  return Object.assign({}, EMPTY, patch);
}

/**
 * One network round trip. No caching logic, no credentials, ever.
 * @param {string} url
 * @param {{timeoutMs?: number, headers?: Object, signal?: AbortSignal}} opts
 * @returns {Promise<FetchResult>}
 */
async function network(url, opts = {}) {
  const { timeoutMs = TIMEOUT_MS, headers, signal } = opts;
  assertKeyless(url, headers);

  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) return result({ aborted: true });
    signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => ctl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: headers || undefined,
      signal: ctl.signal,
    });
    if (res.status === 404) {
      return result({ status: 404, notFound: true, at: Date.now() });
    }
    if (!res.ok) {
      return result({ status: res.status, error: new Error("HTTP " + res.status + " for " + url) });
    }
    const data = await res.json();
    return result({ ok: true, status: res.status, data, at: Date.now() });
  } catch (err) {
    const aborted = err && err.name === "AbortError";
    if (aborted && signal && signal.aborted) return result({ aborted: true });
    return result({ error: aborted ? new Error("Timed out after " + timeoutMs + " ms: " + url) : err });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Cached JSON GET.
 *
 * Fresh cache hit  -> returns immediately, no network.
 * Stale cache hit  -> returns the stale copy immediately and revalidates in the
 *                     background (CONTRACT 10.0: "serve stale immediately and
 *                     revalidate"). `stale` and `at` let the UI say "as of X".
 * Miss             -> awaits the network. Concurrent misses share one request.
 *
 * @param {string} url
 * @param {{ttl?: number, timeoutMs?: number, headers?: Object,
 *          signal?: AbortSignal, key?: string, allowStale?: boolean}} opts
 * @returns {Promise<FetchResult>}
 */
export async function fetchJSON(url, opts = {}) {
  const {
    ttl = 0, timeoutMs = TIMEOUT_MS, headers, signal,
    key = url, allowStale = true,
  } = opts;

  const hit = _cache.get(key);
  const now = Date.now();

  if (hit) {
    const fresh = ttl === Infinity || now - hit.at < ttl;
    if (fresh) {
      return result({
        ok: !hit.notFound, status: hit.status, data: hit.data, at: hit.at,
        fromCache: true, notFound: hit.notFound,
      });
    }
    if (allowStale) {
      const revalidating = run(url, { timeoutMs, headers, key });
      revalidating.catch(() => {});
      return result({
        ok: !hit.notFound, status: hit.status, data: hit.data, at: hit.at,
        stale: true, fromCache: true, notFound: hit.notFound, revalidating,
      });
    }
  }

  return run(url, { timeoutMs, headers, key, signal });
}

/** Single-flight wrapper around network(), writing the cache on success. */
function run(url, { timeoutMs, headers, key, signal }) {
  const pending = _inflight.get(key);
  if (pending) return pending;

  const p = network(url, { timeoutMs, headers, signal })
    .then((r) => {
      if (r.ok || r.notFound) {
        _cache.set(key, { at: r.at, data: r.data, status: r.status, notFound: r.notFound });
      }
      return r;
    })
    .finally(() => {
      _inflight.delete(key);
    });

  _inflight.set(key, p);
  return p;
}

/** Baked file under web/data/. Cache-first forever: the vintage is pinned. */
export function dataJSON(path, opts = {}) {
  return fetchJSON(dataUrl(path), Object.assign({ ttl: TTL.baked }, opts));
}

/** Drop everything cached in memory. The service worker cache is untouched. */
export function clearCache() {
  _cache.clear();
  _shards.clear();
}

// ---------------------------------------------------------------------------
// 3. Distance
// ---------------------------------------------------------------------------

/** IUGG mean Earth radius, metres. */
const R_EARTH = 6371008.8;
const DEG = Math.PI / 180;

/**
 * Great-circle distance in metres. This is the distance the UI prints.
 * @param {number} lat1 @param {number} lon1 @param {number} lat2 @param {number} lon2
 * @returns {number} metres
 */
export function haversineMetres(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);
  const a = s1 * s1 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * s2 * s2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Initial bearing in degrees clockwise from north. Used by Around and Go to
 * say "north-east of you"; the Here band does not need it.
 */
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * DEG, p2 = lat2 * DEG;
  const dl = (lon2 - lon1) * DEG;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

/**
 * Squared planar distance in square metres, cheap enough to rank tens of
 * thousands of candidates. Exact enough over a 3 km neighbourhood; the winner
 * is then measured with haversineMetres, which is what gets displayed.
 */
function planarSq(lat, lon, cosLat, blat, blon) {
  const dy = (blat - lat) * 111320;
  const dx = (blon - lon) * 111320 * cosLat;
  return dy * dy + dx * dx;
}

/**
 * Nearest item, by true haversine distance.
 * @param {number} lat @param {number} lon
 * @param {Array<{lat:number, lon:number}>} items
 * @param {{maxMetres?: number}} [opts]
 * @returns {{item: Object, distanceM: number}|null}
 */
export function nearest(lat, lon, items, opts = {}) {
  const { maxMetres = Infinity } = opts;
  const cosLat = Math.cos(lat * DEG);
  let best = null, bestSq = Infinity;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const d = planarSq(lat, lon, cosLat, it.lat, it.lon);
    if (d < bestSq) { bestSq = d; best = it; }
  }
  if (!best) return null;
  const distanceM = haversineMetres(lat, lon, best.lat, best.lon);
  if (distanceM > maxMetres) return null;
  return { item: best, distanceM };
}

/**
 * The k nearest items, ascending by distance.
 * @returns {Array<{item: Object, distanceM: number}>}
 */
export function nearestN(lat, lon, items, opts = {}) {
  const { limit = 10, maxMetres = Infinity } = opts;
  const cosLat = Math.cos(lat * DEG);
  const maxSq = maxMetres === Infinity ? Infinity : (maxMetres * 1.2) ** 2;
  const ranked = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const d = planarSq(lat, lon, cosLat, it.lat, it.lon);
    if (d <= maxSq) ranked.push({ item: it, sq: d });
  }
  ranked.sort((a, b) => a.sq - b.sq);
  const out = [];
  for (const r of ranked) {
    const distanceM = haversineMetres(lat, lon, r.item.lat, r.item.lon);
    if (distanceM <= maxMetres) out.push({ item: r.item, distanceM });
    if (out.length >= limit) break;
  }
  out.sort((a, b) => a.distanceM - b.distanceM);
  return out;
}

/**
 * "18 m" / "1.2 km". Locale-aware digits, no dependency.
 * @param {number} metres @param {string} [lang] "nl" | "fr" | "en"
 */
export function formatDistance(metres, lang = "en") {
  if (!Number.isFinite(metres)) return "";
  if (metres < 1000) {
    return new Intl.NumberFormat(lang).format(Math.round(metres)) + " m";
  }
  return new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }).format(metres / 1000) + " km";
}

// ---------------------------------------------------------------------------
// 4. Grid shards: read and decode
// ---------------------------------------------------------------------------

/** cell id -> decoded shard (or null for a cell with no baked data). */
const _shards = new Map();

/**
 * @typedef {Object} Address
 * @property {number} streetId  Join key into <nis>/streets.json
 * @property {number|string} house  House number. Not a number: "225A" is real.
 * @property {number} lat @property {number} lon
 * @property {string} sector  2025 sector code, "" when the source had none.
 * @property {string} zip     Postcode. Display only, never a municipality key.
 * @property {string} nis     Municipality, from the shard's own `m` table.
 * @property {string} cell
 */

/**
 * @typedef {Object} Shard
 * @property {string} cell @property {string} vintage
 * @property {number[]} origin  [lat, lon] in 1e-5 degree units
 * @property {string[]} municipalities
 * @property {Address[]} addresses
 * @property {Array<Object>} stops
 * @property {Array<Object>} poi
 * @property {Object|null} foreign  NIS -> address count, for municipalities
 *           present in this square but not shipped in this release (7.4).
 */

/**
 * Decode one grid shard per CONTRACT 7.2 and 7.3.
 * Every delta column is a running sum. Absent keys mean absent layers, never
 * empty ones, which is what makes "never render an empty panel" mechanical.
 * @param {Object} raw @returns {Shard|null}
 */
export function decodeShard(raw) {
  if (!raw || typeof raw !== "object") return null;

  const o = Array.isArray(raw.o) ? raw.o : [0, 0];
  const oy = o[0], ox = o[1];
  const m = Array.isArray(raw.m) ? raw.m : [];

  /** @type {Shard} */
  const out = {
    cell: typeof raw.c === "string" ? raw.c : "",
    vintage: typeof raw.v === "string" ? raw.v : "",
    origin: [oy, ox],
    municipalities: m,
    addresses: [],
    stops: [],
    poi: [],
    foreign: raw.fm && typeof raw.fm === "object" ? raw.fm : null,
  };

  const a = raw.a;
  if (a && a.n > 0 && Array.isArray(a.y) && Array.isArray(a.x)) {
    const n = a.n;
    const sc = Array.isArray(a.sc) ? a.sc : [];
    const zt = Array.isArray(a.zt) ? a.zt : [];
    const hasMi = Array.isArray(a.mi);
    const st = Array.isArray(a.st) ? a.st : null;
    const sIdx = Array.isArray(a.s) ? a.s : null;
    const zIdx = Array.isArray(a.z) ? a.z : null;
    const h = Array.isArray(a.h) ? a.h : null;

    let accSt = 0, accY = 0, accX = 0, accS = 0, accZ = 0, accM = 0;
    for (let i = 0; i < n; i++) {
      if (st) accSt += st[i];
      accY += a.y[i];
      accX += a.x[i];
      if (sIdx) accS += sIdx[i];
      if (zIdx) accZ += zIdx[i];
      if (hasMi) accM += a.mi[i];
      out.addresses.push({
        streetId: accSt,
        house: h ? h[i] : "",
        lat: (oy + accY) / 1e5,
        lon: (ox + accX) / 1e5,
        sector: sc[accS] !== undefined ? sc[accS] : "",
        zip: zt[accZ] !== undefined ? zt[accZ] : "",
        nis: hasMi ? (m[accM] || "") : (m[0] || ""),
        cell: out.cell,
      });
    }
  }

  if (Array.isArray(raw.t)) {
    for (const s of raw.t) {
      out.stops.push({
        operator: s.o,
        id: s.i,
        name: s.n,
        translations: s.t || null,   // authored NL/FR/DE from translations.txt
        parent: s.ps || null,        // for NMBS this is the iRail station key
        lat: (oy + s.y) / 1e5,       // stop offsets are absolute, not deltas
        lon: (ox + s.x) / 1e5,
        cell: out.cell,
      });
    }
  }

  // `p` is reserved for the Phase 2 baked POI layer and is not yet pinned in
  // the contract. Decode defensively: carry the object through, and lift
  // offsets to absolute coordinates when they are present.
  if (Array.isArray(raw.p)) {
    for (const p of raw.p) {
      const item = Object.assign({}, p, { cell: out.cell });
      if (typeof p.y === "number" && typeof p.x === "number") {
        item.lat = (oy + p.y) / 1e5;
        item.lon = (ox + p.x) / 1e5;
      }
      out.poi.push(item);
    }
  }

  return out;
}

/**
 * Read and decode one grid shard.
 * A cell with no baked data 404s, and that is a normal answer, not an error:
 * it resolves to null and the null is cached, so it is asked for once.
 * @param {string} cellId @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<Shard|null>}
 */
export async function readCell(cellId, opts = {}) {
  if (_shards.has(cellId)) return _shards.get(cellId);
  const r = await dataJSON("grid/" + cellId + ".json", { signal: opts.signal });
  if (r.aborted) return null;
  const shard = r.ok && r.data ? decodeShard(r.data) : null;
  if (r.ok || r.notFound) _shards.set(cellId, shard);
  return shard;
}

/**
 * The 9-cell read.
 *
 * CONTRACT 7.5: the worst 9-cell read is 629 KB raw, so first paint must never
 * block on all nine. Both promises start at once; `centre` settles first and
 * answers "where am I", `all` corrects it within about 50 m of a cell edge.
 *
 * @param {number} lat @param {number} lon
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {{cell: string, cells: string[],
 *            centre: Promise<Shard|null>, all: Promise<Shard[]>}}
 */
export function readCellsAround(lat, lon, opts = {}) {
  const cell = wgs84ToCell(lat, lon);
  const cells = neighbours(cell);           // self first, then the ring
  const reads = cells.map((id) => readCell(id, opts));
  return {
    cell,
    cells,
    centre: reads[0],
    all: Promise.all(reads).then((list) => list.filter(Boolean)),
  };
}

/** Flatten decoded shards into one address list. */
export function addressesOf(shards) {
  const out = [];
  for (const s of shards) if (s) for (const a of s.addresses) out.push(a);
  return out;
}

/** Flatten decoded shards into one stop list. */
export function stopsOf(shards) {
  const out = [];
  for (const s of shards) if (s) for (const t of s.stops) out.push(t);
  return out;
}

/**
 * Merge the `fm` tables of several shards.
 * @returns {Object} NIS -> address count, for municipalities in these squares
 *          that this release does not ship.
 */
export function foreignOf(shards) {
  const out = {};
  for (const s of shards) {
    if (!s || !s.foreign) continue;
    for (const [nis, n] of Object.entries(s.foreign)) {
      out[nis] = (out[nis] || 0) + (typeof n === "number" ? n : 0);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5. Baked municipality files
// ---------------------------------------------------------------------------

/** web/data/meta.json, the root manifest and the source list (CONTRACT 2). */
export function readRootMeta(opts = {}) {
  return dataJSON("meta.json", opts);
}

/** web/data/municipalities.json (CONTRACT 3). */
export function readMunicipalities(opts = {}) {
  return dataJSON("municipalities.json", opts);
}

/** web/data/nis_history.json (CONTRACT 3). Needed by the statistics bands. */
export function readNisHistory(opts = {}) {
  return dataJSON("nis_history.json", opts);
}

/** web/data/<nis>/meta.json (CONTRACT 4). */
export function readMunicipalityMeta(nis, opts = {}) {
  return dataJSON(nis + "/meta.json", opts);
}

/** web/data/i18n/en.json, the curated override (CONTRACT 8). */
export function readOverride(opts = {}) {
  return dataJSON("i18n/en.json", opts);
}

/** nis -> Map(streetId -> {nl?, fr?, de?}) */
const _streets = new Map();

/**
 * Read <nis>/streets.json and expand the parallel arrays (CONTRACT 5).
 * A language key is absent when no street in the municipality is authored in
 * it (Ghent ships no `de`), so a consumer must never assume all three exist.
 * @returns {Promise<Map<number, {nl?: string, fr?: string, de?: string}>|null>}
 */
export async function readStreets(nis, opts = {}) {
  if (_streets.has(nis)) return _streets.get(nis);
  const r = await dataJSON(nis + "/streets.json", opts);
  if (r.aborted) return null;
  if (!r.ok || !r.data) {
    if (r.notFound) _streets.set(nis, null);
    return null;
  }
  const s = r.data;
  const map = new Map();
  const ids = Array.isArray(s.id) ? s.id : [];
  let acc = 0;
  for (let i = 0; i < ids.length; i++) {
    acc += ids[i];
    const names = {};
    for (const lang of ["nl", "fr", "de"]) {
      const arr = s[lang];
      if (Array.isArray(arr) && arr[i]) names[lang] = arr[i];
    }
    // Street ids repeat across a municipality only when the source repeats
    // them; last write wins, which matches the file's own ordering.
    map.set(acc, names);
  }
  _streets.set(nis, map);
  return map;
}

/** nis -> FeatureCollection */
const _sectors = new Map();

/**
 * Read <nis>/sector.geojson (CONTRACT 6). Valid GeoJSON, handed to a map
 * component unchanged. Every geometry is a MultiPolygon, including single-part
 * sectors, so consumers need one code path.
 * @returns {Promise<Object|null>}
 */
export async function readSectors(nis, opts = {}) {
  if (_sectors.has(nis)) return _sectors.get(nis);
  const r = await dataJSON(nis + "/sector.geojson", opts);
  if (r.aborted) return null;
  const fc = r.ok && r.data && Array.isArray(r.data.features) ? r.data : null;
  if (r.ok || r.notFound) _sectors.set(nis, fc);
  return fc;
}

// ---------------------------------------------------------------------------
// 6. Point in polygon
// ---------------------------------------------------------------------------

/**
 * Ray casting against one linear ring. Ring is GeoJSON order: [lon, lat].
 * @param {number} lat @param {number} lon @param {Array<number[]>} ring
 */
export function pointInRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat)) {
      const xInt = xi + ((lat - yi) * (xj - xi)) / (yj - yi);
      if (lon < xInt) inside = !inside;
    }
  }
  return inside;
}

/** One MultiPolygon: outer ring wins, holes subtract. */
function pointInMultiPolygon(lat, lon, coords) {
  for (const polygon of coords) {
    if (!Array.isArray(polygon) || !polygon.length) continue;
    if (!pointInRing(lat, lon, polygon[0])) continue;
    let inHole = false;
    for (let h = 1; h < polygon.length; h++) {
      if (pointInRing(lat, lon, polygon[h])) { inHole = true; break; }
    }
    if (!inHole) return true;
  }
  return false;
}

/**
 * The statistical sector a position is standing in.
 *
 * This is the sector polygon path of the resolve rule: position to sector, and
 * therefore to the municipality that owns the file, with no postcode anywhere
 * in the chain. It is a refinement over the nearest address record, because
 * the nearest address can sit across a sector boundary.
 *
 * Note that the geometry is simplified to the tolerance recorded in
 * <nis>/meta.json.sector_tolerance_m, so within a few metres of a boundary
 * this answer is approximate. The UI says which tolerance was used.
 *
 * @param {number} lat @param {number} lon @param {Object} featureCollection
 * @returns {Object|null} the GeoJSON feature, or null
 */
export function findSectorAt(lat, lon, featureCollection) {
  if (!featureCollection || !Array.isArray(featureCollection.features)) return null;
  for (const f of featureCollection.features) {
    const g = f && f.geometry;
    if (!g || !Array.isArray(g.coordinates)) continue;
    if (g.type === "MultiPolygon") {
      if (pointInMultiPolygon(lat, lon, g.coordinates)) return f;
    } else if (g.type === "Polygon") {
      if (pointInMultiPolygon(lat, lon, [g.coordinates])) return f;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 7. Geolocation, debounced
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Fix
 * @property {number} lat @property {number} lon
 * @property {number} accuracy  Metres, 1-sigma, as reported by the device.
 * @property {number} at        Epoch ms.
 * @property {"device"|"manual"} source
 */

/**
 * @typedef {Object} GeoError
 * @property {"unsupported"|"denied"|"unavailable"|"timeout"} kind
 * @property {number} code  The raw PositionError code, or 0.
 * @property {string} message
 */

const DEFAULT_WATCH = Object.freeze({
  /** Trailing debounce after the last raw fix. */
  debounceMs: 1200,
  /**
   * Hard ceiling on how long a fix may sit in the debounce.
   *
   * Browsers fire watchPosition roughly once a second while the device is
   * MOVING, and a purely trailing debounce re-arms on every one of them. With
   * a 1200 ms debounce and a 1 Hz stream the timer was cleared before it could
   * ever fire, so a walking user saw the first fix and then nothing until they
   * stood still. A debounce with no maximum wait is a debounce that starves.
   */
  maxWaitMs: 5000,
  /** Floor between two emitted positions, whatever the device does. */
  minIntervalMs: 10000,
  /** Below this, the answer cannot have changed, so do not re-resolve. */
  minMoveMetres: 25,
  /** Accept a device fix cached this recently. */
  maximumAge: 30000,
  /** Give up on a single fix after this long. */
  timeout: 15000,
  enableHighAccuracy: true,
});

/**
 * Watch the device position, debounced.
 *
 * Acceptance test 9 in one paragraph: this is event driven. It calls
 * navigator.geolocation.watchPosition once and lets the platform push fixes.
 * There is no setInterval anywhere in this module, and the single setTimeout
 * below is a one-shot trailing debounce that is cleared on every new fix and
 * on stop(). A stationary device therefore causes zero work after its first
 * accepted fix.
 *
 * Three gates decide whether a raw fix becomes an emitted position:
 *   1. The first accepted fix emits immediately, so a cold start is not slow.
 *   2. After that, a trailing debounce collapses a burst of fixes into one.
 *   3. An emitted position must be minMoveMetres away from the last one, or
 *      materially more accurate (accuracy at least halved). Otherwise it is
 *      dropped, because re-resolving would produce the same band.
 *
 * @param {{onPosition: (fix: Fix) => void,
 *          onError?: (e: GeoError) => void,
 *          onRawFix?: (fix: Fix) => void}} handlers
 * @param {Partial<typeof DEFAULT_WATCH>} [options]
 * @returns {{stop: () => void, push: (lat: number, lon: number, accuracy?: number) => void,
 *            last: () => Fix|null}}
 */
export function watchPosition(handlers, options = {}) {
  const opt = Object.assign({}, DEFAULT_WATCH, options);
  const onPosition = handlers.onPosition || (() => {});
  const onError = handlers.onError || (() => {});
  const onRawFix = handlers.onRawFix || null;

  let watchId = null;
  let timer = null;        // trailing debounce; cleared by every new raw fix
  let floorTimer = null;   // the minIntervalMs floor; NEVER cleared by a fix
  let pending = null;      // newest raw fix not yet emitted
  let pendingSince = 0;    // when the oldest un-emitted fix arrived
  let emitted = null;      // last fix handed to onPosition
  let stopped = false;

  function clearTimers() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (floorTimer) { clearTimeout(floorTimer); floorTimer = null; }
  }

  function emit(fix) {
    emitted = fix;
    pending = null;
    pendingSince = 0;
    clearTimers();
    onPosition(fix);
  }

  function flush() {
    timer = null;
    if (stopped || !pending) return;
    const fix = pending;
    if (emitted) {
      const moved = haversineMetres(emitted.lat, emitted.lon, fix.lat, fix.lon);
      const sharper = fix.accuracy > 0 && emitted.accuracy > 0 &&
        fix.accuracy <= emitted.accuracy / 2;
      const since = fix.at - emitted.at;
      if (moved < opt.minMoveMetres && !sharper) { pending = null; pendingSince = 0; return; }
      if (since < opt.minIntervalMs && !sharper) {
        // Hold it: re-arm once, at the interval floor, rather than dropping a
        // real movement. This timer is deliberately NOT the debounce timer,
        // because accept() clears that one, and a device streaming fixes while
        // the user walks would otherwise clear the floor timer forever and
        // never re-resolve. Still one-shot, still no loop.
        if (!floorTimer) {
          floorTimer = setTimeout(() => { floorTimer = null; flush(); },
            Math.max(0, opt.minIntervalMs - since));
        }
        return;
      }
    }
    emit(fix);
  }

  function accept(fix) {
    if (stopped) return;
    if (onRawFix) onRawFix(fix);
    if (!pending) pendingSince = fix.at;
    pending = fix;
    if (!emitted) { emit(fix); return; }   // leading edge, once

    if (timer) clearTimeout(timer);
    const waited = fix.at - pendingSince;
    if (waited >= opt.maxWaitMs) {
      // The debounce has been re-armed for maxWaitMs without settling, which
      // means the device is streaming. Answer now.
      timer = null;
      flush();
      return;
    }
    timer = setTimeout(flush, Math.min(opt.debounceMs, opt.maxWaitMs - waited));
  }

  if (typeof navigator === "undefined" || !navigator.geolocation) {
    onError({ kind: "unsupported", code: 0, message: "This browser does not offer geolocation." });
  } else {
    watchId = navigator.geolocation.watchPosition(
      (pos) => accept({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: typeof pos.coords.accuracy === "number" ? pos.coords.accuracy : 0,
        at: pos.timestamp || Date.now(),
        source: "device",
      }),
      (err) => onError(mapGeoError(err)),
      {
        enableHighAccuracy: opt.enableHighAccuracy,
        maximumAge: opt.maximumAge,
        timeout: opt.timeout,
      }
    );
  }

  return {
    stop() {
      stopped = true;
      clearTimers();
      if (watchId !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
      }
    },
    /**
     * Inject a position by hand. Used to test the seven pilot cities from a
     * desktop (PLAN phase 5).
     *
     * It bypasses the debounce and the interval floor on purpose: those two
     * exist to stop a noisy sensor from re-resolving the app, and a hand-typed
     * coordinate is neither noisy nor a sensor. It is one explicit action, so
     * it gets one explicit answer, and "jump to Ghent" does not silently do
     * nothing for ten seconds.
     */
    push(lat, lon, accuracy = 0) {
      if (stopped) return;
      const fix = { lat, lon, accuracy, at: Date.now(), source: "manual" };
      if (onRawFix) onRawFix(fix);
      pending = fix;
      emit(fix);
    },
    last() { return emitted; },
  };
}

/**
 * One position, once. Same error mapping as watchPosition.
 * @param {Partial<typeof DEFAULT_WATCH>} [options]
 * @returns {Promise<Fix>}
 */
export function getPositionOnce(options = {}) {
  const opt = Object.assign({}, DEFAULT_WATCH, options);
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject({ kind: "unsupported", code: 0, message: "This browser does not offer geolocation." });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: typeof pos.coords.accuracy === "number" ? pos.coords.accuracy : 0,
        at: pos.timestamp || Date.now(),
        source: "device",
      }),
      (err) => reject(mapGeoError(err)),
      {
        enableHighAccuracy: opt.enableHighAccuracy,
        maximumAge: opt.maximumAge,
        timeout: opt.timeout,
      }
    );
  });
}

/** @returns {GeoError} */
function mapGeoError(err) {
  const code = err && typeof err.code === "number" ? err.code : 0;
  const kind = code === 1 ? "denied" : code === 3 ? "timeout" : code === 2 ? "unavailable" : "unavailable";
  return { kind, code, message: (err && err.message) || "Position unavailable." };
}
