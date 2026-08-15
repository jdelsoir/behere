/**
 * BeHERE, the GO band: "How do I get away from here?"
 *
 * Nearest stops from the baked 1 km index, then live departures on top:
 * iRail for trains, NAP GTFS-realtime for everything else. Every layer states
 * its source and its vintage, nothing ever renders as an empty panel, and the
 * offline path shows the last board it saw with an explicit "as of" time.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS VERIFIED LIVE ON 15 AUGUST 2026, AND WHAT IT CHANGED
 * ---------------------------------------------------------------------------
 *
 * 1. THE NAP REALTIME ENDPOINTS DEFAULT TO JSON, NOT PROTOBUF.
 *    `?format=protobuf` is required to get protobuf; `?format=json` and no
 *    parameter both give JSON; `?format=pb` is a 400 that helpfully lists
 *    `["json","protobuf"]`. We ask for protobuf because it is 2.2x to 3.2x
 *    smaller (De Lijn trip-update: 1,622,658 B vs 4,420,220 B) and decode it
 *    with the hand-written reader in ./gtfsrt.js.
 *
 * 2. STIB-MIVB PUBLISHES NO REALTIME ON THE NAP AT ALL.
 *    All three feeds return 404, under every slug spelling tried
 *    (stibmivb, stib, mivb):
 *        stibmivb/rt/trip-update       404
 *        stibmivb/rt/alert             404
 *        stibmivb/rt/vehicle-position  404
 *    `stibmivb` IS the right operator slug (its /static feed is what the bake
 *    reads 2,444 stops from). The realtime simply does not exist. This matters
 *    because City of Brussels is the densest pilot with 1,377 stops, most of
 *    them STIB. Those stops get scheduled service information and an honest
 *    line saying realtime is not published, never a spinner.
 *
 * 3. FULL REALTIME COVERAGE MATRIX, all four operators x three feeds:
 *
 *        operator   trip-update  alert  vehicle-position
 *        delijn         yes       yes         404
 *        tec            yes       yes         yes
 *        stibmivb       404       404         404
 *        nmbssncb       yes       yes         404
 *
 *    TEC is the only operator publishing vehicle positions, as PLAN says.
 *
 * 4. iRail CANNOT BE SENT A User-Agent FROM A BROWSER. See IRAIL_UA below.
 *
 * 5. NMBS parent_station MAPS TO THE iRail STATION KEY BY A DIGIT RULE.
 *    `gs:nmbssncb:S8892007` -> `BE.NMBS.008892007`: take the digit run, pad to
 *    9 with leading zeros, prefix `BE.NMBS.`. Checked against all 654 NMBS
 *    location_type=1 records and all 714 iRail stations: 554 of 654 carry a
 *    digit run and ALL 554 resolve to a real iRail station (100%). The other
 *    100 have no digits at all, e.g. `nmbssncb:s-aachenhbfde`,
 *    `nmbssncb:s-amsterdamcsnl`, `nmbssncb:s-avignontgvfr` — every one is a
 *    foreign or border station with no iRail entry. Those fall back to
 *    scheduled information instead of guessing.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS BAND CANNOT DO, STATED PLAINLY
 * ---------------------------------------------------------------------------
 * There is no baked timetable for bus, tram and metro. CONTRACT section 10.2
 * bakes `stops.txt` and `translations.txt` only, because the four `/static`
 * feeds are 287 MB and cannot ship. So for De Lijn, TEC and STIB-MIVB the only
 * departure times that exist are the live ones, and offline the band shows the
 * last board it stored with an "as of" stamp. For NMBS the same is true via
 * iRail. The UI says which of the two it is showing, every time, and never
 * implies a schedule it does not have.
 *
 * @module go
 */

import { neighbours, wgs84ToCell } from "./grid.js";
import { haversineMetres } from "./geo.js";
import { decodeTripUpdates, decodeAlerts, decodeVehiclePositions } from "./gtfsrt.js";

// ---------------------------------------------------------------- constants

const NAP =
  "https://api-management-discovery-production.azure-api.net/api/gtfs/feed";
const IRAIL = "https://api.irail.be/v1";

/**
 * THE TRUTH ABOUT THE iRail User-Agent.
 *
 * iRail's terms ask for a descriptive User-Agent with a contact address, and
 * CONTRACT section 10.1 records that as "required". From a browser it is
 * simply not possible, and pretending otherwise would be the dishonest option:
 *
 *   a) `User-Agent` is on the Fetch specification's *forbidden header name*
 *      list. `fetch(url, {headers: {"User-Agent": "BeHERE/1.0"}})` does not
 *      error, it silently drops the header. The browser's own UA is sent.
 *
 *   b) Nor can a substitute header be used. The CORS preflight, verified:
 *          OPTIONS https://api.irail.be/v1/liveboard/
 *          -> access-control-allow-headers: Content-Type
 *      Only `Content-Type` is allowed. An `X-Client` header would fail
 *      preflight and the request would never be sent.
 *
 *   c) It is not enforced anyway. Verified three ways, all HTTP 200 with an
 *      identical 13,912-byte body: a descriptive UA, a Safari UA, and no
 *      User-Agent header at all (`curl -H 'User-Agent:'`).
 *
 * The documented alternative identification is: none. There is no API key, no
 * client id, no registration. So we do the two things that are actually
 * available, and we say so in the source line rather than claiming compliance:
 *
 *   1. Identify in a query parameter. iRail ignores unknown parameters
 *      (`&client=`, `&user_agent=`, `&appid=` were each sent and each returned
 *      200 with byte-identical bodies), so this is free for them and puts a
 *      contactable string in their logs, which is what the UA request is for.
 *      Set `ctx.irailClient` to override; set it to "" to switch off.
 *   2. Be a genuinely light client: the 3 req/s ceiling is enforced locally by
 *      a single global queue, boards are cached 30 s, position is debounced,
 *      and nothing polls.
 *
 * The string below now names the live deployment and its public source repo,
 * which is what makes it contactable: the repo's issue tracker is the contact
 * channel, and it needs no email address in a public client. Set
 * `ctx.irailClient` to override, or to "" to remove the parameter entirely,
 * which is the right choice if iRail ever objects to unknown parameters.
 */
const IRAIL_CLIENT =
  "BeHERE/1.0 (+https://jdelsoir.github.io/behere/; https://github.com/jdelsoir/behere)";

/**
 * Which realtime feeds actually exist. Probed on 15 August 2026; see the
 * matrix in the file header. `false` here produces honest copy, not a retry.
 */
const RT_COVERAGE = {
  delijn: { tripUpdate: true, alert: true, vehiclePosition: false },
  tec: { tripUpdate: true, alert: true, vehiclePosition: true },
  stibmivb: { tripUpdate: false, alert: false, vehiclePosition: false },
  nmbssncb: { tripUpdate: true, alert: true, vehiclePosition: false },
};

/**
 * Measured protobuf sizes, 15 August 2026. Used to decide whether a feed is
 * worth fetching on a metered or slow connection, not for display.
 */
const RT_BYTES = {
  delijn: { tripUpdate: 1622658, alert: 17566 },
  tec: { tripUpdate: 487822, alert: 539580, vehiclePosition: 60896 },
  nmbssncb: { tripUpdate: 72209, alert: 86365 },
};

/** Feeds above this many bytes are skipped when the client asks us to save data. */
const SAVE_DATA_MAX_BYTES = 250000;

const OPERATOR_TITLE = {
  delijn: "De Lijn",
  tec: "TEC",
  stibmivb: "STIB-MIVB",
  nmbssncb: "NMBS-SNCB",
};

/** Source ids in web/data/meta.json, for the per-layer source line. */
const SOURCE_ID = {
  stops: "nap_gtfs_static",
  realtime: "nap_gtfs_rt",
  irail: "irail_liveboard",
};

const TTL_LIVE_MS = 30000; // CONTRACT 10.1 / 10.2: 30 s for boards and realtime
const DEBOUNCE_MS = 1200; // geolocation debounce (acceptance test 9)
const DEFAULT_STOP_LIMIT = 8;
const STORE_KEY = "behere.go.lastboards.v1";

// ------------------------------------------------------------------ helpers

/**
 * Great-circle distance in metres.
 *
 * Re-exported from `geo.js` rather than reimplemented, so the Go band and the
 * Around band can never disagree about which stop is nearest. Kept as a named
 * export because this module's own tests and callers reference it.
 */
export const haversineM = haversineMetres;

/**
 * The iRail station key for a baked NMBS stop, or "" when there is none.
 * See point 5 in the file header for how this was checked.
 * @param {{ps?: string, i?: string}} stop
 */
export function irailStationKey(stop) {
  const src = stop.ps || stop.i || "";
  const m = /(\d{4,})/.exec(src);
  if (!m) return ""; // foreign/border station, e.g. nmbssncb:s-aachenhbfde
  return "BE.NMBS." + m[1].padStart(9, "0");
}

/**
 * A stable key for one boarding point: the parent station if there is one.
 *
 * Takes either shape. The wire record out of a grid shard is {o, i, ps}; the
 * record stopsFromShards() hands to groupStops() is the normalised {op, id,
 * ps}. This function read only the wire names, so against the normalised
 * record both halves came out `undefined` and every STIB stop without a parent
 * station collapsed into ONE group: standing on the Grand-Place the band
 * offered a single boarding point with 238 platforms and hid the other 237
 * stops in the square. Dropping the operator out of the key was the second
 * half of the same bug, because STIB parent ids are bare numbers ("15", "65")
 * that another operator can also use.
 *
 * @param {{o?: string, op?: string, i?: string, id?: string, ps?: string}} stop
 */
function boardingKey(stop) {
  const op = stop.op || stop.o || "";
  const id = stop.ps || stop.id || stop.i || "";
  return op + "|" + id;
}

/**
 * A small time-to-live cache that deliberately keeps stale entries.
 *
 * CONTRACT section 10.0: "On expiry, serve stale immediately and revalidate",
 * and "every failure shows the layer's source and the age of what is
 * displayed". So `get` never throws away data, it reports how old it is.
 */
class TtlCache {
  constructor(ttlMs) {
    this.ttl = ttlMs;
    this.map = new Map();
  }
  /** @returns {{value: any, fresh: boolean, at: number, ageMs: number}|null} */
  get(key, now = Date.now()) {
    const e = this.map.get(key);
    if (!e) return null;
    const ageMs = now - e.at;
    return { value: e.value, at: e.at, ageMs, fresh: ageMs < this.ttl };
  }
  set(key, value, now = Date.now()) {
    this.map.set(key, { value, at: now });
    return value;
  }
}

/**
 * A single global queue for iRail: minimum spacing between requests, and a
 * cap on concurrency. 3 requests per second is the published ceiling, so the
 * spacing is 1000/3 rounded up.
 */
class RateLimiter {
  constructor({ minIntervalMs = 334, maxInFlight = 3 } = {}) {
    this.minInterval = minIntervalMs;
    this.maxInFlight = maxInFlight;
    this.queue = [];
    this.inFlight = 0;
    this.lastStart = 0;
    this.timer = null;
  }
  /** @param {() => Promise<any>} fn */
  run(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.#pump();
    });
  }
  #pump() {
    if (this.timer !== null) return;
    if (!this.queue.length || this.inFlight >= this.maxInFlight) return;
    const wait = Math.max(0, this.lastStart + this.minInterval - Date.now());
    if (wait > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.#pump();
      }, wait);
      return;
    }
    const job = this.queue.shift();
    this.inFlight++;
    this.lastStart = Date.now();
    Promise.resolve()
      .then(job.fn)
      .then(job.resolve, job.reject)
      .finally(() => {
        this.inFlight--;
        this.#pump();
      });
    this.#pump();
  }
}

/** Should we skip a large optional fetch? Honours the user's data preference. */
function saveDataOn() {
  const c =
    typeof navigator !== "undefined" &&
    (navigator.connection || navigator.mozConnection || navigator.webkitConnection);
  if (!c) return false;
  if (c.saveData) return true;
  return c.effectiveType === "slow-2g" || c.effectiveType === "2g";
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
}

/** Distance for humans: metres below 1 km, then one decimal of a kilometre. */
function fmtDistance(m) {
  if (!isFinite(m)) return "";
  if (m < 1000) return Math.round(m / 10) * 10 + " m";
  return (m / 1000).toFixed(1) + " km";
}

/**
 * "in 4 min", "now", or a clock time when it is further out.
 * Always returns the same shape, so callers never have to type-check it.
 */
function fmtWhen(epochSec, now, locale) {
  if (!epochSec) return { rel: "", abs: "" };
  const dMin = Math.round((epochSec * 1000 - now) / 60000);
  const abs = fmtClock(epochSec, locale);
  if (dMin <= 0) return { rel: "now", abs };
  if (dMin < 60) return { rel: dMin + " min", abs };
  return { rel: "", abs };
}

function fmtClock(epochSec, locale) {
  try {
    return new Date(epochSec * 1000).toLocaleTimeString(locale || undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    const d = new Date(epochSec * 1000);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }
}

/** An ISO-ish local timestamp for "as of" lines. */
function fmtStamp(ms, locale) {
  try {
    return new Date(ms).toLocaleString(locale || undefined, {
      dateStyle: "short",
      timeStyle: "short",
    });
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  }
}

// ------------------------------------------------------------------ the band

/**
 * Create the Go band.
 *
 * The band owns everything inside `section > [data-role="body"]` and sets
 * `section[data-state]`, per the DOM contract in index.html. It never touches
 * anything outside its own section.
 *
 * @param {HTMLElement} section  The `<section id="band-go">` element.
 * @param {Object} [ctx]         Injected dependencies. Every one is optional
 *                               and has a working default, so this module can
 *                               be mounted and tested on its own.
 * @param {string}   [ctx.base]         Data base path. Default "data/".
 * @param {Function} [ctx.fetch]        Default `globalThis.fetch`.
 * @param {Function} [ctx.now]          Clock, returns ms. Default `Date.now`.
 * @param {Function} [ctx.t]            UI string lookup, `(key) => string`.
 * @param {Function} [ctx.resolveLabel] CONTRACT section 9 resolver.
 * @param {string}   [ctx.uiLang]       "nl" | "fr" | "en". Default "en".
 * @param {Object}   [ctx.municipality] The `<nis>/meta.json` object.
 * @param {Object}   [ctx.override]     Parsed `i18n/en.json`.
 * @param {Function} [ctx.loadCell]     `(cellId) => Promise<shard|null>`.
 * @param {number}   [ctx.stopLimit]    How many boarding points to show.
 * @param {string}   [ctx.irailClient]  Override the identifying query value.
 * @param {Storage}  [ctx.storage]      Default `localStorage`.
 */
export function createGoBand(section, ctx = {}) {
  const cfg = {
    base: ctx.base || "data/",
    fetch: ctx.fetch || ((...a) => globalThis.fetch(...a)),
    now: ctx.now || (() => Date.now()),
    uiLang: ctx.uiLang || "en",
    stopLimit: ctx.stopLimit || DEFAULT_STOP_LIMIT,
    irailClient: ctx.irailClient === undefined ? IRAIL_CLIENT : ctx.irailClient,
    storage: ctx.storage || safeStorage(),
    municipality: ctx.municipality || null,
    override: ctx.override || null,
    resolveLabel: ctx.resolveLabel || null,
  };
  const t = makeT(ctx.t, () => cfg.uiLang);
  const body = section.querySelector('[data-role="body"]') || section;

  const cellCache = new Map();
  const liveCache = new TtlCache(TTL_LIVE_MS);
  const irailLimiter = new RateLimiter({ minIntervalMs: 334, maxInFlight: 3 });
  const napInFlight = new Map();

  let debounceTimer = null;
  let generation = 0;
  let lastFix = null;
  let destroyed = false;

  const lastBoards = loadStore(cfg.storage);

  // ------------------------------------------------------------ data access

  async function loadCell(id) {
    if (cellCache.has(id)) return cellCache.get(id);
    const p = (ctx.loadCell ? ctx.loadCell(id) : fetchCell(id)).catch(() => null);
    cellCache.set(id, p);
    return p;
  }

  async function fetchCell(id) {
    const r = await cfg.fetch(cfg.base + "grid/" + id + ".json", {
      credentials: "omit",
    });
    if (!r.ok) return null;
    return r.json();
  }

  /**
   * Stops from the 9 surrounding shards, nearest first.
   *
   * CONTRACT 7.5 mandates rendering from the centre cell first, then
   * correcting: the worst 9-cell read is 629 KB and first paint must not block
   * on it. So this yields twice — once with the centre shard, once complete.
   *
   * @param {{lat:number, lon:number}} fix
   * @param {(stops: any[], complete: boolean) => void} emit
   */
  async function collectStops(fix, emit) {
    const ids = neighbours(cellIdFor(fix));
    const centre = await loadCell(ids[0]);
    if (destroyed) return;
    let stops = stopsFromShards([centre], fix);
    emit(stops, false);
    const rest = await Promise.all(ids.slice(1).map(loadCell));
    if (destroyed) return;
    stops = stopsFromShards([centre, ...rest], fix);
    emit(stops, true);
  }

  function cellIdFor(fix) {
    // grid.js owns the cell maths; never reimplement it here.
    return fix.cell || wgs84ToCell(fix.lat, fix.lon);
  }

  function stopsFromShards(shards, fix) {
    const out = [];
    for (const s of shards) {
      if (!s || !Array.isArray(s.t)) continue; // CONTRACT 7.2: absent, not empty
      const oy = s.o[0];
      const ox = s.o[1];
      for (const st of s.t) {
        const lat = (oy + st.y) / 1e5;
        const lon = (ox + st.x) / 1e5;
        out.push({
          op: st.o,
          id: st.i,
          name: st.n,
          tr: st.t || null,
          ps: st.ps || "",
          lat,
          lon,
          cell: s.c,
          vintage: s.v,
          dist: haversineM(fix.lat, fix.lon, lat, lon),
        });
      }
    }
    out.sort((a, b) => a.dist - b.dist || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  }

  /**
   * Collapse platforms into boarding points.
   * CONTRACT 7.6: two TEC platforms sharing a `ps` are one place to stand.
   */
  function groupStops(stops, limit) {
    const groups = new Map();
    for (const s of stops) {
      const k = boardingKey(s);
      let g = groups.get(k);
      if (!g) {
        g = {
          key: k,
          op: s.op,
          name: s.name,
          tr: s.tr,
          ps: s.ps,
          lat: s.lat,
          lon: s.lon,
          dist: s.dist,
          vintage: s.vintage,
          members: [],
        };
        groups.set(k, g);
      }
      g.members.push(s);
      if (s.dist < g.dist) {
        g.dist = s.dist;
        g.lat = s.lat;
        g.lon = s.lon;
      }
    }
    return [...groups.values()].sort((a, b) => a.dist - b.dist).slice(0, limit);
  }

  // ------------------------------------------------------------------ iRail

  /**
   * A liveboard for one station.
   * Cached 30 s, rate limited to 3/s globally, never polled.
   */
  async function irailLiveboard(stationKey) {
    const key = "irail:" + stationKey + ":" + cfg.uiLang;
    const hit = liveCache.get(key, cfg.now());
    if (hit && hit.fresh) return { ...hit, stale: false };

    const url = new URL(IRAIL + "/liveboard/");
    url.searchParams.set("station", stationKey);
    url.searchParams.set("format", "json");
    // iRail's `lang` really is a parameter, and it is the only runtime source
    // with authored English station names (CONTRACT 10.1).
    url.searchParams.set("lang", cfg.uiLang === "en" ? "en" : cfg.uiLang);
    if (cfg.irailClient) url.searchParams.set("client", cfg.irailClient);

    try {
      const r = await irailLimiter.run(() =>
        cfg.fetch(url.toString(), { credentials: "omit" })
      );
      if (!r.ok) throw new Error("iRail HTTP " + r.status);
      const j = await r.json();
      const board = normaliseLiveboard(j);
      liveCache.set(key, board, cfg.now());
      rememberBoard(stationKey, board);
      return { value: board, fresh: true, stale: false, at: cfg.now(), ageMs: 0 };
    } catch (err) {
      // Serve stale, then the persisted last-known board. Never nothing.
      if (hit) return { ...hit, stale: true, error: err };
      const stored = lastBoards.irail && lastBoards.irail[stationKey];
      if (stored) {
        return {
          value: stored.board,
          fresh: false,
          stale: true,
          at: stored.at,
          ageMs: cfg.now() - stored.at,
          error: err,
          fromStore: true,
        };
      }
      return { value: null, fresh: false, stale: true, at: 0, ageMs: 0, error: err };
    }
  }

  function normaliseLiveboard(j) {
    const st = j.stationinfo || {};
    const deps = (j.departures && j.departures.departure) || [];
    return {
      station: j.station || st.name || "",
      stationId: st.id || "",
      timestamp: Number(j.timestamp || 0),
      departures: deps.map((d) => ({
        time: Number(d.time || 0),
        delay: Number(d.delay || 0),
        canceled: d.canceled === "1" || d.canceled === 1,
        left: d.left === "1" || d.left === 1,
        platform: d.platform || "",
        platformNormal:
          !d.platforminfo || d.platforminfo.normal === "1" || d.platforminfo.normal === 1,
        destination: d.station || "",
        vehicle: (d.vehicle && (d.vehicle.shortname || d.vehicle.name)) || d.vehicle || "",
        occupancy: (d.occupancy && d.occupancy.name) || "",
      })),
    };
  }

  // -------------------------------------------------------------- NAP GTFS-RT

  /**
   * Fetch and decode a realtime feed, once per 30 s per feed.
   *
   * Returns raw bytes decoded through ./gtfsrt.js. Requests protobuf
   * explicitly: the endpoint's default is JSON and protobuf is 2.2-3.2x
   * smaller. Large feeds are skipped when the client asked to save data.
   *
   * @param {"delijn"|"tec"|"nmbssncb"} op
   * @param {"trip-update"|"alert"|"vehicle-position"} feed
   */
  async function napFeed(op, feed) {
    const camel =
      feed === "trip-update"
        ? "tripUpdate"
        : feed === "vehicle-position"
        ? "vehiclePosition"
        : "alert";
    const cov = RT_COVERAGE[op];
    if (!cov || !cov[camel]) {
      return { value: null, unavailable: true, reason: "not-published" };
    }
    const size = (RT_BYTES[op] || {})[camel] || 0;
    if (saveDataOn() && size > SAVE_DATA_MAX_BYTES) {
      return { value: null, unavailable: true, reason: "save-data", size };
    }

    const key = "nap:" + op + ":" + feed;
    const hit = liveCache.get(key, cfg.now());
    if (hit && hit.fresh) return { ...hit, unavailable: false };
    if (napInFlight.has(key)) return napInFlight.get(key);

    const url = `${NAP}/${op}/rt/${feed}?format=protobuf`;
    const p = (async () => {
      try {
        const r = await cfg.fetch(url, { credentials: "omit" });
        if (!r.ok) throw new Error("NAP HTTP " + r.status);
        const bytes = new Uint8Array(await r.arrayBuffer());
        const v = { bytes, at: cfg.now() };
        liveCache.set(key, v, cfg.now());
        return { value: v, fresh: true, at: cfg.now(), ageMs: 0, unavailable: false };
      } catch (err) {
        if (hit) return { ...hit, stale: true, error: err, unavailable: false };
        return { value: null, unavailable: true, reason: "error", error: err };
      } finally {
        napInFlight.delete(key);
      }
    })();
    napInFlight.set(key, p);
    return p;
  }

  /**
   * Predicted departures for the shown stops of one operator.
   * The decode is lazy: only the on-screen stop_ids are materialised.
   */
  async function realtimeFor(op, stopIds) {
    const res = await napFeed(op, "trip-update");
    if (!res.value) return { rows: new Map(), meta: res };
    const dec = decodeTripUpdates(res.value.bytes, stopIds);
    return { rows: dec.byStop, feedTs: dec.timestamp, scanned: dec.scanned, meta: res };
  }

  async function alertsFor(op, stopIds) {
    const res = await napFeed(op, "alert");
    if (!res.value) return { alerts: [], meta: res };
    const dec = decodeAlerts(res.value.bytes, stopIds, []);
    return { alerts: dec.alerts, meta: res };
  }

  async function vehiclesFor(op) {
    const res = await napFeed(op, "vehicle-position");
    if (!res.value) return { vehicles: [], meta: res };
    const dec = decodeVehiclePositions(res.value.bytes);
    return { vehicles: dec.vehicles, meta: res };
  }

  // --------------------------------------------------------------- persistence

  function rememberBoard(stationKey, board) {
    if (!lastBoards.irail) lastBoards.irail = {};
    lastBoards.irail[stationKey] = { at: cfg.now(), board };
    saveStore(cfg.storage, lastBoards);
  }

  function rememberDepartures(groupKey, rows) {
    if (!lastBoards.nap) lastBoards.nap = {};
    lastBoards.nap[groupKey] = { at: cfg.now(), rows };
    saveStore(cfg.storage, lastBoards);
  }

  // ------------------------------------------------------------------ render

  function setState(s) {
    section.setAttribute("data-state", s);
  }

  function clear() {
    while (body.firstChild) body.removeChild(body.firstChild);
  }

  /** The label for a stop, through the CONTRACT section 9 resolver. */
  function stopLabel(group) {
    const entity = {
      id: group.ps || group.members[0].id,
      name: Object.assign({}, group.tr || {}, {}),
    };
    // The authored stop_name has no language tag; treat it as the region
    // default so the resolver can fall through to it honestly.
    const regionDefault =
      (cfg.municipality && cfg.municipality.lang && cfg.municipality.lang.default) || "nl";
    if (!entity.name[regionDefault]) entity.name[regionDefault] = group.name;
    if (cfg.resolveLabel) {
      const r = cfg.resolveLabel(entity, "stop", cfg.uiLang, {
        override: cfg.override || {},
        regionDefault,
      });
      return r && r.text ? r : { text: group.name, lang: regionDefault, translated: false, step: 3 };
    }
    const direct = entity.name[cfg.uiLang];
    if (direct) return { text: direct, lang: cfg.uiLang, translated: true, step: 1 };
    return { text: group.name, lang: regionDefault, translated: false, step: 3 };
  }

  /**
   * Render the whole band.
   *
   * `groups` is never empty when this is called with rows: the caller checks
   * and renders the collapsed, explanatory state instead (never a blank card).
   */
  /**
   * Hand the shell a flat snapshot of what is actually on screen.
   *
   * offline.html reads one key, `behere.departures`, written by
   * main.js's ctx.rememberDepartures. This band's own store is keyed by
   * boarding point and holds a different shape, so without this the offline
   * page could only ever say "nothing has been fetched on this device yet" —
   * true, permanently, no matter how many boards had been fetched.
   *
   * Only live rows are offered. A scheduled row is not a departure this device
   * ever "saw", and PLAN section 6 asks for the last-known DEPARTURES with an
   * explicit "as of", not a timetable reprint.
   */
  function snapshotForShell(view) {
    if (typeof ctx.rememberDepartures !== "function") return;
    const items = [];
    for (const g of view.groups) {
      const dep = view.departures.get(g.key);
      if (!dep || dep.kind !== "live" || !Array.isArray(dep.rows)) continue;
      const stop = stopLabel(g).text;
      for (const r of dep.rows.slice(0, 4)) {
        items.push({
          stop,
          headsign: r.destination || r.line || "",
          time: r.time ? new Date(r.time * 1000).toISOString() : "",
          cancelled: !!r.canceled,
        });
      }
      if (items.length >= 12) break;
    }
    if (!items.length) return;
    const place = (cfg.municipality && cfg.municipality.name &&
      (cfg.municipality.name[cfg.uiLang] || cfg.municipality.name.fr ||
       cfg.municipality.name.nl)) || "";
    try {
      ctx.rememberDepartures(items, place);
    } catch (e) {
      /* quota or private mode: the band itself is unaffected */
    }
  }

  function render(view) {
    clear();
    snapshotForShell(view);
    const frag = document.createDocumentFragment();

    if (view.note) frag.appendChild(noteEl(view.note));

    const list = el("ol", "go-stops");
    list.setAttribute("aria-label", t("go.stops.label", "Nearest stops"));

    for (const g of view.groups) {
      const li = el("li", "go-stop");
      li.setAttribute("data-op", g.op);

      const head = el("div", "go-stop-head");
      const label = stopLabel(g);
      const name = el("h3", "go-name", label.text);
      name.lang = label.lang;
      head.appendChild(name);

      const op = el("span", "go-op", OPERATOR_TITLE[g.op] || g.op);
      op.setAttribute("data-op", g.op);
      head.appendChild(op);

      const dist = el("span", "go-dist", fmtDistance(g.dist));
      dist.setAttribute("data-metres", String(Math.round(g.dist)));
      head.appendChild(dist);

      if (g.members.length > 1) {
        head.appendChild(
          el(
            "span",
            "go-platforms",
            t("go.platforms", "{n} platforms").replace("{n}", String(g.members.length))
          )
        );
      }
      li.appendChild(head);

      const dep = view.departures.get(g.key);
      li.appendChild(departuresEl(g, dep, view.nowMs));

      const al = view.alerts.get(g.key);
      if (al && al.length) li.appendChild(alertsEl(al));

      list.appendChild(li);
    }
    frag.appendChild(list);

    for (const n of view.footNotes) frag.appendChild(noteEl(n));
    frag.appendChild(sourceEl(view));

    body.appendChild(frag);
    setState(view.groups.length ? "ready" : "empty");
  }

  function departuresEl(group, dep, nowMs) {
    // Never an empty panel: every branch below writes copy that names what is
    // missing and why (PLAN section 6, CONTRACT 10.1 / 10.2).
    if (!dep || dep.kind === "none") {
      const reason =
        dep && dep.reason === "not-published"
          ? t(
              "go.rt.none",
              "{op} does not publish realtime departures on the NAP. This stop is served, but no live times exist."
            ).replace("{op}", OPERATOR_TITLE[group.op] || group.op)
          : dep && dep.reason === "save-data"
          ? t(
              "go.rt.savedata",
              "Live departures skipped to save data. The {op} feed is {mb} MB."
            )
              .replace("{op}", OPERATOR_TITLE[group.op] || group.op)
              .replace("{mb}", ((dep.size || 0) / 1048576).toFixed(1))
          : t("go.rt.unavailable", "Live departures unavailable. The stop itself is stored on this device.");
      return noteEl(reason, "go-note");
    }

    const wrap = el("div", "go-deps-wrap");
    if (dep.stale) {
      wrap.appendChild(
        noteEl(
          t("go.asof", "Live departures unavailable. Showing the last board seen, as of {when}.").replace(
            "{when}",
            fmtStamp(dep.at, cfg.uiLang)
          ),
          "go-asof"
        )
      );
      wrap.setAttribute("data-stale", "true");
    }

    if (!dep.rows.length) {
      wrap.appendChild(
        noteEl(
          t("go.nodepartures", "No departures in the next hour."),
          "go-note"
        )
      );
      return wrap;
    }

    const ol = el("ol", "go-deps");
    for (const r of dep.rows.slice(0, 6)) {
      const li = el("li", "go-dep");
      if (r.canceled) li.setAttribute("data-cancelled", "true");

      const when = fmtWhen(r.time, nowMs, cfg.uiLang);
      const time = el("span", "go-time");
      const tt = el("time", null, when.abs);
      if (r.time) tt.dateTime = new Date(r.time * 1000).toISOString();
      time.appendChild(tt);
      if (when.rel) time.appendChild(el("span", "go-rel", when.rel));
      li.appendChild(time);

      if (r.line) li.appendChild(el("span", "go-line", r.line));
      if (r.destination) li.appendChild(el("span", "go-dest", r.destination));

      if (r.canceled) {
        li.appendChild(el("span", "go-cancelled", t("go.cancelled", "Cancelled")));
      } else if (r.delay) {
        const mins = Math.round(r.delay / 60);
        const d = el(
          "span",
          "go-delay",
          (mins > 0 ? "+" : "") + mins + " " + t("go.min", "min")
        );
        d.setAttribute("data-delay", mins > 0 ? "late" : mins < 0 ? "early" : "ontime");
        li.appendChild(d);
      }

      if (r.platform) {
        const p = el("span", "go-platform", r.platform);
        if (r.platformChanged) p.setAttribute("data-changed", "true");
        li.appendChild(p);
      }
      ol.appendChild(li);
    }
    wrap.appendChild(ol);

    if (dep.scheduledOnly) {
      wrap.appendChild(
        noteEl(t("go.scheduled", "Realtime unavailable, times are scheduled."), "go-note")
      );
    }
    return wrap;
  }

  function alertsEl(alerts) {
    const d = el("details", "go-alerts");
    const s = el("summary", null, t("go.alerts", "Service messages") + " (" + alerts.length + ")");
    d.appendChild(s);
    const box = el("div", "disclosure-body");
    for (const a of alerts.slice(0, 4)) {
      const item = el("div", "go-alert");
      item.setAttribute("data-effect", a.effect);
      // Alerts carry operator-authored translations including English.
      const txt = pickTranslation(a.header, cfg.uiLang);
      const h = el("h4", "go-alert-head", txt.text);
      h.lang = txt.lang;
      item.appendChild(h);
      const body2 = pickTranslation(a.description, cfg.uiLang);
      if (body2.text) {
        const p = el("p", "go-alert-body", body2.text);
        p.lang = body2.lang;
        item.appendChild(p);
      }
      box.appendChild(item);
    }
    d.appendChild(box);
    return d;
  }

  function noteEl(text, cls) {
    const p = el("p", cls || "quiet", text);
    return p;
  }

  /**
   * Acceptance test 8: every layer displays its source and its vintage date.
   * The ids join to web/data/meta.json, which is where the text lives, so no
   * source string is duplicated here.
   */
  function sourceEl(view) {
    const p = el("p", "go-src");
    p.setAttribute("data-sources", view.sourceIds.join(" "));
    const parts = [];
    parts.push(
      t("go.src.stops", "Stops: NAP GTFS, baked {vintage}.").replace(
        "{vintage}",
        view.stopsVintage || "2025-01-01"
      )
    );
    if (view.liveAt) {
      parts.push(
        t("go.src.live", "Live data {when}.").replace("{when}", fmtStamp(view.liveAt, cfg.uiLang))
      );
    }
    if (view.irailUsed) {
      // Be honest about the User-Agent, rather than claiming compliance.
      parts.push(
        t(
          "go.src.irail",
          "Train times from iRail. A browser cannot send a custom User-Agent, so this client identifies in a query parameter and stays under 3 requests per second."
        )
      );
    }
    p.textContent = parts.join(" ");
    return p;
  }

  function pickTranslation(map, lang) {
    if (!map) return { text: "", lang: "" };
    if (map[lang]) return { text: map[lang], lang };
    for (const l of ["nl", "fr", "de", "en", ""]) {
      if (map[l]) return { text: map[l], lang: l || "und" };
    }
    const k = Object.keys(map)[0];
    return k !== undefined ? { text: map[k], lang: k || "und" } : { text: "", lang: "" };
  }

  // ------------------------------------------------------------- orchestration

  /** Build the departures view for every group, live where possible. */
  async function buildDepartures(groups, gen) {
    /** @type {Map<string, any>} */
    const departures = new Map();
    const alerts = new Map();
    const sourceIds = new Set([SOURCE_ID.stops]);
    let liveAt = 0;
    let irailUsed = false;

    // --- trains, one iRail liveboard per station -----------------------------
    const trains = groups.filter((g) => g.op === "nmbssncb");
    await Promise.all(
      trains.map(async (g) => {
        const key = irailStationKey({ ps: g.ps, i: g.members[0].id });
        if (!key) {
          departures.set(g.key, {
            kind: "none",
            reason: "not-published",
          });
          return;
        }
        irailUsed = true;
        sourceIds.add(SOURCE_ID.irail);
        const res = await irailLiveboard(key);
        if (gen !== generation) return;
        if (!res.value) {
          departures.set(g.key, { kind: "none", reason: "error" });
          return;
        }
        if (res.at > liveAt) liveAt = res.at;
        const rows = res.value.departures
          .filter((d) => !d.left)
          .map((d) => ({
            time: d.time + (d.delay || 0),
            delay: d.delay,
            canceled: d.canceled,
            destination: d.destination,
            line: d.vehicle,
            platform: d.platform,
            platformChanged: !d.platformNormal,
          }));
        departures.set(g.key, {
          kind: "live",
          rows,
          stale: res.stale || res.fromStore || false,
          at: res.at,
        });
      })
    );

    // --- bus, tram, metro: NAP realtime --------------------------------------
    const byOp = new Map();
    for (const g of groups) {
      if (g.op === "nmbssncb") continue;
      if (!byOp.has(g.op)) byOp.set(g.op, []);
      byOp.get(g.op).push(g);
    }

    await Promise.all(
      [...byOp.entries()].map(async ([op, gs]) => {
        const stopIds = [];
        for (const g of gs) for (const m of g.members) stopIds.push(m.id);

        const cov = RT_COVERAGE[op];
        if (!cov || !cov.tripUpdate) {
          // STIB-MIVB lands here: no realtime exists on the NAP at all.
          for (const g of gs) departures.set(g.key, { kind: "none", reason: "not-published" });
          return;
        }
        sourceIds.add(SOURCE_ID.realtime);

        const [rt, al] = await Promise.all([
          realtimeFor(op, stopIds),
          cov.alert ? alertsFor(op, stopIds) : Promise.resolve({ alerts: [] }),
        ]);
        if (gen !== generation) return;

        if (rt.meta && rt.meta.unavailable) {
          for (const g of gs) {
            const stored = (lastBoards.nap || {})[g.key];
            if (stored) {
              departures.set(g.key, {
                kind: "live",
                rows: stored.rows,
                stale: true,
                at: stored.at,
              });
            } else {
              departures.set(g.key, {
                kind: "none",
                reason: rt.meta.reason,
                size: rt.meta.size,
              });
            }
          }
          return;
        }
        if (rt.meta && rt.meta.at > liveAt) liveAt = rt.meta.at;

        for (const g of gs) {
          const rows = [];
          for (const m of g.members) {
            for (const r of rt.rows.get(m.id) || []) {
              if (r.skipped) {
                rows.push({ time: r.time, canceled: true, line: r.routeId, destination: "" });
                continue;
              }
              // NO_DATA means the operator explicitly has no prediction for
              // this stop. TEC uses it heavily while still setting a
              // trip-level delay; showing that delay here would be inventing
              // a time the operator did not give.
              if (r.noData) continue;
              if (!r.time) continue;
              rows.push({
                time: r.time,
                delay: r.delay || 0,
                canceled: false,
                line: r.routeId,
                destination: "",
              });
            }
          }
          rows.sort((a, b) => a.time - b.time);
          const nowSec = Math.floor(cfg.now() / 1000);
          const future = rows.filter((r) => r.time >= nowSec - 60);
          if (future.length) rememberDepartures(g.key, future);
          departures.set(g.key, {
            kind: "live",
            rows: future,
            stale: !!(rt.meta && rt.meta.stale),
            at: (rt.meta && rt.meta.at) || cfg.now(),
          });

          if (al.alerts && al.alerts.length) {
            const mine = al.alerts.filter(
              (a) => a.agencyWide || a.stops.some((s) => g.members.some((m) => m.id === s))
            );
            if (mine.length) alerts.set(g.key, mine);
          }
        }
      })
    );

    return { departures, alerts, sourceIds: [...sourceIds], liveAt, irailUsed };
  }

  async function run(fix) {
    const gen = ++generation;
    setState("loading");
    let painted = false;

    await collectStops(fix, (stops, complete) => {
      if (gen !== generation || destroyed) return;
      const groups = groupStops(stops, cfg.stopLimit);
      if (!groups.length) {
        if (complete) renderNoStops(fix);
        return;
      }
      if (!painted || complete) {
        // First paint from the centre shard alone, so nothing waits on 629 KB.
        render({
          groups,
          departures: new Map(),
          alerts: new Map(),
          nowMs: cfg.now(),
          sourceIds: [SOURCE_ID.stops],
          stopsVintage: groups[0].vintage,
          liveAt: 0,
          irailUsed: false,
          note: null,
          footNotes: complete
            ? []
            : [t("go.loading", "Checking the surrounding squares…")],
        });
        painted = true;
      }
      if (complete) {
        buildDepartures(groups, gen).then((live) => {
          if (gen !== generation || destroyed) return;
          render({
            groups,
            departures: live.departures,
            alerts: live.alerts,
            nowMs: cfg.now(),
            sourceIds: live.sourceIds,
            stopsVintage: groups[0].vintage,
            liveAt: live.liveAt,
            irailUsed: live.irailUsed,
            note: null,
            footNotes: footNotesFor(groups),
          });
        });
      }
    });
  }

  /** Honest copy naming exactly which operator has no realtime, once. */
  function footNotesFor(groups) {
    const notes = [];
    const ops = new Set(groups.map((g) => g.op));
    for (const op of ops) {
      const cov = RT_COVERAGE[op];
      if (cov && !cov.tripUpdate) {
        notes.push(
          t(
            "go.rt.operator.none",
            "{op} publishes no realtime feed on the national access point, so no live times are shown for its stops."
          ).replace("{op}", OPERATOR_TITLE[op] || op)
        );
      }
    }
    return notes;
  }

  function renderNoStops(fix) {
    clear();
    body.appendChild(
      noteEl(
        t(
          "go.nostops",
          "No stop of De Lijn, TEC, STIB-MIVB or NMBS-SNCB is recorded within about a kilometre of here. The stop index is baked from the national access point, vintage 2025-01-01."
        )
      )
    );
    body.appendChild(
      sourceEl({ sourceIds: [SOURCE_ID.stops], stopsVintage: "2025-01-01", liveAt: 0, irailUsed: false })
    );
    setState("empty");
  }

  // ---------------------------------------------------------------- public API

  /**
   * One debounce, shared by every setter.
   *
   * The shell resolves a fix in three paints and pushes position, then the
   * municipality once it has loaded <nis>/meta.json. Re-running on the spot for
   * the municipality meant two full realtime fetches per position, and the
   * De Lijn feed alone is 1.58 MB. One timer collapses them. It is a one-shot
   * timer, cleared on destroy: nothing here polls (acceptance test 9).
   */
  function schedule() {
    if (destroyed || !lastFix) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    const fix = lastFix;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      run(fix);
    }, DEBOUNCE_MS);
  }

  return {
    id: "go",

    /**
     * New position. Debounced: acceptance test 9 forbids a polling loop and
     * requires geolocation to be debounced.
     * @param {{lat:number, lon:number, cell?:string}} fix
     */
    setPosition(fix) {
      if (!fix || !isFinite(fix.lat) || !isFinite(fix.lon)) return;
      if (
        lastFix &&
        Math.abs(lastFix.lat - fix.lat) < 1e-5 &&
        Math.abs(lastFix.lon - fix.lon) < 1e-5
      ) {
        return; // under ~1 m: nothing to redraw
      }
      lastFix = fix;
      schedule();
    },

    /**
     * The municipality the shell resolved the position to.
     *
     * It decides `regionDefault`, which is step 3 of the stop-name resolver:
     * without it every TEC and De Lijn stop in Wallonia would be resolved
     * against "nl". It cannot be passed at mount, because no position is known
     * then, so the shell pushes it as soon as the NIS is resolved.
     */
    setMunicipality(m) {
      if (cfg.municipality === m) return;
      cfg.municipality = m || null;
      schedule();
    },

    /** Language switch: re-render with what is already cached, no refetch. */
    setLanguage(lang) {
      if (cfg.uiLang === lang) return;
      cfg.uiLang = lang;
      schedule();
    },

    /** Explicit user action only. Nothing in this module polls. */
    refresh() {
      if (lastFix) run(lastFix);
    },

    destroy() {
      destroyed = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      generation++;
    },

    // exposed for tests
    _internals: { groupStops, stopsFromShards, irailStationKey, RT_COVERAGE },
  };
}

// ------------------------------------------------------------------ plumbing

/**
 * The inline "this is not in your language" marker. Must stay byte-identical
 * to i18n.js's UNTRANSLATED_MARK; this module takes its strings through ctx
 * and imports no i18n module, so it cannot import the constant.
 */
const UNTRANSLATED_MARK = " *";

/**
 * @param {Function} [fn]      ctx.t, the shell's bound chrome lookup
 * @param {Function} [langOf]  () => the ACTIVE UI language. A function, not a
 *        string, because setLanguage() mutates cfg.uiLang after this closure
 *        is built and a captured string would freeze the marker at mount.
 */
function makeT(fn, langOf) {
  return (key, fallback) => {
    if (fn) {
      const v = fn(key);
      if (v && v !== key) return v;
    }
    if (fallback === undefined) return key;
    // Acceptance test 4, second clause: this module's own English standing in
    // for a missing Dutch or French string is an untranslated string, and must
    // be marked rather than pass as a translation.
    const lang = typeof langOf === "function" ? langOf() : langOf;
    return lang && lang !== "en" ? fallback + UNTRANSLATED_MARK : fallback;
  };
}

function safeStorage() {
  try {
    const s = globalThis.localStorage;
    s.setItem("behere.probe", "1");
    s.removeItem("behere.probe");
    return s;
  } catch {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, v),
      removeItem: (k) => m.delete(k),
    };
  }
}

function loadStore(storage) {
  try {
    const raw = storage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveStore(storage, obj) {
  try {
    storage.setItem(STORE_KEY, JSON.stringify(obj));
  } catch {
    /* quota or private mode: the in-memory cache still works */
  }
}

export default createGoBand;
