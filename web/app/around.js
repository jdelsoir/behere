/**
 * BeHERE — the AROUND band.
 *
 * "What is around me?" Baked POI merged with live regional sources, sorted
 * strictly by real haversine distance in metres.
 *
 * Written against docs/CONTRACT.md v1 (frozen). Plain ES module, no build
 * step, no bundler, no CDN, no key, no token, no credential.
 *
 * ---------------------------------------------------------------------------
 * ARCHITECTURE: national and regional layers first, local layers as enrichment
 * ---------------------------------------------------------------------------
 * PLAN acceptance test 6 requires AROUND to return results in Ottignies-LLN,
 * which publishes zero local datasets. It is carried by the *regional* Walloon
 * ArcGIS tourism service, not by a city portal. Measured live on 15 Aug 2026
 * inside a 2 km envelope centred on 50.6690, 4.6150:
 *
 *     Walloon ArcGIS, 11 point layers ....... 55 features, 22,449 B
 *     ODWB aires-de-loisirs-du-brabant-wallon 7 records within 3 km
 *     ODWB recyparcs-in-bw .................. 4 records within 8 km
 *
 * The same shape holds for the other thin cities (Andenne: 19 Walloon features
 * plus five municipal ODWB datasets). No pilot city depends on a city portal.
 *
 * ---------------------------------------------------------------------------
 * REGION GATING (why, not just what)
 * ---------------------------------------------------------------------------
 * Firing a source outside its territory is not merely wasteful, it is wrong:
 *
 *   - Onroerend Erfgoed returns **HTTP 400** for a point outside Flanders,
 *     body: {"errors":["\"geometrie\" ligt buiten Vlaanderen ..."]}. Verified
 *     at 50.6690, 4.6150. A naive client would render that as a failure; it is
 *     not a failure, the register simply stops at the regional border.
 *   - Walloon ArcGIS returns {"count":0} over a Ghent envelope. Verified.
 *
 * So each layer has a third state beyond "ok" and "failed": ABSENT — out of
 * scope for this region, by design. It collapses with copy that says so.
 *
 * ---------------------------------------------------------------------------
 * SOURCES (all keyless, all CORS-verified 15 Aug 2026 with
 *          `Origin: https://example.github.io`)
 * ---------------------------------------------------------------------------
 *   geo.onroerenderfgoed.be ....... ACAO *                    Flanders only
 *   geoservices.wallonie.be ....... ACAO echoes origin        Wallonia only
 *   data.stad.gent ................ ACAO *   quota  250,000/day
 *   opendata.brussels.be .......... ACAO *   quota  100,000/day
 *   www.odwb.be ................... ACAO *   quota   20,000/day
 *   catalog.datastore.brussels .... ACAO *                    Brussels only
 *
 * Opendatasoft quotas are per portal and are NOT the flat 20,000 PLAN quotes
 * (CONTRACT §10.4). This module reads `x-ratelimit-limit` and
 * `x-ratelimit-remaining` off every response and never hardcodes a number.
 *
 * @module around
 */

import { wgs84ToCell } from "./grid.js";

// ===========================================================================
// 1. Constants
// ===========================================================================

/** Statbel region codes, as they appear in web/data/municipalities.json. */
export const RGN = {
  FLANDERS: "02000",
  WALLONIA: "03000",
  BRUSSELS: "04000",
};

/**
 * Source ids emitted by this band. They are the join key into
 * `web/data/meta.json.sources[]`, which is what satisfies acceptance test 8
 * ("every layer displays its source and its vintage date") per CONTRACT §2.
 *
 * Exported so the bake agent can align meta.json without guessing.
 */
export const AROUND_SOURCE_IDS = {
  // `p` (baked POI) is Phase 2 and nothing bakes it yet, so meta.json carries
  // no id for it and SOURCE_FALLBACK below is the whole answer. Every other id
  // here is verified present in the baked web/data/meta.json.
  baked: "baked_poi",
  heritage: "geo_onroerenderfgoed",
  wallonia: "geoservices_wallonie_tourism",
  // meta.json carries ONE Opendatasoft source covering all three portals,
  // because it is one API on three hosts under one licence. The portal is
  // named per layer in the layer title, not by inventing three source ids
  // that meta.json does not have.
  ods: {
    "data.stad.gent": "ods_opendatasoft",
    "opendata.brussels.be": "ods_opendatasoft",
    "www.odwb.be": "ods_opendatasoft",
  },
  catalogue: "catalog_datastore_brussels",
};

/**
 * Last-resort descriptors, used only when `ctx.meta.sources` does not carry
 * the id. A source line is never blank.
 */
const SOURCE_FALLBACK = {
  baked_poi: { title: "BeHERE baked POI", publisher: "BeHERE", vintage: "2025-01-01" },
  geo_onroerenderfgoed: {
    title: "Onroerend Erfgoed, afbakeningen",
    publisher: "Agentschap Onroerend Erfgoed (Flanders)",
    vintage: "live",
  },
  geoservices_wallonie_tourism: {
    title: "Offres touristiques en Wallonie",
    publisher: "SPW / Commissariat général au Tourisme",
    vintage: "live",
  },
  ods_opendatasoft: {
    title: "Opendatasoft city and regional portals",
    publisher: "Stad Gent / Ville de Bruxelles / ODWB",
    vintage: "live",
  },
  catalog_datastore_brussels: {
    title: "catalog.datastore.brussels",
    publisher: "Brussels Regional Informatics Centre",
    vintage: "live",
  },
};

/**
 * Cache TTLs, milliseconds. CONTRACT §10 is authoritative; every value here is
 * at or above the 30-60 s floor PLAN acceptance test 9 asks for, and
 * MIN_TTL_MS enforces that floor mechanically so no future edit can drop below
 * it. Longer is stricter: it means fewer calls, not more.
 */
const MIN_TTL_MS = 45 * 1000;
const TTL = {
  heritage: 6 * 3600 * 1000, //  CONTRACT §10.6
  wallonia: 6 * 3600 * 1000, //  CONTRACT §10.5
  odsRecords: 1 * 3600 * 1000, //  CONTRACT §10.4
  odsDataset: 24 * 3600 * 1000, //  field discovery, changes ~never
  catalogue: 24 * 3600 * 1000, //  CONTRACT §10.7
  shard: Infinity, //  immutable, pinned to the release vintage
};

/** Default search radius, metres. */
const DEFAULT_RADIUS_M = 1200;

/** Position debounce and the movement below which a new fix is ignored. */
const DEBOUNCE_MS = 400;
const MOVE_THRESHOLD_M = 25;

/**
 * Per-source request timeouts, milliseconds. These are MEASURED, not guessed,
 * and they are the reason the band renders progressively instead of waiting.
 * Wall-clock, 15 Aug 2026, from this machine:
 *
 *   geo.onroerenderfgoed.be ..... **17.7 to 22.8 s**, six consecutive runs of
 *       the same Ghent point query. TTFB swings 0.5-5.5 s but the body always
 *       trickles at 7.0-9.0 KB/s for a fixed 159,667 B. It is HTTP/1.1 and it
 *       does NOT compress (`--compressed` returns the same 159,667 bytes).
 *       There is also no lighter representation: `returnGeometry=false`,
 *       `fields=`, `simplify=`, `tolerance=`, `limit=`, `outputcrs=`,
 *       `geometrie_crs=` and `crs_out=` were each tried and every one returned
 *       byte-identical 159,667 B. The wait IS the Lambert 72 geometry, and the
 *       geometry is the one thing this band never reads. A generic 8 s timeout
 *       kills this endpoint every single time; even 25 s clipped it once.
 *   geoservices.wallonie.be ..... /identify TOTAL 7.3 s (one request).
 *       HTTP/2. Eleven parallel layer queries took 12.7 s wall clock, so the
 *       server, not the connection count, is the bottleneck.
 *   *.opendatasoft portals ...... ~0.3 s.
 *   catalog.datastore.brussels .. ~1.5 s.
 *
 * Every value has margin over the worst measurement. A source that exceeds it
 * collapses with honest copy; it never hangs. Heritage is slow enough that it
 * would dominate first paint if anything waited on it, which is precisely why
 * `collectAround` renders progressively and why this layer carries the longest
 * cache TTL. **It is also the single strongest candidate for service-worker
 * precaching**: 160 KB, 6 h TTL, keyed on the cell id, and 20 s to fetch cold.
 */
const TIMEOUT_MS = {
  heritage: 35000,
  wallonia: 15000,
  ods: 8000,
  catalogue: 12000,
};

/** Parallel request ceiling, so several ODS datasets do not stampede a phone. */
const MAX_CONCURRENCY = 4;

/**
 * Query-anchor quantisation, degrees.
 *
 * Radius searches are anchored on the centre of a 0.01-degree box rather than
 * on the raw device position, so panning inside the box is ONE request. This
 * is the same 2-dp bucketing CONTRACT §7.3 already uses for shard origins.
 * At 50.6 N a 0.01-degree box is 1112 m x 707 m, half-diagonal 658 m, so the
 * anchor is widened by ANCHOR_SLACK_M and every point inside the box gets its
 * full radius covered.
 *
 * Distances shown to the user are ALWAYS computed from the raw position
 * against each item's own coordinates. Only the candidate set is quantised.
 */
const ANCHOR_DEG = 0.01;
const ANCHOR_SLACK_M = 660;

/** Onroerend Erfgoed `type.label` prefixes that are administrative, not heritage. */
const OE_NON_HERITAGE_PREFIX = "gebied geen archeologie";

/**
 * Walloon ArcGIS: the 13 published layers are 2 group layers (0 "Hébergements",
 * 9 "Loisirs et découvertes") plus 11 queryable point layers. Group layers have
 * `geometryType: null` and cannot be queried. Verified against the MapServer
 * service description. The map is layer id -> AROUND category key.
 */
const WALLONIA_LAYER_CAT = {
  1: "accommodation", // Hôtels
  3: "accommodation", // Gîtes
  4: "accommodation", // Meublés
  5: "campsite", // Campings
  6: "accommodation", // Budget Holidays
  7: "accommodation", // Villages de vacances
  8: "restaurant", // Restaurants
  10: "leisure", // Découvertes et divertissements
  11: "poi", // Points d'intérêt
  12: "tourist_office", // Organismes touristiques
  13: "accommodation", // Chambres d'hôtes
};

const WALLONIA_BASE =
  "https://geoservices.wallonie.be/arcgis/rest/services/TOURISME/OFFRES_TOURISTIQUES/MapServer";

/**
 * Curated Opendatasoft dataset registry.
 *
 * Hand-written and verified live, exactly like `web/data/i18n/en.json`. It is
 * NOT discovered at runtime: `data.stad.gent` alone publishes 161 geo-enabled
 * datasets and ODWB 841, and there is no machine-readable way to know which of
 * them belong in a "what is around me" list, nor which field is the label.
 *
 * `geo` is deliberately absent: the geo field name is DISCOVERED per dataset,
 * because it varies (`geo_point_2d` on stad.gent, `coordonnees_geographiques`
 * on the Brabant wallon sets, `coordonnees` on the Andenne sets). Hardcoding
 * it returns HTTP 400 "Unknown field".
 *
 * Scope keys, checked in this order: `nis` (one municipality), `prov`
 * (province), `rgn` (region). An entry with none is portal-wide.
 *
 * Every row below was queried live on 15 Aug 2026 and returned the hit count
 * shown. Extend by adding a row, never by widening a call.
 */
const ODS_REGISTRY = [
  // --- Flanders -----------------------------------------------------------
  // Ghent, NIS 44021. 42 and 47 hits within 1.5 km of 51.0536, 3.7255.
  { host: "data.stad.gent", dataset: "speelterreinen-gent", cat: "playground", nis: "44021", label: ["naam"], detail: ["functies"], radius: 1200 },
  { host: "data.stad.gent", dataset: "parken-gent", cat: "park", nis: "44021", label: ["naam"], detail: ["type"], radius: 1200 },

  // --- Brussels -----------------------------------------------------------
  // City of Brussels, NIS 21004. 94 hits within 1.5 km of 50.8467, 4.3525.
  { host: "opendata.brussels.be", dataset: "parcours_street_art", cat: "artwork", nis: "21004", label: ["titre", "title", "name"], detail: ["artiste", "adresse"], radius: 1200 },

  // --- Wallonia, province of Brabant wallon (20002) -----------------------
  // Carries Ottignies-LLN, which has no city portal at all.
  { host: "www.odwb.be", dataset: "aires-de-loisirs-du-brabant-wallon", cat: "playground", prov: "20002", label: ["nom", "nom_de_rue"], detail: ["categorie", "partie_de_commune"], radius: 3000 },
  { host: "www.odwb.be", dataset: "aires-de-pique-nique-en-brabant-wallon", cat: "picnic", prov: "20002", label: ["nom", "nom_de_rue"], detail: ["commune"], radius: 5000 },
  { host: "www.odwb.be", dataset: "recyparcs-in-bw", cat: "recycling", prov: "20002", label: ["nom"], detail: ["adresse", "commune"], radius: 8000 },

  // --- Wallonia, Andenne NIS 92003 ---------------------------------------
  { host: "www.odwb.be", dataset: "andenne-aires-de-sports-et-de-loisirs", cat: "sports", nis: "92003", label: ["nom"], detail: ["adresse"], radius: 1500 },
  { host: "www.odwb.be", dataset: "andenne-culture-et-culte", cat: "culture", nis: "92003", label: ["nom"], detail: ["adresse"], radius: 1500 },
  { host: "www.odwb.be", dataset: "andenne-services-communaux", cat: "service", nis: "92003", label: ["nom"], detail: ["adresse"], radius: 1500 },
  { host: "www.odwb.be", dataset: "andenne-horeca", cat: "restaurant", nis: "92003", label: ["nom"], detail: ["adresse"], radius: 1200 },
];

/** UI strings. Keys mirror CONTRACT §8.3 `ui.*` so i18n/en.json can own them. */
const COPY = {
  "band.around": "Around",
  "around.radius": "within {r} m",
  "around.none": "Nothing published within {r} m of here.",
  "around.here": "you are inside this",
  "around.loading": "Loading…",
  "around.loading.heritage":
    "Loading. The Flemish heritage register takes about 20 seconds to answer, and everything else on this screen is already shown.",
  "around.unavailable": "{source} could not be reached. Nothing is shown for this layer.",
  "around.quota": "The daily quota for {host} is nearly used up. Local datasets are paused until it resets.",
  "around.empty.layer": "No {cat} data published for this municipality.",
  "around.noshards": "The baked places for this square have not loaded yet.",
  "around.rendererror": "This layer answered, but BeHERE could not display it.",
  "around.nogeo": "{title} publishes no map coordinates, so it cannot be placed on the ground.",
  "around.empty.catalogue": "No regional dataset in the Brussels catalogue covers this location.",
  "around.absent.heritage":
    "The Flemish heritage register covers Flanders only. There is no equivalent point service in this region, so this layer is absent by design, not by error.",
  "around.absent.wallonia":
    "The Walloon tourism service covers Wallonia only, so this layer is absent by design, not by error.",
  "around.absent.ods": "No local open-data portal publishes a place dataset for this municipality.",
  "around.absent.catalogue": "The Brussels regional catalogue covers the Brussels-Capital Region only.",
  "around.foreign":
    "{n} addresses in this square belong to {name}, which is not in this release.",
  "around.catalogue.lead":
    "{n} regional datasets in the Brussels catalogue cover this location. Listed for discovery only: licence terms are not yet verified, so nothing here is rendered as fact.",
  "flag.endonym": "Street and place names are shown in their official local language.",
  "flag.untranslated": "Not available in English",
  "source.line": "Source: {title} · {vintage}",
};

/** Category keys emitted. The i18n agent must carry these under `cat`. */
export const AROUND_CATEGORIES = [
  "accommodation", "artwork", "campsite", "culture", "heritage", "leisure",
  "park", "picnic", "playground", "poi", "recycling", "restaurant", "service",
  "sports", "tourist_office",
];

// ===========================================================================
// 2. Geometry
// ===========================================================================

const R_EARTH_M = 6371008.8; // IUGG mean radius
const DEG = Math.PI / 180;

/**
 * Real haversine distance in metres. This is the ONLY ordering used by the
 * band; no source's own "distance" or result order is ever trusted.
 * @param {number} lat1 @param {number} lon1 @param {number} lat2 @param {number} lon2
 * @returns {number} metres
 */
export function haversineM(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Metres per degree of longitude at a given latitude. */
function lonMetres(lat) {
  return 111320 * Math.cos(lat * DEG);
}

/**
 * The centre of the 0.01-degree box containing (lat, lon). Integer arithmetic
 * on 1e-5-degree units so the same position always yields the same anchor.
 * @returns {{lat: number, lon: number, key: string}}
 */
function anchorOf(lat, lon) {
  const ny = Math.floor(lat / ANCHOR_DEG);
  const nx = Math.floor(lon / ANCHOR_DEG);
  return {
    lat: (ny + 0.5) * ANCHOR_DEG,
    lon: (nx + 0.5) * ANCHOR_DEG,
    key: ny + ":" + nx,
  };
}

/** Envelope "xmin,ymin,xmax,ymax" in WGS84 degrees around a point. */
function envelopeOf(lat, lon, radiusM) {
  const dLat = radiusM / 111320;
  const dLon = radiusM / Math.max(1, lonMetres(lat));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat]
    .map((v) => v.toFixed(6))
    .join(",");
}

// ===========================================================================
// 3. Fetch: cache, in-flight dedupe, timeout, quota
// ===========================================================================

/** @type {Map<string, {t: number, ttl: number, v: any}>} */
const cache = new Map();
/** @type {Map<string, Promise<any>>} */
const inflight = new Map();
/** @type {Map<string, {limit: number|null, remaining: number|null, blocked: boolean}>} */
const quota = new Map();

/** Read a cached value, or undefined when absent or stale. */
function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return undefined;
  if (e.ttl !== Infinity && Date.now() - e.t > e.ttl) {
    cache.delete(key);
    return undefined;
  }
  return e.v;
}

function cacheSet(key, value, ttl) {
  cache.set(key, { t: Date.now(), ttl: Math.max(MIN_TTL_MS, ttl), v: value });
}

/** Drop everything. Exported for tests and for a hard refresh. */
export function clearAroundCache() {
  cache.clear();
  inflight.clear();
  quota.clear();
}

/**
 * GET JSON with a hard timeout and an optional parent abort signal.
 * No credentials, no custom headers: every request stays a CORS-simple GET so
 * no preflight is needed and no header can leak anything.
 */
async function fetchJson(url, parentSignal, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new DOMException("timeout", "TimeoutError")),
    timeoutMs || TIMEOUT_MS.ods
  );
  const onParentAbort = () => ctrl.abort(parentSignal.reason);
  if (parentSignal) {
    if (parentSignal.aborted) ctrl.abort(parentSignal.reason);
    else parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
      mode: "cors",
    });
    noteQuota(url, res);
    if (!res.ok) {
      const err = new Error("HTTP " + res.status);
      err.status = res.status;
      err.url = url;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
    if (parentSignal) parentSignal.removeEventListener("abort", onParentAbort);
  }
}

/**
 * Read the Opendatasoft quota headers off any response and adapt.
 * CONTRACT §10.4: read `x-ratelimit-limit`, never hardcode a number. Both
 * headers are listed in `access-control-expose-headers`, so the browser can
 * genuinely see them.
 */
function noteQuota(url, res) {
  let host;
  try {
    host = new URL(url).host;
  } catch {
    return;
  }
  const limit = num(res.headers.get("x-ratelimit-limit"));
  const remaining = num(res.headers.get("x-ratelimit-remaining"));
  if (limit === null && remaining === null && res.status !== 429) return;
  const q = quota.get(host) || { limit: null, remaining: null, blocked: false };
  if (limit !== null) q.limit = limit;
  if (remaining !== null) q.remaining = remaining;
  // Stop at 2% of the daily allowance, or immediately on a 429.
  if (res.status === 429) q.blocked = true;
  if (q.limit && q.remaining !== null && q.remaining < q.limit * 0.02) q.blocked = true;
  quota.set(host, q);
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function quotaBlocked(host) {
  const q = quota.get(host);
  return !!(q && q.blocked);
}

/**
 * Cached, deduped fetch. Two callers asking for the same key while a request
 * is open share one request. There is no timer anywhere in this module, so
 * there is no polling loop (acceptance test 9).
 */
function cachedJson(key, url, ttl, parentSignal, timeoutMs) {
  const hit = cacheGet(key);
  if (hit !== undefined) return Promise.resolve(hit);
  const open = inflight.get(key);
  if (open) return open;
  const p = fetchJson(url, parentSignal, timeoutMs)
    .then((v) => {
      cacheSet(key, v, ttl);
      return v;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/**
 * Run tasks with a small concurrency ceiling, preserving input order.
 *
 * Errors are collected rather than raced: a naive `Promise.all` over the
 * workers would reject on the first failure while the other workers kept
 * running, and their later rejections would surface as unhandled promise
 * rejections in the console. Every worker is allowed to finish, then the first
 * error is rethrown.
 */
async function pool(tasks, limit = MAX_CONCURRENCY) {
  const out = new Array(tasks.length);
  const errors = new Array(tasks.length);
  let i = 0;
  let firstError = -1;
  const workers = new Array(Math.min(limit, tasks.length)).fill(0).map(async () => {
    while (i < tasks.length) {
      const k = i++;
      try {
        out[k] = await tasks[k]();
      } catch (e) {
        errors[k] = e;
        if (firstError < 0 || k < firstError) firstError = k;
      }
    }
  });
  await Promise.all(workers);
  if (firstError >= 0) throw errors[firstError];
  return out;
}

/** A settled adapter result: never throws, always names what happened. */
function ok(items, extra) {
  return Object.assign({ state: "ok", items: items || [] }, extra);
}
function failed(reason, extra) {
  return Object.assign({ state: "failed", items: [], reason }, extra);
}
function absent(note, extra) {
  return Object.assign({ state: "absent", items: [], note }, extra);
}

// ===========================================================================
// 4. Labels
// ===========================================================================

/**
 * CONTRACT §9 resolver, used verbatim when the app injects it. This local copy
 * is a subordinate fallback so around.js runs standalone; `web/app/resolve.js`
 * owns the real one. Inject it via `ctx.resolveLabel`.
 */
let warnedNoResolver = false;
function fallbackResolveLabel(entity, kind, uiLang, ctx) {
  const name = (entity && entity.name) || {};
  const ov = (ctx && ctx.override) || {};
  const regionDefault = (ctx && ctx.regionDefault) || "nl";

  // Step 1: authored in the UI language. Always before step 2, so a curated
  // override can never shadow an authored name.
  if (typeof name[uiLang] === "string" && name[uiLang] !== "") {
    return { text: name[uiLang], lang: uiLang, translated: true, step: 1 };
  }
  // Step 3/4, computed up front because step 2's "=" defers to them.
  const authored = () => {
    if (typeof name[regionDefault] === "string" && name[regionDefault] !== "") {
      return { text: name[regionDefault], lang: regionDefault, step: 3 };
    }
    for (const l of ["nl", "fr", "de", "en"]) {
      if (typeof name[l] === "string" && name[l] !== "") {
        return { text: name[l], lang: l, step: 4 };
      }
    }
    return null;
  };
  // Step 2: the curated override.
  const bucket = ov[kind];
  const id = entity && entity.id;
  if (bucket && id !== undefined && id !== null && bucket[id] !== undefined) {
    const v = bucket[id];
    const raw = typeof v === "string" ? v : v && v[uiLang];
    if (raw === "=") {
      const a = authored();
      if (a) return { text: a.text, lang: a.lang, translated: true, step: 2 };
    } else if (typeof raw === "string" && raw !== "") {
      return { text: raw, lang: uiLang, translated: true, step: 2 };
    }
  }
  const a = authored();
  if (a) return { text: a.text, lang: a.lang, translated: false, step: a.step };
  return { text: "[" + (id ?? "?") + "]", lang: "?", translated: false, step: 4 };
}

function resolverOf(ctx) {
  if (typeof ctx.resolveLabel === "function") return ctx.resolveLabel;
  if (!warnedNoResolver) {
    warnedNoResolver = true;
    console.warn("[around] no ctx.resolveLabel injected; using the local CONTRACT §9 fallback");
  }
  return fallbackResolveLabel;
}

/**
 * The inline "this is not in your language" marker. Must stay byte-identical
 * to i18n.js's UNTRANSLATED_MARK; this module is mountable with no i18n.js, so
 * it cannot import it.
 */
const UNTRANSLATED_MARK = " *";

function uiLangOf(ctx) {
  return (ctx && (ctx.uiLang || ctx.lang)) || "en";
}

/**
 * Interpolate {token}s. Never returns undefined.
 *
 * Order matters. `ctx.t` is the shell's bound resolver and is the only lookup
 * that knows the ACTIVE UI language; it returns the key itself when it knows
 * nothing, which is the miss signal. `ctx.override` is en.json, so reading it
 * first meant this band rendered English chrome under a Dutch or French
 * interface no matter what the user had chosen.
 */
function t(ctx, key, vars) {
  let s;
  if (ctx && typeof ctx.t === "function") {
    const v = ctx.t(key);
    if (typeof v === "string" && v !== "" && v !== key && v !== "[" + key + "]") s = v;
  }
  if (typeof s !== "string") {
    const ui = (ctx && ctx.override && ctx.override.ui) || {};
    if (typeof ui[key] === "string" && ui[key] !== "") s = ui[key];
    // ctx.override is en.json. Under a Dutch or French interface, reading it
    // yields ENGLISH, which is exactly the untranslated case acceptance test 4
    // requires to be marked rather than passed off as a translation.
    if (typeof s === "string" && uiLangOf(ctx) !== "en") s += UNTRANSLATED_MARK;
  }
  if (typeof s !== "string") {
    s = COPY[key];
    if (typeof s === "string" && uiLangOf(ctx) !== "en") s += UNTRANSLATED_MARK;
  }
  if (typeof s !== "string") s = key;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : String(vars[k])));
}

/**
 * Resolve a category key through the resolver (kind "cat" => inline marker).
 *
 * `ctx.catFull` is the shell's bound lookup and is preferred, because the
 * `cat` group ships in nl.json and fr.json as well as en.json while
 * ctx.override is en.json alone. Resolving a category against the override
 * under a French interface matched nothing and printed "[playground]".
 */
function catLabel(ctx, catKey) {
  if (!catKey) return null;
  if (ctx && typeof ctx.catFull === "function") {
    const r = ctx.catFull(catKey);
    if (r && typeof r.text === "string" && r.text !== "") return r;
  }
  const r = resolverOf(ctx);
  return r({ id: catKey, name: {} }, "cat", ctx.uiLang, {
    override: ctx.override,
    regionDefault: ctx.regionDefault,
  });
}

/** First non-empty string among `fields` on a plain record. */
function pick(record, fields) {
  if (!record || !fields) return "";
  for (const f of fields) {
    const v = record[f];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return "";
}

/** Comma-joined, skipping every empty part: "Restauration, Rue X 12, 1348 Y". */
function joinDetail(parts) {
  return parts.filter((p) => typeof p === "string" && p.trim() !== "").map((p) => p.trim()).join(", ");
}

/** Space-joined, for parts of one phrase: street + number, postcode + commune. */
function joinWords(parts) {
  return parts.filter((p) => typeof p === "string" && p.trim() !== "").map((p) => p.trim()).join(" ");
}

// ===========================================================================
// 5. Adapters
// ===========================================================================

/**
 * A merged AROUND item.
 * @typedef {Object} AroundItem
 * @property {string} key        Stable dedupe key.
 * @property {Object} name       Authored names {nl?, fr?, de?, en?} for the resolver.
 * @property {string} [id]       Curated-override key, when the kind has one.
 * @property {string} cat        Category key, joins i18n `cat`.
 * @property {number} dist       Real haversine metres from the device position.
 * @property {number|null} lat
 * @property {number|null} lon
 * @property {string} sourceId   Joins meta.json.sources[].id.
 * @property {string} vintage    Per-record date when the source publishes one.
 * @property {string} detail     Secondary line, already in its authored language.
 * @property {string} [href]     Outbound link.
 * @property {boolean} inside    True when the item contains the position (dist 0).
 */

// --- 5.1 Baked POI ---------------------------------------------------------

/**
 * Baked POI from the grid shards, key `p` (CONTRACT §7.2).
 *
 * CONTRACT §7.2 declares `p` as `object[]`, "Baked POI. Omitted entirely if
 * none", but §11.3 states the layer is unmeasured Phase 2 work and the object's
 * FIELDS ARE NEVER SPECIFIED. This reader is therefore deliberately tolerant
 * and mirrors the only object-array precedent in the contract, `t` (stops):
 * `y`/`x` are ABSOLUTE offsets from the shard origin `o` in 1e-5-degree units,
 * not delta-encoded. See the report accompanying this file.
 */
function readBakedPoi(shards, ctx) {
  const pos = ctx;
  const items = [];
  const foreign = new Map();
  let sawShard = false;
  let sawKey = false;

  for (const shard of shards) {
    if (!shard || typeof shard !== "object") continue;
    sawShard = true;
    if (shard.fm && typeof shard.fm === "object") {
      for (const [nis, n] of Object.entries(shard.fm)) {
        foreign.set(nis, (foreign.get(nis) || 0) + (Number(n) || 0));
      }
    }
    const p = shard.p;
    if (!Array.isArray(p) || p.length === 0) continue;
    sawKey = true;
    const o = Array.isArray(shard.o) ? shard.o : null;
    if (!o) continue;

    for (let i = 0; i < p.length; i++) {
      const r = p[i];
      if (!r || typeof r !== "object") continue;
      const y = Number(r.y);
      const x = Number(r.x);
      if (!Number.isFinite(y) || !Number.isFinite(x)) continue;
      const lat = (o[0] + y) / 1e5;
      const lon = (o[1] + x) / 1e5;

      // `n` is the authored name; `t` optional authored translations, exactly
      // as stops carry them. Never machine-translated.
      const tr = r.t && typeof r.t === "object" ? r.t : {};
      const name = {
        nl: tr.nl || "",
        fr: tr.fr || "",
        de: tr.de || "",
      };
      if (typeof r.n === "string" && r.n !== "" && !name.nl && !name.fr && !name.de) {
        // Authored in the operator's own language; park it under the region
        // default so the resolver reaches it at step 3 rather than step 4.
        name[ctx.regionDefault || "nl"] = r.n;
      } else if (typeof r.n === "string" && r.n !== "") {
        name[ctx.regionDefault || "nl"] = name[ctx.regionDefault || "nl"] || r.n;
      }

      items.push({
        key: "baked:" + (shard.c || "?") + ":" + (r.i ?? i),
        name,
        id: r.i,
        cat: r.c || r.cat || "poi",
        dist: haversineM(pos.lat, pos.lon, lat, lon),
        lat,
        lon,
        sourceId: r.s || r.src || AROUND_SOURCE_IDS.baked,
        vintage: shard.v || ctx.vintage || "",
        detail: typeof r.d === "string" ? r.d : "",
        href: typeof r.u === "string" ? r.u : undefined,
        inside: false,
      });
    }
  }

  const fm = [...foreign.entries()].sort((a, b) => b[1] - a[1]);
  if (!sawShard) return failed("shards", { foreign: fm });
  if (!sawKey) {
    // The key is absent rather than empty (CONTRACT §7.2). That is the
    // mechanical signal for "collapse and name what is missing".
    return Object.assign({ state: "empty", items: [] }, { foreign: fm });
  }
  return ok(items, { foreign: fm });
}

// --- 5.2 Flemish heritage --------------------------------------------------

/**
 * Onroerend Erfgoed `afbakeningen`: which protected delineations CONTAIN this
 * exact point. Flanders only.
 *
 * Verified live 15 Aug 2026 at 51.0536, 3.7255 (Ghent, Korenmarkt):
 *   HTTP 200, 159,667 B, `Access-Control-Allow-Origin: *`
 *   body: a bare JSON ARRAY (not a FeatureCollection) of
 *     {id, naam, categorie, type:{uri,label}, uri, geometrie:{...}}
 *
 * Three things the contract does not say, all measured:
 *
 *  1. `geometrie` comes back in **EPSG:31370** no matter what `crs` says.
 *     `crs` describes the INPUT geometry, not the output. `outputcrs`,
 *     `geometrie_crs` and `crs_out` are all ignored (byte-identical responses).
 *     This module never reads `geometrie`, so no Lambert 72 inverse is needed:
 *     the query IS containment, so the real haversine distance is exactly 0.
 *  2. `categorie` is `aanduidingsobjecten` (the legal designation) or
 *     `erfgoedobjecten` (the inventory item), and the same delineation appears
 *     under both, e.g. ids 11888 and 140021 are both "Historische stadskern
 *     van Gent". They are deduped by name, keeping the typed one.
 *  3. Types beginning "gebied geen archeologie" are administrative
 *     "no archaeology here" polygons. They are not heritage and are dropped.
 */
async function fetchHeritage(ctx, signal) {
  if (ctx.rgn !== RGN.FLANDERS) {
    return absent(t(ctx, "around.absent.heritage"));
  }
  // CONTRACT §10.6: cache keyed on the CELL id, not the raw coordinate, so
  // panning inside a 1 km square is one request. The query itself uses the
  // real point, because containment at the cell centre is a different fact.
  const key = "oe:" + ctx.cell;
  const url =
    "https://geo.onroerenderfgoed.be/zoekdiensten/afbakeningen?geometrie=" +
    encodeURIComponent(
      JSON.stringify({ type: "Point", coordinates: [round6(ctx.lon), round6(ctx.lat)] })
    ) +
    "&crs=EPSG%3A4326";

  let raw;
  try {
    raw = await cachedJson(key, url, TTL.heritage, signal, TIMEOUT_MS.heritage);
  } catch (e) {
    if (isAbort(e)) throw e;
    // A 400 here means the point is outside Flanders. The gate above should
    // already have caught that, so treat any 400 as "out of scope", not
    // "broken": it is never honest to blame the server for our own geography.
    if (e.status === 400) return absent(t(ctx, "around.absent.heritage"));
    return failed(e.message || "network");
  }
  if (!Array.isArray(raw)) return failed("shape");

  const byName = new Map();
  for (const o of raw) {
    if (!o || typeof o !== "object") continue;
    const naam = typeof o.naam === "string" ? o.naam.trim() : "";
    if (naam === "") continue;
    const label = (o.type && typeof o.type.label === "string" ? o.type.label : "").trim();
    if (label.toLowerCase().startsWith(OE_NON_HERITAGE_PREFIX)) continue;
    const prev = byName.get(naam);
    // Keep the record that carries a type label (the designation).
    if (prev && prev.label !== "") continue;
    byName.set(naam, { o, label, naam });
  }

  const items = [...byName.values()].map(({ o, label, naam }) => ({
    key: "oe:" + o.id,
    // Onroerend Erfgoed authors in Dutch only (CONTRACT §10.6). Never
    // machine-translated: it resolves at step 3 with the endonym note.
    name: { nl: naam },
    id: undefined,
    cat: "heritage",
    dist: 0, // containment, not proximity
    lat: ctx.lat,
    lon: ctx.lon,
    sourceId: AROUND_SOURCE_IDS.heritage,
    vintage: "live",
    detail: label,
    href: typeof o.uri === "string" ? o.uri : undefined,
    inside: true,
  }));
  return items.length ? ok(items) : { state: "empty", items: [] };
}

// --- 5.3 Walloon tourism ---------------------------------------------------

/**
 * Walloon tourism, ArcGIS REST. Wallonia only. **One request for all 11
 * queryable layers**, via `/identify` rather than eleven `/query` calls.
 *
 * Why identify, measured rather than assumed:
 *
 *   11 parallel `/query?f=geojson` .... 12.7 s wall clock, 11 requests, 22,449 B
 *   1  `/identify?layers=all` ......... **7.3 s, 1 request, 35,803 B**
 *
 * The host is HTTP/2, so the eleven were genuinely parallel; the service
 * itself is the bottleneck. And the two are not an approximation of each
 * other, they are **identical**: at Ottignies-LLN with a 1200 m radius both
 * return exactly the same 50 records after the haversine filter, with zero
 * on either side of the difference. That equivalence is what makes identify
 * safe here, and it holds because of the pixel trick below.
 *
 * **Making identify's tolerance exact.** `tolerance` is in screen pixels, not
 * metres, which normally makes identify a fuzzy display-coupled query. Setting
 *     mapExtent   = the envelope spanning exactly 2R metres on each axis
 *     imageDisplay= 2R x 2R pixels
 * makes one pixel equal one metre in both axes, so `tolerance = R` is exactly
 * R metres. Results are then filtered again by real haversine distance, so the
 * displayed ordering never depends on this at all.
 *
 * Traps, all measured:
 *
 *  - **`LON` and `LAT` attributes are garbage.** Every record carries
 *    `"LON": 5, "LAT": 51` — rounded whole degrees. Use the geometry and
 *    nothing else. A client trusting those columns would pile every Walloon
 *    POI onto one point.
 *  - **identify stringifies every attribute** (`"OBJECTID": "100"`), so
 *    nothing may be used as a number without conversion.
 *  - **`DATE_MODIFICATION` is `DD-MM-YY` on identify** and epoch milliseconds
 *    on `f=geojson`. The format was pinned by cross-referencing the same
 *    records in both responses: `24-11-25` = 1763942400000 = 2025-11-24,
 *    `16-09-22` = 1663286400000 = 2022-09-16. Both are parsed here, so the
 *    per-record vintage survives the switch to identify.
 *  - Results legitimately cross municipal borders (Mont-Saint-Guibert
 *    restaurants appear near LLN). AROUND is distance-based, not
 *    municipality-based, so that is correct, and `COMMUNE` is displayed.
 */
async function fetchWallonia(ctx, signal) {
  if (ctx.rgn !== RGN.WALLONIA) {
    return absent(t(ctx, "around.absent.wallonia"));
  }
  const radius = Math.round(ctx.radiusM + ANCHOR_SLACK_M);
  const env = envelopeOf(ctx.anchor.lat, ctx.anchor.lon, radius);
  const key = "wal:" + ctx.anchor.key + ":" + radius;
  const url =
    WALLONIA_BASE +
    "/identify?geometry=" +
    encodeURIComponent(JSON.stringify({ x: round6(ctx.anchor.lon), y: round6(ctx.anchor.lat) })) +
    "&geometryType=esriGeometryPoint&sr=4326&layers=all" +
    "&tolerance=" + radius +
    "&mapExtent=" + encodeURIComponent(env) +
    "&imageDisplay=" + 2 * radius + "," + 2 * radius + ",96" +
    "&returnGeometry=true&f=json";

  let data;
  try {
    data = await cachedJson(key, url, TTL.wallonia, signal, TIMEOUT_MS.wallonia);
  } catch (e) {
    if (isAbort(e)) throw e;
    return failed(e.message || "network");
  }
  if (!data || !Array.isArray(data.results)) return failed("shape");

  const items = [];
  for (const r of data.results) {
    const g = r && r.geometry;
    const lat = Number(g && g.y);
    const lon = Number(g && g.x);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const p = r.attributes || {};
    const nom = typeof p.NOM === "string" ? p.NOM.trim() : "";
    if (nom === "") continue; // resolver step 4 must always succeed
    items.push({
      key: "wal:" + (p.CODE || r.layerId + ":" + p.OBJECTID),
      // FR only (CONTRACT §10.5). Never translated: resolves at step 3/4 with
      // the endonym note.
      name: { fr: nom },
      cat: WALLONIA_LAYER_CAT[r.layerId] || "poi",
      dist: haversineM(ctx.lat, ctx.lon, lat, lon),
      lat,
      lon,
      sourceId: AROUND_SOURCE_IDS.wallonia,
      vintage: arcgisDate(p.DATE_MODIFICATION) || "live",
      detail: joinDetail([
        typeof p.TYPE_OFFRE === "string" ? p.TYPE_OFFRE : "",
        joinWords([p.RUE, p.NUMERO]),
        joinWords([p.CODE_POSTAL, p.COMMUNE]),
      ]),
      href: validHttp(p.SITE_WEB),
      inside: false,
    });
  }
  return items.length ? ok(items) : { state: "empty", items: [] };
}

/**
 * ArcGIS date to "YYYY-MM-DD". Accepts epoch milliseconds (`f=geojson`) and
 * the `DD-MM-YY` string identify returns. The two-digit year pivots at 70,
 * which is irrelevant until 2070 and is the only reading consistent with the
 * cross-referenced records above.
 */
function arcgisDate(v) {
  if (typeof v === "number") return epochMsToDate(v);
  if (typeof v !== "string") return "";
  const s = v.trim();
  const dmy = /^(\d{2})-(\d{2})-(\d{2})$/.exec(s);
  if (dmy) {
    const [, dd, mm, yy] = dmy;
    const year = Number(yy) < 70 ? 2000 + Number(yy) : 1900 + Number(yy);
    return year + "-" + mm + "-" + dd;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d+$/.test(s)) return epochMsToDate(Number(s));
  return "";
}

// --- 5.4 Opendatasoft city and provincial datasets -------------------------

/**
 * Opendatasoft Explore v2.1.
 *
 * Two calls per dataset, both cached:
 *   1. `/datasets/{id}` -> the geo field name and the dataset's own vintage.
 *      MANDATORY: the field name varies per dataset. Verified live:
 *        data.stad.gent  speelterreinen-gent ............ geo_point_2d
 *        www.odwb.be     aires-de-loisirs-du-brabant-wallon
 *                                             ........... coordonnees_geographiques
 *        www.odwb.be     andenne-horeca ................. coordonnees
 *      Guessing `geo_point_2d` returns
 *      HTTP 400 "ODSQL query is malformed: Unknown field".
 *   2. `/datasets/{id}/records?where=within_distance(...)&select=...`
 *      `select=` is used to leave the polygon behind: one dataset dropped from
 *      7,542 B to 546 B for the same four records.
 *
 * `nom` is NULL on all seven Brabant wallon playground records near LLN, so
 * the label falls through the registry's `label` list (`nom` then `nom_de_rue`)
 * and finally to the dataset title. A blank name is never rendered.
 */
async function fetchOdsDataset(ctx, entry, signal) {
  const base = "https://" + entry.host + "/api/explore/v2.1/catalog/datasets/" + entry.dataset;
  const meta = await cachedJson(
    "odsmeta:" + entry.host + ":" + entry.dataset,
    base,
    TTL.odsDataset,
    signal,
    TIMEOUT_MS.ods
  );

  const fields = Array.isArray(meta && meta.fields) ? meta.fields : [];
  const geoField = (fields.find((f) => f && f.type === "geo_point_2d") || {}).name;
  const defaults = (meta && meta.metas && meta.metas.default) || {};
  const title = defaults.title || entry.dataset;
  const vintage = String(defaults.data_processed || defaults.modified || "").slice(0, 10) || "live";

  if (!geoField) {
    // Honest, specific, and it names the dataset rather than the app.
    return { entry, title, vintage, state: "empty", items: [], reason: "nogeo" };
  }

  const radius = Math.round((entry.radius || ctx.radiusM) + ANCHOR_SLACK_M);
  const pt = "geom'POINT(" + round6(ctx.anchor.lon) + " " + round6(ctx.anchor.lat) + ")'";
  // Only the columns AROUND renders, plus the geometry point.
  const want = new Set([geoField, ...(entry.label || []), ...(entry.detail || [])]);
  const known = new Set(fields.map((f) => f && f.name));
  const select = [...want].filter((n) => known.has(n));

  const url =
    base +
    "/records?where=" +
    encodeURIComponent("within_distance(" + geoField + ", " + pt + ", " + radius + "m)") +
    "&order_by=" +
    encodeURIComponent("distance(" + geoField + ", " + pt + ") asc") +
    "&select=" +
    encodeURIComponent(select.join(",")) +
    "&limit=100";

  const key = "ods:" + entry.host + ":" + entry.dataset + ":" + ctx.anchor.key + ":" + radius;
  const data = await cachedJson(key, url, TTL.odsRecords, signal, TIMEOUT_MS.ods);
  const rows = Array.isArray(data && data.results) ? data.results : [];

  const items = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const g = r && r[geoField];
    const lat = Number(g && g.lat);
    const lon = Number(g && g.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    // Label: registry order, then the dataset title. Never blank.
    const label = pick(r, entry.label) || title;
    const lang = odsLang(entry.host, defaults.language);
    items.push({
      key: "ods:" + entry.host + ":" + entry.dataset + ":" + i,
      name: { [lang]: label },
      cat: entry.cat,
      dist: haversineM(ctx.lat, ctx.lon, lat, lon),
      lat,
      lon,
      sourceId: AROUND_SOURCE_IDS.ods[entry.host] || "ods_" + entry.host,
      vintage,
      detail: pick(r, entry.detail),
      inside: false,
    });
  }
  return {
    entry,
    title,
    vintage,
    state: items.length ? "ok" : "empty",
    items,
    total: Number(data && data.total_count) || items.length,
  };
}

/** The language a portal authors in. Never a guess about the string itself. */
function odsLang(host, declared) {
  if (declared === "nl" || declared === "fr" || declared === "de") return declared;
  if (host === "data.stad.gent") return "nl";
  return "fr";
}

// --- 5.5 Brussels regional catalogue ---------------------------------------

/**
 * catalog.datastore.brussels, GeoNetwork `q` service. Brussels only.
 *
 * This is a METADATA catalogue, not a POI feed: its records have no point
 * geometry, only a bounding box. It is therefore rendered as a separate
 * discovery list and is NEVER mixed into the distance-sorted results. Doing
 * otherwise would fabricate distances.
 *
 * Two things measured that neither PLAN nor CONTRACT §10.7 records:
 *
 *  1. **`fast=index` is required.** Without it every content field comes back
 *     null — `title`, `abstract`, `geoBox`, `keyword`, `link`, `type` are all
 *     `null` and only `id`, `uuid`, `changeDate`, `createDate` survive. The URL
 *     as published in PLAN and CONTRACT returns a catalogue of empty records.
 *  2. **`@maxPageSize` is 100 and one page is ~836 KB.** Paging all 544
 *     records at runtime would cost ~5 MB, so it is not done. The bbox
 *     parameters (`westBL`/`eastBL`/`southBL`/`northBL` + `relation=overlaps`)
 *     filter server-side — 544 records narrow to 387 over a Grand-Place box —
 *     and only a short head is fetched, with the true total read from
 *     `summary["@count"]`.
 *
 * Licence terms here are unverified (PLAN §11), so CONTRACT §10.7 says treat
 * as discovery only. The copy says exactly that out loud.
 */
async function fetchBrusselsCatalogue(ctx, signal) {
  if (ctx.rgn !== RGN.BRUSSELS) {
    return absent(t(ctx, "around.absent.catalogue"));
  }
  const d = 0.02;
  const url =
    "https://catalog.datastore.brussels/geonetwork/srv/eng/q?_content_type=json&fast=index" +
    "&type=dataset&from=1&to=6" +
    "&westBL=" + (ctx.anchor.lon - d).toFixed(4) +
    "&eastBL=" + (ctx.anchor.lon + d).toFixed(4) +
    "&southBL=" + (ctx.anchor.lat - d).toFixed(4) +
    "&northBL=" + (ctx.anchor.lat + d).toFixed(4) +
    "&relation=overlaps";
  let data;
  try {
    data = await cachedJson("bxcat:" + ctx.anchor.key, url, TTL.catalogue, signal, TIMEOUT_MS.catalogue);
  } catch (e) {
    if (isAbort(e)) throw e;
    return failed(e.message || "network");
  }
  const total = Number(data && data.summary && data.summary["@count"]) || 0;
  let md = data && data.metadata;
  if (md && !Array.isArray(md)) md = [md];
  if (!Array.isArray(md) || md.length === 0) return { state: "empty", items: [] };

  const docs = md
    .map((r) => ({
      title: firstString(r && r.title) || firstString(r && r.defaultTitle),
      type: firstString(r && r.type) || "dataset",
      changed: String(firstString(r && r.revisionDate) || firstString(r && r.changeDate) || "").slice(0, 10),
      href: firstLink(r && r.link),
    }))
    .filter((x) => x.title);
  return docs.length ? ok(docs, { total }) : { state: "empty", items: [] };
}

function firstString(v) {
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) {
    for (const x of v) {
      const s = firstString(x);
      if (s) return s;
    }
  }
  return "";
}

/** GeoNetwork `link` entries are pipe-delimited: "name|desc|url|protocol|...". */
function firstLink(v) {
  const arr = Array.isArray(v) ? v : v ? [v] : [];
  for (const raw of arr) {
    if (typeof raw !== "string") continue;
    const url = raw.split("|")[2];
    const u = validHttp(url);
    if (u) return u;
  }
  return undefined;
}

// ===========================================================================
// 6. Small helpers
// ===========================================================================

function round6(v) {
  return Math.round(v * 1e6) / 1e6;
}

/**
 * True only for "a newer fix superseded this one" or "the band was destroyed".
 * A TIMEOUT is deliberately NOT an abort: it is a real failure the user is
 * owed honest copy about, so it must fall through to the `failed` state.
 */
function isAbort(e) {
  return !!e && e.name === "AbortError";
}

/** epoch ms -> "YYYY-MM-DD" (UTC). Returns "" for anything else. */
function epochMsToDate(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return "";
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

/** Only http(s) links are ever rendered. */
function validHttp(v) {
  if (typeof v !== "string" || v.trim() === "") return undefined;
  try {
    const u = new URL(v.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** "120 m" / "1.4 km". Distance is always shown, because it is the sort key. */
function formatDistance(m) {
  if (!Number.isFinite(m)) return "";
  if (m < 1) return "0 m";
  if (m < 1000) return Math.round(m) + " m";
  return (m / 1000).toFixed(m < 10000 ? 1 : 0) + " km";
}

/** Source title + vintage for a source id, joined via meta.json (CONTRACT §2). */
function sourceLine(ctx, sourceId, vintage) {
  const list = (ctx.meta && Array.isArray(ctx.meta.sources) && ctx.meta.sources) || [];
  const s = list.find((x) => x && x.id === sourceId) || SOURCE_FALLBACK[sourceId] || {};
  const title = s.title || sourceId || "unknown source";
  const v = vintage || s.vintage || ctx.vintage || "";
  return { title, vintage: v };
}

// ===========================================================================
// 7. Rendering — semantic markup only, no inline styles, no CSS
// ===========================================================================
//
// Built with createElement/textContent throughout: no innerHTML anywhere, so
// no source string can inject markup. Class names are documented in full at
// the foot of this file.

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

/** The source + vintage line every layer and every catalogue entry carries. */
function renderSource(ctx, sourceId, vintage) {
  const { title, vintage: v } = sourceLine(ctx, sourceId, vintage);
  const p = el("p", "around-src");
  p.appendChild(el("span", "around-src__name", title));
  if (v) {
    p.appendChild(document.createTextNode(" · "));
    const time = el("time", "around-src__vintage", v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) time.dateTime = v;
    p.appendChild(time);
  }
  return p;
}

/** An untranslated marker, per CONTRACT §9.3 (inline only for munty/cat/ui). */
function renderFlag(ctx) {
  const sup = el("sup", "around-flag", "·");
  sup.title = t(ctx, "flag.untranslated");
  sup.setAttribute("aria-label", t(ctx, "flag.untranslated"));
  return sup;
}

function renderItem(ctx, item) {
  const li = el("li", "around-item");
  li.dataset.cat = item.cat || "";

  const dist = el("span", "around-item__dist", item.inside ? "—" : formatDistance(item.dist));
  if (item.inside) dist.title = t(ctx, "around.here");
  li.appendChild(dist);

  const body = el("span", "around-item__body");

  const resolve = resolverOf(ctx);
  const label = resolve(item, "poi", ctx.uiLang, {
    override: ctx.override,
    regionDefault: ctx.regionDefault,
  });
  // kind "poi": NO inline untranslated marker. One endonym note per panel
  // instead (CONTRACT §9.3). Marking 2,637 street-language names inline would
  // be noise about our own policy, not information.
  const nameNode = item.href
    ? el("a", "around-item__name around-item__link")
    : el("span", "around-item__name");
  nameNode.textContent = label.text;
  nameNode.lang = label.lang !== "?" ? label.lang : "";
  if (item.href) {
    nameNode.href = item.href;
    nameNode.rel = "noopener noreferrer";
    nameNode.target = "_blank";
  }
  body.appendChild(nameNode);

  const cat = catLabel(ctx, item.cat);
  if (cat && cat.text) {
    const c = el("span", "around-item__cat", cat.text);
    body.appendChild(c);
    // kind "cat" DOES take an inline marker: an uncurated category label is a
    // real curation gap, not a language policy.
    if (!cat.translated) c.appendChild(renderFlag(ctx));
  }

  if (item.detail) {
    const d = el("span", "around-item__detail", item.detail);
    d.lang = label.lang !== "?" ? label.lang : "";
    body.appendChild(d);
  }
  if (item.inside) body.appendChild(el("span", "around-item__here", t(ctx, "around.here")));

  li.appendChild(body);
  return { node: li, translated: label.translated };
}

/**
 * One layer. It is ALWAYS one of five explicit states, and four of them carry
 * copy naming exactly what is missing. There is no sixth state in which a card
 * renders blank, and no state in which a spinner survives: every fetch has a
 * hard per-source TIMEOUT_MS.
 */
function renderLayer(ctx, layer) {
  const details = el("details", "around-layer around-layer--" + layer.state);
  details.dataset.layer = layer.id;
  if (layer.state === "ok") details.open = true;
  if (layer.state === "pending") details.setAttribute("aria-busy", "true");

  const summary = el("summary", "around-layer__summary");
  summary.appendChild(el("span", "around-layer__name", layer.title || placeholderTitle(ctx, layer.id)));
  const n = layer.items ? layer.items.length : 0;
  summary.appendChild(el("span", "around-layer__count", layer.state === "ok" ? String(n) : "—"));
  details.appendChild(summary);

  const body = el("div", "around-layer__body");
  let anyUntranslated = false;

  if (layer.state === "ok" && n > 0) {
    const ol = el("ol", "around-list");
    for (const item of layer.items) {
      const { node, translated } = renderItem(ctx, item);
      if (!translated) anyUntranslated = true;
      ol.appendChild(node);
    }
    body.appendChild(ol);
  } else {
    // Honest copy naming the missing thing, never a blank card.
    body.appendChild(el("p", "around-layer__missing", layer.note || layer.missing || ""));
  }

  if (layer.extra) {
    for (const line of layer.extra) body.appendChild(el("p", "around-layer__note", line));
  }
  if (anyUntranslated) body.appendChild(el("p", "around__note", t(ctx, "flag.endonym")));

  body.appendChild(renderSource(ctx, layer.sourceId, layer.vintage));
  details.appendChild(body);
  return details;
}

/**
 * A slot's name before its source has answered. Derived from the plan id, so
 * the skeleton is readable rather than a row of grey boxes: the reader can see
 * which layers are coming before any of them lands.
 */
function placeholderTitle(ctx, id) {
  if (id === "baked") return catText(ctx, "poi") || "Places";
  if (id === "heritage") return catText(ctx, "heritage") || "Heritage";
  if (id === "wallonia") return "Tourism";
  if (id === "catalogue") return "Regional catalogue";
  if (id.startsWith("ods:")) {
    const ds = id.slice(4);
    const entry = ODS_REGISTRY.find((e) => e.dataset === ds);
    return entry ? catText(ctx, entry.cat) || ds : ds;
  }
  return "Local datasets";
}

/**
 * The source a slot WILL cite, known from the plan id alone. A skeleton row
 * names its source before the source has answered, so acceptance test 8 holds
 * for every frame, not only the last one.
 */
function placeholderSource(ctx, id) {
  if (id === "baked") return AROUND_SOURCE_IDS.baked;
  if (id === "heritage") return AROUND_SOURCE_IDS.heritage;
  if (id === "wallonia") return AROUND_SOURCE_IDS.wallonia;
  if (id === "catalogue") return AROUND_SOURCE_IDS.catalogue;
  if (id.startsWith("ods:")) {
    const entry = ODS_REGISTRY.find((e) => e.dataset === id.slice(4));
    if (entry) return AROUND_SOURCE_IDS.ods[entry.host] || "ods_" + entry.host;
  }
  return AROUND_SOURCE_IDS.ods[odsHostFor(ctx)] || "ods_opendatasoft";
}

/** The Brussels catalogue, rendered as discovery, never as distance. */
function renderCatalogue(ctx, layer) {
  const details = el("details", "around-layer around-catalogue around-layer--" + layer.state);
  details.dataset.layer = "catalogue";
  const summary = el("summary", "around-layer__summary");
  summary.appendChild(el("span", "around-layer__name", layer.title || placeholderTitle(ctx, "catalogue")));
  summary.appendChild(
    el("span", "around-layer__count", layer.state === "ok" ? String(layer.total || layer.items.length) : "—")
  );
  details.appendChild(summary);

  const body = el("div", "around-layer__body");
  if (layer.state === "ok" && layer.items.length) {
    body.appendChild(
      el("p", "around-catalogue__lead", t(ctx, "around.catalogue.lead", { n: layer.total || layer.items.length }))
    );
    const ul = el("ul", "around-catalogue__list");
    for (const d of layer.items) {
      const li = el("li", "around-catalogue__item");
      const a = d.href ? el("a", "around-catalogue__name") : el("span", "around-catalogue__name");
      a.textContent = d.title;
      a.lang = "en";
      if (d.href) {
        a.href = d.href;
        a.rel = "noopener noreferrer";
        a.target = "_blank";
      }
      li.appendChild(a);
      if (d.changed) {
        const time = el("time", "around-catalogue__date", d.changed);
        if (/^\d{4}-\d{2}-\d{2}$/.test(d.changed)) time.dateTime = d.changed;
        li.appendChild(time);
      }
      ul.appendChild(li);
    }
    body.appendChild(ul);
  } else {
    body.appendChild(el("p", "around-layer__missing", layer.note || layer.missing || ""));
  }
  body.appendChild(renderSource(ctx, AROUND_SOURCE_IDS.catalogue, layer.vintage));
  details.appendChild(body);
  return details;
}

// ===========================================================================
// 8. Assembly
// ===========================================================================

/**
 * The layer list, in final display order, computed SYNCHRONOUSLY before any
 * request is sent.
 *
 * This exists so the band can paint its full skeleton at once and then fill
 * each slot as it lands, instead of blocking first paint on the slowest
 * source. Onroerend Erfgoed alone takes 17.5 s (measured, §TIMEOUT_MS); making
 * a Ghent user stare at nothing for that long, when the city's playgrounds and
 * parks answered in 300 ms, would be a self-inflicted wound.
 *
 * The order is fixed, so a slot never moves once it is drawn.
 *
 * @returns {{ids: string[], odsEntries: Array}}
 */
export function planAround(ctx) {
  const odsEntries = ODS_REGISTRY.filter((e) => {
    if (e.nis) return e.nis === ctx.nis;
    if (e.prov) return e.prov === ctx.prov;
    if (e.rgn) return e.rgn === ctx.rgn;
    return true;
  });
  const ids = ["baked", "heritage", "wallonia"];
  if (odsEntries.length === 0) ids.push("ods");
  else for (const e of odsEntries) ids.push("ods:" + e.dataset);
  ids.push("catalogue");
  return { ids, odsEntries };
}

/**
 * Fetch every applicable source, merge, and sort strictly by real haversine
 * distance in metres. Never throws except on abort.
 *
 * @param {Object} ctx  A resolved position context, see createAroundBand.
 * @param {AbortSignal} signal
 * @param {(layer: Object) => void} [onLayer]  Called the moment each layer
 *        settles, for progressive rendering. Layers arrive out of order; use
 *        `layer.id` against `planAround(ctx).ids` to place them.
 * @returns {Promise<{layers: Array, catalogue: Object|null, count: number}>}
 */
export async function collectAround(ctx, signal, onLayer) {
  const plan = planAround(ctx);
  const settled = new Map();
  const emit = (layer) => {
    settled.set(layer.id, layer);
    if (onLayer) {
      try {
        onLayer(layer);
      } catch (e) {
        console.error("[around] onLayer threw", e);
      }
    }
    return layer;
  };

  // --- baked POI: synchronous, so it paints on the first frame ------------
  {
    const baked = readBakedPoi(ctx.shards || [], ctx);
    const extra = [];
    for (const [nis, count] of baked.foreign || []) {
      extra.push(
        t(ctx, "around.foreign", {
          n: count.toLocaleString(ctx.uiLang),
          name: municipalityName(ctx, nis),
        })
      );
    }
    emit({
      id: "baked",
      title: catText(ctx, "poi") || "Places",
      sourceId: AROUND_SOURCE_IDS.baked,
      vintage: ctx.vintage,
      state: baked.state,
      items: sortByDistance(withinRadius(baked.items, ctx.radiusM)),
      missing:
        baked.state === "failed"
          ? t(ctx, "around.noshards")
          : t(ctx, "around.empty.layer", { cat: catText(ctx, "poi") || "place" }),
      extra,
    });
  }

  const jobs = [];

  // --- Flemish heritage ---------------------------------------------------
  jobs.push(
    settle(fetchHeritage(ctx, signal), "heritage").then((r) =>
      emit({
        id: "heritage",
        title: catText(ctx, "heritage") || "Heritage",
        sourceId: AROUND_SOURCE_IDS.heritage,
        vintage: "live",
        state: r.state,
        items: sortByDistance(r.items),
        note: r.note,
        missing:
          r.state === "failed"
            ? t(ctx, "around.unavailable", { source: SOURCE_FALLBACK.geo_onroerenderfgoed.title })
            : t(ctx, "around.empty.layer", { cat: catText(ctx, "heritage") || "heritage" }),
      })
    )
  );

  // --- Walloon tourism ----------------------------------------------------
  jobs.push(
    settle(fetchWallonia(ctx, signal), "wallonia").then((r) =>
      emit({
        id: "wallonia",
        title: "Tourism",
        sourceId: AROUND_SOURCE_IDS.wallonia,
        vintage: "live",
        state: r.state,
        items: sortByDistance(withinRadius(r.items, ctx.radiusM)),
        note: r.note,
        missing:
          r.state === "failed"
            ? t(ctx, "around.unavailable", { source: SOURCE_FALLBACK.geoservices_wallonie_tourism.title })
            : t(ctx, "around.empty.layer", { cat: "tourism" }),
      })
    )
  );

  // --- Opendatasoft, one layer per registered dataset ---------------------
  if (plan.odsEntries.length === 0) {
    emit({
      id: "ods",
      title: "Local datasets",
      sourceId: AROUND_SOURCE_IDS.ods[odsHostFor(ctx)] || "ods_opendatasoft",
      vintage: "live",
      state: "absent",
      items: [],
      note: t(ctx, "around.absent.ods"),
    });
  } else {
    jobs.push(
      pool(
        plan.odsEntries.map((entry) => async () => {
          let r;
          if (quotaBlocked(entry.host)) {
            r = {
              entry,
              state: "failed",
              items: [],
              note: t(ctx, "around.quota", { host: entry.host }),
            };
          } else {
            r = await settle(fetchOdsDataset(ctx, entry, signal), "ods");
            r.entry = r.entry || entry;
          }
          const title = r.title || entry.dataset;
          return emit({
            id: "ods:" + entry.dataset,
            title,
            sourceId: AROUND_SOURCE_IDS.ods[entry.host] || "ods_" + entry.host,
            vintage: r.vintage || "live",
            state: r.state,
            items: sortByDistance(withinRadius(r.items, entry.radius || ctx.radiusM)),
            note: r.note,
            missing:
              r.state === "failed"
                ? r.note || t(ctx, "around.unavailable", { source: title })
                : r.reason === "nogeo"
                ? t(ctx, "around.nogeo", { title })
                : t(ctx, "around.empty.layer", { cat: catText(ctx, entry.cat) || entry.cat }),
          });
        })
      )
    );
  }

  // --- Brussels regional catalogue (discovery, never distance) ------------
  jobs.push(
    settle(fetchBrusselsCatalogue(ctx, signal), "catalogue").then((r) =>
      emit({
        id: "catalogue",
        title: "Regional catalogue",
        sourceId: AROUND_SOURCE_IDS.catalogue,
        vintage: "live",
        state: r.state,
        items: r.items || [],
        total: r.total,
        note: r.note,
        missing:
          r.state === "failed"
            ? t(ctx, "around.unavailable", { source: SOURCE_FALLBACK.catalog_datastore_brussels.title })
            : t(ctx, "around.empty.catalogue"),
      })
    )
  );

  await Promise.all(jobs);

  const layers = plan.ids.filter((id) => id !== "catalogue").map((id) => settled.get(id)).filter(Boolean);
  const catalogue = settled.get("catalogue") || null;
  const count = layers.reduce((a, l) => a + (l.state === "ok" ? l.items.length : 0), 0);
  return { layers, catalogue, count };
}

/**
 * Turn any adapter rejection into a `failed` layer result, EXCEPT an abort,
 * which must propagate so a superseded render stops rather than painting stale
 * copy over a newer position.
 */
function settle(promise, what) {
  return promise.catch((e) => {
    if (isAbort(e)) throw e;
    return failed((e && e.message) || what);
  });
}

function withinRadius(items, radiusM) {
  return (items || []).filter((i) => i.inside || i.dist <= radiusM);
}

/** The one and only ordering in this band. */
function sortByDistance(items) {
  return (items || []).slice().sort((a, b) => {
    if (a.dist !== b.dist) return a.dist - b.dist;
    return String(a.key).localeCompare(String(b.key)); // stable, deterministic
  });
}

function catText(ctx, key) {
  const c = catLabel(ctx, key);
  return c ? c.text : key;
}

function odsHostFor(ctx) {
  if (ctx.rgn === RGN.FLANDERS) return "data.stad.gent";
  if (ctx.rgn === RGN.BRUSSELS) return "opendata.brussels.be";
  return "www.odwb.be";
}

function municipalityName(ctx, nis) {
  const table = (ctx.municipalities && ctx.municipalities.municipalities) || ctx.municipalities || {};
  const rec = table[nis];
  if (!rec) return nis;
  const resolve = resolverOf(ctx);
  return resolve({ id: nis, name: rec }, "munty", ctx.uiLang, {
    override: ctx.override,
    regionDefault: ctx.regionDefault,
  }).text;
}

// ===========================================================================
// 9. Public API
// ===========================================================================

/**
 * Mount the AROUND band into an element.
 *
 * @param {HTMLElement} root  The element to own. Its contents are replaced.
 * @param {Object} [options]
 * @param {number} [options.radiusM=1200]
 * @param {number} [options.debounceMs=400]
 * @returns {{update: Function, refresh: Function, destroy: Function, element: HTMLElement}}
 *
 * `update(fix)` takes:
 *   {number}  lat, lon        Device position, WGS84 degrees. Required.
 *   {string} [cell]           GRD_NEWID. Computed with grid.js when absent.
 *   {string}  nis             Current municipality, 5 digits.
 *   {string}  rgn             "02000" | "03000" | "04000".
 *   {string|null} [prov]      Province code; null in Brussels.
 *   {"nl"|"fr"|"en"} uiLang
 *   {"nl"|"fr"|"de"} regionDefault   From <nis>/meta.json lang.default.
 *   {Object} [override]       Parsed web/data/i18n/en.json.
 *   {Object} [meta]           Parsed web/data/meta.json (for source lines).
 *   {Object} [municipalities] Parsed web/data/municipalities.json.
 *   {Array}  [shards]         Parsed grid shards, centre cell FIRST.
 *   {Function} [resolveLabel] The CONTRACT §9 resolver. Inject it.
 *   {string} [vintage]        Defaults to meta.vintage, else "2025-01-01".
 */
export function createAroundBand(root, options = {}) {
  const radiusM = options.radiusM || DEFAULT_RADIUS_M;
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;

  /* Own chrome, or the host's?
   *
   * Mounted alone (offline.html, a test page) this band draws its own
   * <section> and <h2>, because otherwise it has no title. Mounted by the
   * shell it is handed div.band-body, which already sits inside
   * section.band#band-around under an <h2>Around</h2>. Drawing a second
   * section and a second identical heading in there is a duplicate landmark
   * and a duplicate heading for a screen reader, so the shell passes
   * `chrome: false` and this band renders the body only.
   *
   * It is detected as well as declared: a root that already lives inside a
   * .band gets the headerless form even if the caller forgets to say so. */
  const ownChrome = options.chrome === undefined
    ? !(root && typeof root.closest === "function" && root.closest(".band"))
    : options.chrome !== false;

  const section = ownChrome ? el("section", "around") : el("div", "around");
  const head = el("header", "around__head");
  if (ownChrome) {
    section.setAttribute("aria-labelledby", "around-title");
    const h = el("h2", "around__title", COPY["band.around"]);
    h.id = "around-title";
    head.appendChild(h);
  }
  const sub = el("p", "around__radius");
  head.appendChild(sub);
  section.appendChild(head);

  const status = el("p", "around__status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  section.appendChild(status);

  const layersEl = el("div", "around__layers");
  section.appendChild(layersEl);

  root.textContent = "";
  root.appendChild(section);

  let timer = null;
  let controller = null;
  let last = null; // last fix actually rendered
  let destroyed = false;

  /** Debounced entry point. Ignores sub-threshold movement. No polling. */
  function update(fix) {
    if (destroyed || !fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lon)) return;
    if (
      last &&
      last.nis === fix.nis &&
      last.uiLang === fix.uiLang &&
      haversineM(last.lat, last.lon, fix.lat, fix.lon) < MOVE_THRESHOLD_M
    ) {
      return; // the user has not meaningfully moved
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      run(fix);
    }, debounceMs);
  }

  /** Force a re-render with the last fix, bypassing the debounce. */
  function refresh() {
    if (last) run(last);
  }

  /**
   * Render progressively.
   *
   * The full skeleton is drawn from `planAround` before a single request goes
   * out, so every slot exists in its final position immediately and nothing
   * reflows underneath the reader. Each slot is then replaced in place as its
   * source settles. Baked POI is synchronous and lands on the first frame;
   * Onroerend Erfgoed can take 17.5 s and no longer holds anything else up.
   *
   * A `pending` slot always resolves, because every request carries a hard
   * per-source timeout. There is no code path that leaves one spinning.
   */
  async function run(fix) {
    if (destroyed) return;
    if (controller) controller.abort(new DOMException("superseded", "AbortError"));
    controller = new AbortController();
    const signal = controller.signal;
    last = fix;

    const ctx = buildCtx(fix, radiusM);
    const plan = planAround(ctx);
    sub.textContent = t(ctx, "around.radius", { r: ctx.radiusM });
    section.setAttribute("aria-busy", "true");
    status.textContent = t(ctx, "around.loading");

    // Skeleton, in final order.
    layersEl.textContent = "";
    /** @type {Map<string, {node: Object, index: number}>} */
    const slots = new Map();
    plan.ids.forEach((id, index) => {
      const node = renderLayer(ctx, {
        id,
        title: "",
        state: "pending",
        items: [],
        sourceId: placeholderSource(ctx, id),
        vintage: "",
        // A 20-second wait deserves an explanation, not a bare "Loading…".
        // Naming the slow source turns a mystery into information, and it is
        // the same honesty the empty and absent states already owe the reader.
        missing: t(ctx, id === "heritage" ? "around.loading.heritage" : "around.loading"),
      });
      layersEl.appendChild(node);
      slots.set(id, { node, index });
    });

    const onLayer = (layer) => {
      if (destroyed || signal.aborted) return;
      const slot = slots.get(layer.id);
      if (!slot) return;
      let fresh;
      try {
        fresh = layer.id === "catalogue" ? renderCatalogue(ctx, layer) : renderLayer(ctx, layer);
      } catch (e) {
        // A render bug must not strand a slot on "Loading…" forever. Replace
        // it with something true instead: acceptance test 9 forbids a spinner
        // that never resolves, and that has to hold for our own defects too.
        console.error("[around] render failed for layer " + layer.id, e);
        fresh = renderLayer(ctx, {
          id: layer.id,
          title: layer.title || placeholderTitle(ctx, layer.id),
          state: "failed",
          items: [],
          sourceId: layer.sourceId || placeholderSource(ctx, layer.id),
          vintage: layer.vintage || "",
          missing: t(ctx, "around.rendererror"),
        });
      }
      layersEl.replaceChild(fresh, slot.node);
      slot.node = fresh;
    };

    let result;
    try {
      result = await collectAround(ctx, signal, onLayer);
    } catch (e) {
      if (isAbort(e)) return; // a newer fix owns the screen now
      // collectAround only throws on abort, so this is a bug path. Still say
      // something true rather than leaving a skeleton on screen.
      result = { layers: [], catalogue: null, count: 0 };
    }
    if (destroyed || signal.aborted) return;

    section.removeAttribute("aria-busy");
    status.textContent =
      result.count > 0
        ? result.count + " " + t(ctx, "around.radius", { r: ctx.radiusM })
        : t(ctx, "around.none", { r: ctx.radiusM });
  }

  function destroy() {
    destroyed = true;
    if (timer) clearTimeout(timer);
    if (controller) controller.abort(new DOMException("destroyed", "AbortError"));
    root.textContent = "";
  }

  return { update, refresh, destroy, element: section };
}

/** Normalise a fix into the context every adapter reads. */
function buildCtx(fix, radiusM) {
  const lat = fix.lat;
  const lon = fix.lon;
  const meta = fix.meta || null;
  return {
    lat,
    lon,
    cell: fix.cell || wgs84ToCell(lat, lon),
    anchor: anchorOf(lat, lon),
    radiusM: fix.radiusM || radiusM,
    nis: fix.nis || "",
    rgn: fix.rgn || "",
    prov: fix.prov ?? null,
    uiLang: fix.uiLang || "nl",
    regionDefault: fix.regionDefault || (fix.rgn === RGN.FLANDERS ? "nl" : "fr"),
    override: fix.override || {},
    meta,
    municipalities: fix.municipalities || null,
    shards: fix.shards || [],
    resolveLabel: fix.resolveLabel,
    // The shell's bound chrome and category lookups. Carried through so t()
    // and catLabel() below can ask for the ACTIVE language rather than always
    // reading en.json, which is the only document ctx.override holds.
    t: typeof fix.t === "function" ? fix.t : null,
    catFull: typeof fix.catFull === "function" ? fix.catFull : null,
    vintage: fix.vintage || (meta && meta.vintage) || "2025-01-01",
  };
}

// ===========================================================================
// 10. Class names (the stylesheet agent owns every rule; this file ships none)
// ===========================================================================
//
//  around                       root <section>
//  around__head                 <header>
//  around__title                <h2>, id="around-title"
//  around__radius               "within 1200 m"
//  around__status               role=status aria-live=polite; result count or
//                               the honest "nothing published" line
//  around__layers               container for all layers
//  around__note                 the single endonym note per panel
//
//  around-layer                 one <details> per layer
//  around-layer--ok             has results, rendered open
//  around-layer--empty          source answered, published nothing here
//  around-layer--failed         source could not be reached
//  around-layer--absent         out of scope for this region, by design
//  around-layer__summary        <summary>
//  around-layer__name           layer title
//  around-layer__count          result count, or an em dash
//  around-layer__body           <div>
//  around-layer__missing        the honest copy naming what is missing
//  around-layer__note           secondary note (partial, truncated, foreign)
//
//  around-list                  <ol>, already in ascending distance order
//  around-item                  <li>, carries data-cat="<category key>"
//  around-item__dist            distance, "120 m" / "1.4 km" / em dash
//  around-item__body            <span> wrapping the text side
//  around-item__name            <span> or <a class="around-item__link">
//  around-item__link            added to the name when it is a link
//  around-item__cat             category label
//  around-item__detail          address / type line, carries lang=""
//  around-item__here            "you are inside this"
//
//  around-src                   <p>, source + vintage, on EVERY layer
//  around-src__name
//  around-src__vintage          <time datetime="YYYY-MM-DD">
//  around-flag                  <sup> untranslated marker (munty/cat/ui only)
//
//  around-catalogue             Brussels discovery block, NOT distance-sorted
//  around-catalogue__lead
//  around-catalogue__list       <ul>
//  around-catalogue__item       <li>
//  around-catalogue__name
//  around-catalogue__date       <time>
