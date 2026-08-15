/**
 * BeHERE map engine.
 *
 * A full-bleed slippy map built out of plain DOM: an OSM raster underlay of
 * <img> tiles, a warm veil, one SVG carrying the vector layers, absolutely
 * positioned marker pills, and the position dot. No framework, no bundler, no
 * CDN, no map library. It is mounted once by the shell and driven by method
 * calls; it knows nothing about bands, i18n or fetching.
 *
 * WHAT IT DRAWS, bottom to top (UI_SPEC 1.1)
 *
 *   1  .map-tiles      OSM raster, always on, washed by --map-tile-filter
 *   2  .map-veil       radial ground veil, CSS only
 *   3  path.map-cell   the GRD_NEWID 1 km square, projected from EPSG:3035
 *   4  g.map-sectors   <nis>/sector.geojson, current sector emphasised
 *   5  circle.map-accuracy   the real fix accuracy, clamped
 *   6  .map-marker     stop and POI pills, selected one on top
 *   7  .map-position   the dot, its casing and its pulse
 *
 * OFFLINE IS THE DEFAULT CASE, NOT THE FALLBACK.
 * Layers 3 to 7 are drawn from baked shards and from the device's own fix.
 * They do not know whether a tile ever arrived. If the network is gone, the
 * tile layer paints nothing and the vector map answers "where am I" on the
 * token ground colour, which is why acceptance test 1 is untouched by this
 * file (that test is headless over sw.js and geo.js and never mounts a map).
 *
 * THE OSM TILE USAGE POLICY IS A CONSTRAINT, NOT A PREFERENCE.
 *   - Only tiles that intersect the current viewport are ever requested. The
 *     prototype's +1 speculative ring is deliberately not reproduced.
 *   - No prefetch, no warming, no loop that walks a bounding box.
 *   - A zoom change waits TILE_SETTLE_MS before asking for anything, so a fast
 *     "- - -" never fetches the levels it passed through.
 *   - Three failures in one viewport stop tile requests for TILE_COOLDOWN_MS.
 *   - Save-data and prefers-reduced-data mean no tile is requested at all.
 *   - Tiles are runtime-cached by sw.js in its own cache. They MUST NOT appear
 *     in precache.json; precaching 674 cells' worth of basemap is bulk
 *     downloading and an explicit breach of the policy.
 *   - "(c) OpenStreetMap contributors" is rendered outside the map region,
 *     linking to the copyright page. That is an ODbL licence term.
 *
 * ACCESSIBILITY
 * Two postures, chosen by the `keyboard` option below.
 *
 *   keyboard: false (the default, and what a bare `createMap` gives you)
 *     #map is aria-hidden, holds no focusable node, and cannot be entered.
 *
 *   keyboard: true (what the BeHERE shell passes, UI_SPEC 3.6)
 *     #map is a role="group" with ONE tab stop and an aria-label that names
 *     the keys. Arrows pan, +/- zoom, Home recentres. It is still not a trap:
 *     Tab and Escape are NEVER intercepted, so focus can always leave, and the
 *     stop count is one no matter how many markers are drawn.
 *
 * In BOTH postures the drawn layers carry their own aria-hidden and the
 * markers are role="presentation" spans, so 49 Brussels stops never become 49
 * tab stops or 49 announcements; their keyboard equivalent is the Go band's
 * ordered list, in the same distance order. The attribution link and the
 * status region are created as SIBLINGS of #map so the link is a tab stop of
 * its own in either posture.
 *
 * NO COLOUR, NO SIZE AND NO SHADOW IS WRITTEN IN THIS FILE.
 * Everything visual comes from app/map.css, which reads app/tokens.css. The
 * only numbers here are geometry.
 */

import {
  TILE_SIZE, MIN_ZOOM, MAX_ZOOM, DEFAULT_ZOOM,
  worldSize, lonToX, latToY, xToLon, yToLat,
  metresPerPixel as mppAt, tilesForViewport,
  laeaInverse, cellRing, geometryBounds, boundsIntersect,
} from "./mercator.js";

import { haversineMetres } from "./geo.js";

// ---------------------------------------------------------------------------
// 0. Constants
// ---------------------------------------------------------------------------

/**
 * The one tile host. Hard-coded, keyless, no query string, so acceptance test
 * 7's grep for `key=` / `token` finds nothing, and index.html's CSP can name
 * exactly this host on img-src and nothing else.
 */
const TILE_HOST = "https://tile.openstreetmap.org/";

/** ODbL attribution. NOT an i18n key: translating an attribution loses it. */
const OSM_COPYRIGHT_URL = "https://www.openstreetmap.org/copyright";
const OSM_ATTRIBUTION = "© OpenStreetMap contributors";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Zoom changes wait this long before any tile is requested (UI_SPEC 1.2). */
const TILE_SETTLE_MS = 120;
/** Errors in one viewport before the tile layer gives up. */
const TILE_ERROR_LIMIT = 3;
/** How long it stays given up before trying again. */
const TILE_COOLDOWN_MS = 60000;

/** Markers within this many pixels of the viewport edge stay in the DOM. */
const MARKER_MARGIN_PX = 64;
/** Sector features whose bbox misses the viewport by more than this are cut. */
const VECTOR_MARGIN_PX = 64;
/** How many markers carry a visible label (UI_SPEC 1.5). */
const LABELLED_MARKERS = 8;

/** Accuracy circle bounds, in pixels and as a share of the smaller viewport. */
const ACCURACY_MIN_PX = 10;
const ACCURACY_MAX_SHARE = 0.4;

/** Pointer travel under this is a tap, not a drag. */
const TAP_SLOP_PX = 4;
/** Wheel delta accumulated before one integer zoom step. */
const WHEEL_STEP = 60;
/** Pinch ratio that trips one integer zoom step. */
const PINCH_STEP = Math.SQRT2;
/** Keyboard pan, CSS pixels per press. */
const KEY_PAN_PX = 80;

/** Optical-centre tween, matched to the panel transition (UI_SPEC 3.3). */
const DOCK_TWEEN_MS = 240;

/** Screen-reader status is announced this long after the last movement. */
const STATUS_QUIET_MS = 700;

/** Off-centre test, verbatim from the prototype (UI_SPEC 3.4 item 2). */
const OFF_CENTRE_LAT = 0.0008;
const OFF_CENTRE_LON = 0.0012;

/** The three toggleable vector layers. */
export const LAYERS = Object.freeze(["cell", "sector", "stops"]);

/** English defaults. The shell overrides these through setStrings(). */
const DEFAULT_STRINGS = Object.freeze({
  status: "Map at {m} m per 100 pixels, centred on your position.",
  label: "Map of where you are",
});

// ---------------------------------------------------------------------------
// 1. Small DOM helpers. No innerHTML anywhere in this file.
// ---------------------------------------------------------------------------

function el(tag, cls) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
}

function svg(tag, cls) {
  const n = document.createElementNS(SVG_NS, tag);
  if (cls) n.setAttribute("class", cls);
  return n;
}

function prefersReducedMotion() {
  return typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Should the basemap be requested at all?
 * Save-data and prefers-reduced-data are user statements about bytes, and a
 * decorative raster underlay is exactly the thing they mean.
 */
function dataSaverOn() {
  try {
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (c && c.saveData) return true;
  } catch (e) { /* no connection API, carry on */ }
  try {
    if (typeof matchMedia === "function" &&
        matchMedia("(prefers-reduced-data: reduce)").matches) return true;
  } catch (e) { /* older engine, carry on */ }
  return false;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
// 2. Turning baked stops into markers
// ---------------------------------------------------------------------------

/**
 * Group decoded stops (geo.js `stopsOf()` shape) into boarding points.
 *
 * CONTRACT 7.2: `ps` is the parent station, and for NMBS it is the iRail
 * station key. Two TEC platforms of one stop share a `ps`, so drawing both
 * puts two pills on one pavement. go.js already groups its list this way; this
 * helper exists so the map and the list cannot disagree about what a stop is.
 *
 * @param {Array<{operator:string,id:string,name:string,parent:?string,lat:number,lon:number}>} stops
 * @returns {Array<{key:string,lat:number,lon:number,label:string,operator:string,ids:string[]}>}
 */
export function stopsToMarkers(stops) {
  const groups = new Map();
  for (const s of stops || []) {
    if (!s || typeof s.lat !== "number" || typeof s.lon !== "number") continue;
    const key = s.parent || s.id;
    if (!key) continue;
    let g = groups.get(key);
    if (!g) {
      g = { key, lat: 0, lon: 0, n: 0, label: s.name || key, operator: s.operator || "", ids: [] };
      groups.set(key, g);
    }
    g.lat += s.lat;
    g.lon += s.lon;
    g.n += 1;
    g.ids.push(s.id);
  }
  const out = [];
  for (const g of groups.values()) {
    out.push({
      key: g.key,
      lat: g.lat / g.n,
      lon: g.lon / g.n,
      label: g.label,
      operator: g.operator,
      ids: g.ids,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. createMap
// ---------------------------------------------------------------------------

/**
 * Mount the map.
 *
 * @param {HTMLElement} container
 *        The positioned host. It must NOT be aria-hidden: the attribution link
 *        and the status region are appended to it as siblings of #map.
 * @param {Object} [options]
 * @param {{lat:number, lon:number}} [options.centre]  initial centre
 * @param {number}  [options.zoom]        initial integer zoom, clamped 11..17
 * @param {boolean} [options.tiles]       false disables the raster underlay
 * @param {Object}  [options.layers]      {cell, sector, stops} initial on/off
 * @param {boolean} [options.keyboard]    one tab stop, arrow-key pan, +/- zoom
 *        and Home to recentre. Default false; the BeHERE shell passes true.
 *        See ACCESSIBILITY at the head of this file.
 * @param {Object}  [options.strings]     {status, label}. In keyboard mode
 *        `label` is the group's accessible name, so it should name the keys.
 * @returns {Object} the map handle documented at the foot of this file
 */
export function createMap(container, options = {}) {
  if (!container) throw new Error("createMap needs a container element");

  // --- state ---------------------------------------------------------------

  const state = {
    lat: options.centre && typeof options.centre.lat === "number" ? options.centre.lat : 50.8467,
    lon: options.centre && typeof options.centre.lon === "number" ? options.centre.lon : 4.3499,
    zoom: clamp(Math.round(options.zoom || DEFAULT_ZOOM), MIN_ZOOM, MAX_ZOOM),
    w: 0,
    h: 0,
    dock: 0,            // current optical offset, tweened
    dockTarget: 0,
  };

  const layers = {
    cell: options.layers && "cell" in options.layers ? !!options.layers.cell : true,
    sector: options.layers && "sector" in options.layers ? !!options.layers.sector : true,
    stops: options.layers && "stops" in options.layers ? !!options.layers.stops : true,
  };

  let strings = Object.assign({}, DEFAULT_STRINGS, options.strings || {});

  /** The device fix. Null until one arrives; the map still draws without it. */
  let fix = null;
  /** True until the first fix has centred the map once. */
  let awaitingFirstFix = true;

  /** Layer inputs. */
  let cellId = null;
  let cellRingCache = { id: null, ring: null };
  let sectorFC = null;
  let sectorIndex = [];          // [{feature, bounds, code}]
  let currentSector = null;      // sector code from here.js
  let markerInput = [];          // [{key, lat, lon, label, operator, kind}]
  let markerRanked = [];         // the same, sorted by distance, with .dist
  let selectedKey = null;

  /** Tiles. */
  let tilesAllowed = options.tiles !== false;
  let tileState = "live";        // "live" | "failed" | "off"
  let tileErrors = 0;
  let tileHoldUntil = 0;         // no requests before this epoch ms
  let tileTimer = 0;
  const tileNodes = new Map();   // "z/x/y" -> HTMLImageElement

  /** Frame scheduling. Exactly one rAF may be outstanding. */
  let frame = 0;
  let tween = 0;
  let statusTimer = 0;
  let destroyed = false;

  const listeners = new Map();   // type -> Set<fn>
  const markerNodes = new Map(); // key -> HTMLElement
  const sectorNodes = new Map(); // code -> SVGPathElement

  // --- dom -----------------------------------------------------------------

  let root = container.querySelector("#map");
  if (!root) {
    root = el("div", "map");
    root.id = "map";
    container.insertBefore(root, container.firstChild);
  }
  root.classList.add("map");

  const keyboardOn = options.keyboard === true;
  if (keyboardOn) {
    // The host asked for a keyboard-operable map. A focusable node inside an
    // aria-hidden subtree is an error, so the region is exposed instead: it
    // becomes a labelled group with one tab stop. Tab is never intercepted, so
    // it cannot become a trap.
    root.removeAttribute("aria-hidden");
    root.setAttribute("role", "group");
    root.setAttribute("tabindex", "0");
    root.setAttribute("aria-label", strings.label);
  } else {
    root.setAttribute("aria-hidden", "true");
    root.removeAttribute("tabindex");
  }

  const tilesEl = el("div", "map-tiles");
  tilesEl.setAttribute("data-state", "live");
  const veilEl = el("div", "map-veil");

  const vectorsEl = svg("svg", "map-vectors");
  vectorsEl.setAttribute("width", "100%");
  vectorsEl.setAttribute("height", "100%");
  vectorsEl.setAttribute("aria-hidden", "true");
  vectorsEl.setAttribute("focusable", "false");

  const cellPath = svg("path", "map-cell");        // layer 3, first child
  const sectorGroup = svg("g", "map-sectors");     // layer 4
  const accuracyEl = svg("circle", "map-accuracy");// layer 5, last child
  accuracyEl.setAttribute("r", "0");
  vectorsEl.appendChild(cellPath);
  vectorsEl.appendChild(sectorGroup);
  vectorsEl.appendChild(accuracyEl);

  const markersEl = el("div", "map-markers");

  const positionEl = el("div", "map-position");
  positionEl.hidden = true;
  positionEl.appendChild(el("span", "map-position__pulse"));
  positionEl.appendChild(el("span", "map-position__core"));

  // Every drawn layer is decorative to assistive technology, and says so on
  // its own element rather than relying on #map's aria-hidden. That matters in
  // keyboard mode, where #map is EXPOSED so it can hold a tab stop: without
  // these, a screen reader entering the group would read 49 Brussels marker
  // labels as loose text, duplicating the Go band's list. None of these nodes
  // is focusable, so hiding them is legal and creates no unreachable control.
  // Everything the map draws is text in a band; the group itself is the only
  // thing that needs a name.
  tilesEl.setAttribute("aria-hidden", "true");
  veilEl.setAttribute("aria-hidden", "true");
  markersEl.setAttribute("aria-hidden", "true");
  positionEl.setAttribute("aria-hidden", "true");

  root.appendChild(tilesEl);
  root.appendChild(veilEl);
  root.appendChild(vectorsEl);
  root.appendChild(markersEl);
  root.appendChild(positionEl);

  // Attribution: a SIBLING of #map, never a child, so the link is focusable
  // and announced even though the map itself is not.
  let attribEl = container.querySelector(".map-attrib");
  if (!attribEl) {
    attribEl = el("p", "map-attrib");
    const a = el("a");
    a.setAttribute("href", OSM_COPYRIGHT_URL);
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
    a.textContent = OSM_ATTRIBUTION;
    attribEl.appendChild(a);
    container.appendChild(attribEl);
  }

  let statusEl = container.querySelector(".map-status");
  if (!statusEl) {
    statusEl = el("p", "map-status sr-only");
    statusEl.setAttribute("role", "status");
    statusEl.setAttribute("aria-live", "polite");
    container.appendChild(statusEl);
  }

  // --- geometry ------------------------------------------------------------

  /** Screen x of the optical centre. */
  function originScreenX() { return state.w / 2; }
  /**
   * Screen y of the optical centre.
   * The dock covers the bottom of the screen, so the position dot is centred
   * in the ground that is actually visible, not in the element. UI_SPEC 3.3:
   * without this, opening a band hides the dot on a phone, which is the one
   * thing a "where am I" app must never do.
   */
  function originScreenY() { return (state.h - state.dock) / 2; }

  /**
   * World pixel that sits at screen (0, 0).
   *
   * Cached, because a Ghent frame projects several thousand sector vertices and
   * recomputing the origin inside that loop would mean two extra transcendental
   * calls per vertex for a value that cannot change during a frame.
   */
  const origin = { x: 0, y: 0 };
  function updateOrigin() {
    origin.x = lonToX(state.lon, state.zoom) - originScreenX();
    origin.y = latToY(state.lat, state.zoom) - originScreenY();
    return origin;
  }

  function toScreen(lat, lon) {
    return { x: lonToX(lon, state.zoom) - origin.x, y: latToY(lat, state.zoom) - origin.y };
  }

  function toLatLon(sx, sy) {
    return { lat: yToLat(origin.y + sy, state.zoom), lon: xToLon(origin.x + sx, state.zoom) };
  }

  /** Move the centre by a world-pixel delta; content shifts the other way. */
  function panWorld(dx, dy) {
    const z = state.zoom;
    const ws = worldSize(z);
    let wx = lonToX(state.lon, z) + dx;
    const wy = clamp(latToY(state.lat, z) + dy, 0, ws);
    wx = ((wx % ws) + ws) % ws;
    state.lon = xToLon(wx, z);
    state.lat = yToLat(wy, z);
  }

  /** The viewport in WGS84, expanded by `pad` pixels: [w, s, e, n]. */
  function viewBounds(pad) {
    updateOrigin();
    const p = pad || 0;
    const a = toLatLon(-p, -p);
    const b = toLatLon(state.w + p, state.h + p);
    return [Math.min(a.lon, b.lon), Math.min(a.lat, b.lat),
            Math.max(a.lon, b.lon), Math.max(a.lat, b.lat)];
  }

  function currentMpp() { return mppAt(state.lat, state.zoom); }

  function isOffCentre() {
    if (!fix) return false;
    return Math.abs(state.lat - fix.lat) > OFF_CENTRE_LAT ||
           Math.abs(state.lon - fix.lon) > OFF_CENTRE_LON;
  }

  // --- events --------------------------------------------------------------

  function on(type, fn) {
    if (typeof fn !== "function") return () => {};
    let set = listeners.get(type);
    if (!set) { set = new Set(); listeners.set(type, set); }
    set.add(fn);
    return () => set.delete(fn);
  }

  function off(type, fn) {
    const set = listeners.get(type);
    if (set) set.delete(fn);
  }

  function emit(type, detail) {
    const set = listeners.get(type);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try { fn(detail); } catch (e) {
        // A listener must never be able to stop the map from drawing.
        if (typeof console !== "undefined") console.error("map listener failed", e);
      }
    }
  }

  function emitMove() {
    emit("move", {
      lat: state.lat, lon: state.lon, zoom: state.zoom,
      metresPerPixel: currentMpp(), offCentre: isOffCentre(),
      w: state.w, h: state.h,
    });
  }

  // --- frame scheduling ----------------------------------------------------

  /**
   * Ask for one frame. There is no render loop: nothing is scheduled unless
   * something changed, and a stationary map costs zero frames per second.
   */
  function schedule() {
    if (destroyed || frame) return;
    frame = requestAnimationFrame(() => { frame = 0; draw(); });
  }

  function draw() {
    if (destroyed) return;
    measure();
    updateOrigin();
    renderTiles();
    renderCell();
    renderSectors();
    renderPosition();
    renderMarkers();
    renderAttribution();
    queueStatus();
  }

  function measure() {
    const r = root.getBoundingClientRect();
    state.w = Math.round(r.width);
    state.h = Math.round(r.height);
  }

  // --- layer 1: tiles ------------------------------------------------------

  function setTileState(next) {
    if (tileState === next) return;
    tileState = next;
    tilesEl.setAttribute("data-state", next);
    emit("tiles", { state: next, errors: tileErrors });
  }

  function clearTiles() {
    for (const img of tileNodes.values()) {
      img.removeAttribute("src");     // stop any in-flight load, no broken icon
      if (img.parentNode) img.parentNode.removeChild(img);
    }
    tileNodes.clear();
  }

  function wantTiles() {
    if (!tilesAllowed) return false;
    if (dataSaverOn()) return false;
    return true;
  }

  function renderTiles() {
    if (!wantTiles()) {
      clearTiles();
      setTileState("off");
      return;
    }

    const now = Date.now();
    const holding = now < tileHoldUntil;

    if (!holding && tileState !== "live") {
      // Either the zoom settled or the cooldown expired. One honest attempt.
      tileErrors = 0;
      setTileState("live");
    }

    const o = updateOrigin();
    const wanted = tilesForViewport({
      originX: o.x, originY: o.y, w: state.w, h: state.h, zoom: state.zoom,
    });

    const keep = new Set();
    for (const t of wanted) {
      keep.add(t.key);
      let img = tileNodes.get(t.key);
      if (!img) {
        // While the layer is holding, tiles already on screen keep panning with
        // the map so the imagery does not lag the vectors, but NOTHING NEW IS
        // REQUESTED. That is the whole difference between degrading and
        // scraping.
        if (holding) continue;
        img = document.createElement("img");
        img.className = "map-tile";
        img.width = TILE_SIZE;
        img.height = TILE_SIZE;
        img.alt = "";
        img.decoding = "async";
        img.draggable = false;
        // A tile must never compete with a grid shard for bandwidth.
        try { img.fetchPriority = "low"; } catch (e) { /* not supported */ }
        img.setAttribute("fetchpriority", "low");
        img.addEventListener("error", onTileError, { once: true });
        img.addEventListener("load", onTileLoad, { once: true });
        img.src = TILE_HOST + t.z + "/" + t.x + "/" + t.y + ".png";
        tileNodes.set(t.key, img);
        tilesEl.appendChild(img);
      }
      img.style.transform = "translate(" + Math.round(t.left) + "px," + Math.round(t.top) + "px)";
    }

    for (const [key, img] of Array.from(tileNodes.entries())) {
      if (keep.has(key)) continue;
      img.removeAttribute("src");
      if (img.parentNode) img.parentNode.removeChild(img);
      tileNodes.delete(key);
    }

    // The 120 ms zoom settle needs a wake-up, because the user has finished
    // acting and nothing else will schedule a frame. The 60 s failure cooldown
    // deliberately does NOT get one: retrying on a timer forever would be a
    // background loop that requests 8 tiles a minute from a phone in airplane
    // mode. It clears the next time the user actually moves the map, which is
    // the only moment tiles are wanted again.
    const remaining = tileHoldUntil - now;
    if (holding && remaining <= TILE_SETTLE_MS && !tileTimer) {
      tileTimer = setTimeout(() => { tileTimer = 0; schedule(); }, Math.max(16, remaining));
    }
  }

  function onTileLoad(e) {
    const img = e.currentTarget;
    img.setAttribute("data-loaded", "1");
    renderAttribution();
  }

  /**
   * A failed tile leaves the ground colour, never a broken-image glyph: the
   * src is dropped and the element removed. After TILE_ERROR_LIMIT failures in
   * one viewport the whole layer stands down for TILE_COOLDOWN_MS and the map
   * degrades to the baked vectors, which is the state the app is designed for.
   */
  function onTileError(e) {
    const img = e.currentTarget;
    img.removeAttribute("src");
    if (img.parentNode) img.parentNode.removeChild(img);
    for (const [key, node] of tileNodes.entries()) {
      if (node === img) { tileNodes.delete(key); break; }
    }
    tileErrors += 1;
    if (tileErrors >= TILE_ERROR_LIMIT) {
      // Whatever DID load stays on screen and keeps panning: it is real
      // imagery, and while it is visible the attribution stays visible with
      // it, which is the licence term. Only new requests stop.
      tileHoldUntil = Date.now() + TILE_COOLDOWN_MS;
      setTileState("failed");
      renderAttribution();
      schedule();
    }
  }

  /** Any tile actually painted right now? */
  function tilesPainted() {
    for (const img of tileNodes.values()) {
      if (img.complete && img.naturalWidth > 0) return true;
    }
    return false;
  }

  /**
   * Attribution is visible on every frame where a tile has been drawn.
   * It is hidden only when the layer is off or failed AND nothing is painted,
   * because attributing a basemap that is not on screen is noise, and hiding
   * one that is on screen is a licence breach.
   */
  function renderAttribution() {
    const show = tileState === "live" || tilesPainted();
    attribEl.hidden = !show;
  }

  // --- layer 3: the 1 km cell ---------------------------------------------

  function renderCell() {
    if (!layers.cell || !cellId) {
      cellPath.setAttribute("d", "");
      cellPath.setAttribute("visibility", "hidden");
      return;
    }
    if (cellRingCache.id !== cellId) {
      const seedLat = fix ? fix.lat : state.lat;
      const seedLon = fix ? fix.lon : state.lon;
      cellRingCache = { id: cellId, ring: cellRing(cellId, seedLat, seedLon) };
    }
    const ring = cellRingCache.ring;
    if (!ring) {
      cellPath.setAttribute("d", "");
      cellPath.setAttribute("visibility", "hidden");
      return;
    }
    cellPath.setAttribute("visibility", "visible");
    cellPath.setAttribute("d", ringPath(ring, true));
  }

  /** [[lon, lat], ...] -> an SVG path in screen pixels. */
  function ringPath(ring, close) {
    let d = "";
    let px = NaN, py = NaN;
    for (let i = 0; i < ring.length; i++) {
      const p = toScreen(ring[i][1], ring[i][0]);
      const x = Math.round(p.x * 10) / 10;
      const y = Math.round(p.y * 10) / 10;
      // Drop vertices that land on the previous one. At z11 a simplified
      // sector can carry hundreds of points inside three screen pixels, and
      // emitting them costs string bytes for nothing visible.
      if (i > 0 && i < ring.length - 1 &&
          Math.abs(x - px) < 0.5 && Math.abs(y - py) < 0.5) continue;
      d += (d ? "L" : "M") + x + " " + y + " ";
      px = x; py = y;
    }
    if (!d) return "";
    return close ? d + "Z" : d.trimEnd();
  }

  /** A whole MultiPolygon (or Polygon) as one path string. */
  function geometryPath(geometry) {
    const polys =
      geometry.type === "MultiPolygon" ? geometry.coordinates
        : geometry.type === "Polygon" ? [geometry.coordinates]
          : null;
    if (!polys) return "";
    let d = "";
    for (const poly of polys) {
      if (!Array.isArray(poly)) continue;
      for (const ring of poly) {
        if (!Array.isArray(ring) || ring.length < 3) continue;
        d += ringPath(ring, true);
      }
    }
    return d;
  }

  // --- layer 4: sectors ----------------------------------------------------

  /**
   * Bounding boxes are computed ONCE per file, not per frame. A sector file is
   * under 150 KB and Ghent carries 254 features; rebuilding their boxes on
   * every pointermove would be the one thing that makes this map stutter.
   */
  function indexSectors(fc) {
    const out = [];
    if (!fc || !Array.isArray(fc.features)) return out;
    for (let i = 0; i < fc.features.length; i++) {
      const f = fc.features[i];
      if (!f || !f.geometry) continue;
      const bounds = geometryBounds(f.geometry);
      if (!bounds) continue;
      const code = (f.properties && f.properties.s) || "";
      // CONTRACT 6: `s` is unique per file. The index is the fallback key for a
      // malformed feature, so two nameless features cannot collide.
      out.push({ feature: f, bounds, code, key: code || "#" + i });
    }
    return out;
  }

  function renderSectors() {
    if (!layers.sector || !sectorIndex.length) {
      for (const node of sectorNodes.values()) {
        if (node.parentNode) node.parentNode.removeChild(node);
      }
      sectorNodes.clear();
      return;
    }

    // A simplified sector file is under 150 KB and Ghent carries 254 features.
    // Only what the viewport can see is turned into a path string, and the
    // bounding boxes were computed once when the file was handed over.
    const vb = viewBounds(VECTOR_MARGIN_PX);
    const live = new Set();

    for (const entry of sectorIndex) {
      if (!boundsIntersect(entry.bounds, vb)) continue;
      const key = entry.key;
      live.add(key);
      let node = sectorNodes.get(key);
      if (!node) {
        node = svg("path", "map-sector");
        node.setAttribute("data-sector", key);
        sectorNodes.set(key, node);
        sectorGroup.appendChild(node);
      }
      const isCurrent = !!currentSector && entry.code === currentSector;
      if (isCurrent) node.setAttribute("data-current", "true");
      else node.removeAttribute("data-current");
      node.setAttribute("d", geometryPath(entry.feature.geometry));
    }

    for (const [key, node] of Array.from(sectorNodes.entries())) {
      if (live.has(key)) continue;
      if (node.parentNode) node.parentNode.removeChild(node);
      sectorNodes.delete(key);
    }

    // The sector you are standing in draws last, so its 3px stroke is never
    // painted over by a neighbour's 1.25px one.
    const cur = currentSector && sectorNodes.get(currentSector);
    if (cur && cur.parentNode === sectorGroup && sectorGroup.lastChild !== cur) {
      sectorGroup.appendChild(cur);
    }
  }

  // --- layers 5 and 7: accuracy and the dot --------------------------------

  function renderPosition() {
    if (!fix) {
      positionEl.hidden = true;
      accuracyEl.setAttribute("r", "0");
      accuracyEl.setAttribute("visibility", "hidden");
      return;
    }
    const p = toScreen(fix.lat, fix.lon);
    positionEl.hidden = false;
    // left/top, not transform: the stylesheet owns `transform` (the -50% -50%
    // recentre, and the selected marker's scale), and an inline transform would
    // silently win over it.
    positionEl.style.left = p.x.toFixed(1) + "px";
    positionEl.style.top = p.y.toFixed(1) + "px";

    const acc = typeof fix.accuracy === "number" ? fix.accuracy : 0;
    if (acc > 0 && state.w > 0 && state.h > 0) {
      // The prototype fakes this as a constant 18 m. The real fix accuracy is
      // used here, and the upper clamp stops a 5 km fix painting the screen.
      const r = clamp(acc / currentMpp(), ACCURACY_MIN_PX,
                      ACCURACY_MAX_SHARE * Math.min(state.w, state.h));
      accuracyEl.setAttribute("cx", p.x.toFixed(1));
      accuracyEl.setAttribute("cy", p.y.toFixed(1));
      accuracyEl.setAttribute("r", r.toFixed(1));
      accuracyEl.setAttribute("visibility", "visible");
    } else {
      accuracyEl.setAttribute("r", "0");
      accuracyEl.setAttribute("visibility", "hidden");
    }
  }

  // --- layer 6: markers ----------------------------------------------------

  function rankMarkers() {
    const oLat = fix ? fix.lat : state.lat;
    const oLon = fix ? fix.lon : state.lon;
    markerRanked = markerInput
      .map((m) => Object.assign({}, m, {
        dist: haversineMetres(oLat, oLon, m.lat, m.lon),
      }))
      .sort((a, b) => a.dist - b.dist);
  }

  function renderMarkers() {
    if (!layers.stops || !markerRanked.length) {
      for (const node of markerNodes.values()) {
        if (node.parentNode) node.parentNode.removeChild(node);
      }
      return;
    }

    const live = new Set();
    // Labels go to the nearest markers that are ACTUALLY DRAWN, not to the
    // nearest overall. UI_SPEC 1.5 says "selected, or among the 8 nearest",
    // and ranking by distance from the fix is what keeps DOM order equal to
    // the Go list order. But taking the 8 nearest overall means that once the
    // user pans a kilometre away, all eight labels are off screen and every
    // pill in view is bare. Counting the drawn ones keeps the intent (a stable
    // handful of labels, nearest first) and keeps them where the eye is.
    let drawn = 0;
    for (let i = 0; i < markerRanked.length; i++) {
      const m = markerRanked[i];
      const p = toScreen(m.lat, m.lon);
      const visible =
        p.x > -MARKER_MARGIN_PX && p.x < state.w + MARKER_MARGIN_PX &&
        p.y > -MARKER_MARGIN_PX && p.y < state.h + MARKER_MARGIN_PX;

      let node = markerNodes.get(m.key);
      if (!node) {
        node = el("span", "map-marker");
        node.setAttribute("role", "presentation");
        node.dataset.key = m.key;
        const dot = el("span", "map-marker__dot");
        const label = el("span", "map-marker__label");
        node.appendChild(dot);
        node.appendChild(label);
        markerNodes.set(m.key, node);
      }
      if (!visible) {
        if (node.parentNode) node.parentNode.removeChild(node);
        continue;
      }
      live.add(m.key);

      const selected = m.key === selectedKey;
      const labelled = selected || drawn < LABELLED_MARKERS;
      drawn += 1;
      if (m.operator) node.dataset.op = m.operator;
      if (m.kind) node.dataset.kind = m.kind;
      if (selected) node.setAttribute("data-selected", "true");
      else node.removeAttribute("data-selected");
      node.setAttribute("data-labelled", labelled ? "true" : "false");

      const label = node.lastChild;
      const text = m.label || "";
      if (label.textContent !== text) label.textContent = text;

      // left/top, never transform: .map-marker[data-selected] carries
      // `transform: translate(-50%,-50%) scale(1.06)` and an inline transform
      // would beat the stylesheet and kill the selected state.
      node.style.left = p.x.toFixed(1) + "px";
      node.style.top = p.y.toFixed(1) + "px";
      if (!node.parentNode) markersEl.appendChild(node);
    }

    for (const [key, node] of markerNodes.entries()) {
      if (!live.has(key) && node.parentNode) node.parentNode.removeChild(node);
    }
  }

  // --- status announcement -------------------------------------------------

  function queueStatus() {
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      statusTimer = 0;
      if (destroyed) return;
      const m = Math.round(currentMpp() * 100);
      const text = String(strings.status || DEFAULT_STRINGS.status)
        .replace("{m}", String(m));
      if (statusEl.textContent !== text) statusEl.textContent = text;
    }, STATUS_QUIET_MS);
  }

  // --- interaction ---------------------------------------------------------

  const pointers = new Map();     // pointerId -> {x, y}
  let dragFrom = null;            // {x, y, wx, wy}
  let pinchFrom = null;           // {dist, mx, my}
  let moved = 0;
  let wheelAcc = 0;
  /**
   * The marker the gesture STARTED on.
   *
   * Selection is driven from the pointer sequence rather than from `click`,
   * because setPointerCapture() on the map root retargets the compatibility
   * mouse events at the capture element in some engines, and a marker tap would
   * silently stop working. pointerdown always fires on the real target, so the
   * marker is recorded there and acted on at pointerup if the finger did not
   * travel. The delegated click listener stays as a second path for engines
   * that behave; select() is idempotent, so a double fire changes nothing.
   */
  let downMarker = null;

  function onPointerDown(e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    downMarker = (e.target && e.target.closest) ? e.target.closest(".map-marker") : null;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { root.setPointerCapture(e.pointerId); } catch (err) { /* fine */ }
    moved = 0;

    if (pointers.size === 1) {
      dragFrom = {
        x: e.clientX, y: e.clientY,
        wx: lonToX(state.lon, state.zoom), wy: latToY(state.lat, state.zoom),
      };
      pinchFrom = null;
    } else if (pointers.size === 2) {
      dragFrom = null;
      pinchFrom = pinchMetrics();
    }
    root.setAttribute("data-dragging", "true");
  }

  function pinchMetrics() {
    const pts = Array.from(pointers.values());
    if (pts.length < 2) return null;
    const dx = pts[1].x - pts[0].x;
    const dy = pts[1].y - pts[0].y;
    return {
      dist: Math.max(1, Math.hypot(dx, dy)),
      mx: (pts[0].x + pts[1].x) / 2,
      my: (pts[0].y + pts[1].y) / 2,
    };
  }

  function onPointerMove(e) {
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved += Math.abs(e.clientX - prev.x) + Math.abs(e.clientY - prev.y);

    if (pointers.size === 1 && dragFrom) {
      const dx = e.clientX - dragFrom.x;
      const dy = e.clientY - dragFrom.y;
      const z = state.zoom;
      const ws = worldSize(z);
      let wx = dragFrom.wx - dx;
      const wy = clamp(dragFrom.wy - dy, 0, ws);
      wx = ((wx % ws) + ws) % ws;
      state.lon = xToLon(wx, z);
      state.lat = yToLat(wy, z);
      schedule();
      emitMove();
      return;
    }

    if (pointers.size >= 2) {
      const now = pinchMetrics();
      if (!now || !pinchFrom) return;
      // Pan by the midpoint, then step the zoom when the spread crosses a
      // threshold. Zoom stays integer: fractional zoom would mean scaling the
      // tile raster, which looks worse and is not what the tile grid offers.
      const rect = root.getBoundingClientRect();
      panWorld(pinchFrom.mx - now.mx, pinchFrom.my - now.my);
      const ratio = now.dist / pinchFrom.dist;
      if (ratio > PINCH_STEP) {
        zoomAround(1, now.mx - rect.left, now.my - rect.top);
        pinchFrom = pinchMetrics();
      } else if (ratio < 1 / PINCH_STEP) {
        zoomAround(-1, now.mx - rect.left, now.my - rect.top);
        pinchFrom = pinchMetrics();
      } else {
        pinchFrom = { dist: pinchFrom.dist, mx: now.mx, my: now.my };
      }
      schedule();
      emitMove();
    }
  }

  function onPointerUp(e) {
    pointers.delete(e.pointerId);
    try { root.releasePointerCapture(e.pointerId); } catch (err) { /* fine */ }
    if (downMarker && moved <= TAP_SLOP_PX && e.type !== "pointercancel") {
      const key = downMarker.dataset ? downMarker.dataset.key : null;
      if (key) select(key, "map");
    }
    downMarker = null;
    if (pointers.size === 0) {
      dragFrom = null;
      pinchFrom = null;
      root.removeAttribute("data-dragging");
    } else if (pointers.size === 1) {
      const only = Array.from(pointers.values())[0];
      dragFrom = {
        x: only.x, y: only.y,
        wx: lonToX(state.lon, state.zoom), wy: latToY(state.lat, state.zoom),
      };
      pinchFrom = null;
    }
  }

  function onMarkerClick(e) {
    if (moved > TAP_SLOP_PX) return;         // that was a drag, not a tap
    const node = e.target && e.target.closest ? e.target.closest(".map-marker") : null;
    if (!node) return;
    select(node.dataset.key, "map");
  }

  function onWheel(e) {
    e.preventDefault();
    // deltaMode 1 is lines, 2 is pages. Normalise to something pixel-ish so a
    // mouse notch and a trackpad flick both need one gesture per zoom step.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    wheelAcc += e.deltaY * unit;
    if (Math.abs(wheelAcc) < WHEEL_STEP) return;
    const steps = wheelAcc > 0 ? -1 : 1;
    wheelAcc = 0;
    const rect = root.getBoundingClientRect();
    zoomAround(steps, e.clientX - rect.left, e.clientY - rect.top);
  }

  function onKeyDown(e) {
    if (!keyboardOn) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    let handled = true;
    switch (e.key) {
      case "ArrowLeft":  panPixels(-KEY_PAN_PX, 0); break;
      case "ArrowRight": panPixels(KEY_PAN_PX, 0); break;
      case "ArrowUp":    panPixels(0, -KEY_PAN_PX); break;
      case "ArrowDown":  panPixels(0, KEY_PAN_PX); break;
      case "+": case "=": zoomBy(1); break;
      case "-": case "_": zoomBy(-1); break;
      case "Home": recentre(); break;
      default: handled = false;
    }
    // Tab, Escape and everything else are never intercepted, so focus can
    // always leave: the map cannot become a keyboard trap.
    if (handled) e.preventDefault();
  }

  /** Pan by screen pixels. Positive dx moves the view east. */
  function panPixels(dx, dy) {
    panWorld(dx, dy);
    schedule();
    emitMove();
  }

  /** Change zoom by whole steps, keeping the ground under (sx, sy) fixed. */
  function zoomAround(steps, sx, sy) {
    const next = clamp(state.zoom + steps, MIN_ZOOM, MAX_ZOOM);
    if (next === state.zoom) return;
    updateOrigin();
    const anchor = toLatLon(sx, sy);
    state.zoom = next;
    updateOrigin();
    const after = toScreen(anchor.lat, anchor.lon);
    panWorld(after.x - sx, after.y - sy);
    onZoomChanged();
  }

  function zoomBy(steps) {
    zoomAround(steps, originScreenX(), originScreenY());
  }

  function setZoom(z) {
    zoomAround(clamp(Math.round(z), MIN_ZOOM, MAX_ZOOM) - state.zoom,
               originScreenX(), originScreenY());
  }

  /**
   * A zoom change drops the tile layer and holds it for TILE_SETTLE_MS. This
   * is what makes a fast "- - -" cost one round of tiles instead of four, and
   * it is the debounce UI_SPEC 1.2 requires.
   */
  function onZoomChanged() {
    clearTiles();
    tileHoldUntil = Math.max(tileHoldUntil, Date.now() + TILE_SETTLE_MS);
    schedule();
    emit("zoom", { zoom: state.zoom, min: MIN_ZOOM, max: MAX_ZOOM });
    emitMove();
  }

  // --- selection -----------------------------------------------------------

  function select(key, source) {
    const next = key || null;
    if (next === selectedKey) {
      if (next) ensureVisible(next);
      return;
    }
    selectedKey = next;
    if (next) ensureVisible(next);
    schedule();
    const m = markerRanked.find((x) => x.key === next) || null;
    emit("select", { key: next, marker: m, source: source || "api" });
  }

  /**
   * Pan a selected marker into the ground that is actually visible, which is
   * the rect above the dock. It never zooms: changing zoom under someone's
   * finger is disorienting and it costs tiles (UI_SPEC 3.3 rule 3).
   */
  function ensureVisible(key) {
    const m = markerInput.find((x) => x.key === key);
    if (!m || !state.w || !state.h) return;
    updateOrigin();
    const p = toScreen(m.lat, m.lon);
    const pad = 56;
    const top = pad;
    const bottom = Math.max(pad, state.h - state.dock - pad);
    const left = pad;
    const right = Math.max(pad, state.w - pad);
    let dx = 0, dy = 0;
    if (p.x < left) dx = p.x - left;
    else if (p.x > right) dx = p.x - right;
    if (p.y < top) dy = p.y - top;
    else if (p.y > bottom) dy = p.y - bottom;
    if (dx || dy) {
      panWorld(dx, dy);
      emitMove();
    }
  }

  // --- the optical centre tween -------------------------------------------

  function setDockHeight(px, animate) {
    const target = Math.max(0, Number(px) || 0);
    container.style.setProperty("--dock-height", target + "px");
    if (state.dockTarget === target) return;
    state.dockTarget = target;

    if (tween) { cancelAnimationFrame(tween); tween = 0; }
    if (animate === false || prefersReducedMotion()) {
      state.dock = target;
      schedule();
      return;
    }
    const from = state.dock;
    const started = (typeof performance !== "undefined" ? performance.now() : Date.now());
    const step = (t) => {
      const now = (typeof t === "number" ? t
        : (typeof performance !== "undefined" ? performance.now() : Date.now()));
      const k = clamp((now - started) / DOCK_TWEEN_MS, 0, 1);
      // cubic-bezier(.2,.8,.25,1) approximated by an ease-out cubic; the eye
      // cannot tell them apart over 240 ms and this needs no solver.
      const e = 1 - Math.pow(1 - k, 3);
      state.dock = from + (target - from) * e;
      draw();
      if (k < 1 && !destroyed) tween = requestAnimationFrame(step);
      else tween = 0;                      // the loop ends. It is not a ticker.
    };
    tween = requestAnimationFrame(step);
  }

  // --- resize --------------------------------------------------------------

  let ro = null;
  function onResize() { schedule(); emitMove(); }
  if (typeof ResizeObserver === "function") {
    ro = new ResizeObserver(onResize);
    ro.observe(root);
  } else if (typeof window !== "undefined") {
    window.addEventListener("resize", onResize);
  }

  // --- wire up -------------------------------------------------------------

  root.addEventListener("pointerdown", onPointerDown);
  root.addEventListener("pointermove", onPointerMove);
  root.addEventListener("pointerup", onPointerUp);
  root.addEventListener("pointercancel", onPointerUp);
  root.addEventListener("wheel", onWheel, { passive: false });
  root.addEventListener("keydown", onKeyDown);
  markersEl.addEventListener("click", onMarkerClick);
  root.addEventListener("dragstart", (e) => e.preventDefault());

  // A tile layer that is off from the start says so from the start.
  if (!wantTiles()) setTileState("off");
  schedule();

  // --- the handle ----------------------------------------------------------

  const map = {
    /** The #map element, for a host that needs to measure or class it. */
    element: root,

    // ---- position and view ----

    /**
     * Hand the map the device fix. The first fix centres the map; later ones
     * only move the dot, so a user who has panned away is not yanked back.
     * @param {{lat:number, lon:number, accuracy?:number, at?:number}|null} f
     */
    setPosition(f) {
      if (!f || typeof f.lat !== "number" || typeof f.lon !== "number") {
        fix = null;
        schedule();
        return;
      }
      fix = { lat: f.lat, lon: f.lon, accuracy: f.accuracy || 0, at: f.at || Date.now() };
      if (awaitingFirstFix) {
        awaitingFirstFix = false;
        state.lat = fix.lat;
        state.lon = fix.lon;
        emitMove();
      }
      rankMarkers();
      schedule();
    },

    /** The last fix handed in, or null. */
    getPosition() { return fix ? Object.assign({}, fix) : null; },

    /** Centre on the fix. No-op with no fix. */
    recentre,

    /** True when the map has been panned away from the fix (UI_SPEC 3.4). */
    isOffCentre,

    /** Move the centre without touching the fix. */
    setCentre(lat, lon) {
      if (typeof lat !== "number" || typeof lon !== "number") return;
      state.lat = lat;
      state.lon = lon;
      awaitingFirstFix = false;
      schedule();
      emitMove();
    },
    getCentre() { return { lat: state.lat, lon: state.lon }; },

    setZoom,
    zoomBy,
    getZoom() { return state.zoom; },
    get minZoom() { return MIN_ZOOM; },
    get maxZoom() { return MAX_ZOOM; },

    /** Pan by CSS pixels. Positive dx moves the view east, dy south. */
    panBy: panPixels,

    /** Ground metres per CSS pixel at the current centre and zoom. */
    metresPerPixel: currentMpp,

    /** Project and unproject, for a host that needs to place its own chrome. */
    toScreen(lat, lon) { updateOrigin(); return toScreen(lat, lon); },
    toLatLon(x, y) { updateOrigin(); return toLatLon(x, y); },

    // ---- layers ----

    /**
     * The GRD_NEWID square to outline. Pass null to clear it.
     * The corners are inverted from EPSG:3035 through grid.js's own forward
     * projection, so the square drawn is the square the data is keyed on.
     */
    setCell(id) {
      const next = id || null;
      if (next === cellId) return;
      cellId = next;
      cellRingCache = { id: null, ring: null };
      schedule();
    },

    /**
     * The municipality's sector polygons and which one the position is in.
     * @param {Object|null} featureCollection  <nis>/sector.geojson, verbatim
     * @param {string|null} currentCode        properties.s of the current one
     */
    setSectors(featureCollection, currentCode) {
      if (featureCollection !== sectorFC) {
        sectorFC = featureCollection || null;
        sectorIndex = indexSectors(sectorFC);
        for (const node of sectorNodes.values()) {
          if (node.parentNode) node.parentNode.removeChild(node);
        }
        sectorNodes.clear();
      }
      currentSector = currentCode || null;
      schedule();
    },

    /**
     * The markers to draw. Shape: {key, lat, lon, label, operator?, kind?}.
     * `stopsToMarkers()` turns geo.js's decoded stops into this.
     */
    setMarkers(items) {
      markerInput = (items || []).filter(
        (m) => m && typeof m.lat === "number" && typeof m.lon === "number" && m.key
      );
      const keys = new Set(markerInput.map((m) => m.key));
      for (const [key, node] of Array.from(markerNodes.entries())) {
        if (keys.has(key)) continue;
        if (node.parentNode) node.parentNode.removeChild(node);
        markerNodes.delete(key);
      }
      if (selectedKey && !keys.has(selectedKey)) selectedKey = null;
      rankMarkers();
      schedule();
    },

    /** Alias, for a host that thinks in stops. */
    setStops(items) { return map.setMarkers(items); },

    /** Toggle one vector layer. Names are in LAYERS. */
    setLayer(name, on) {
      if (!LAYERS.includes(name)) return;
      const next = !!on;
      if (layers[name] === next) return;
      layers[name] = next;
      schedule();
      emit("layers", Object.assign({}, layers));
    },
    getLayers() { return Object.assign({}, layers); },

    // ---- selection ----

    /** Select a marker by key, or null to clear. Pans it into view. */
    select(key) { select(key, "api"); },
    getSelected() { return selectedKey; },

    // ---- tiles ----

    /**
     * Turn the raster underlay on or off. Off is a real state, not a failure:
     * the vector map is complete without it.
     */
    setTilesEnabled(on) {
      tilesAllowed = !!on;
      if (!tilesAllowed) { clearTiles(); setTileState("off"); }
      else { tileErrors = 0; tileHoldUntil = 0; }
      schedule();
    },

    /** "live" | "failed" | "off". The host paints the tile note from this. */
    getTileState() { return tileState; },

    /** The attribution string and URL, for a host that wants them in a menu. */
    get attribution() { return { text: OSM_ATTRIBUTION, url: OSM_COPYRIGHT_URL }; },

    // ---- chrome ----

    /**
     * How far the dock covers the bottom of the map. Drives the optical
     * centre and the attribution's own offset. Pass `false` as the second
     * argument to snap instead of tween.
     */
    setDockHeight,

    /** Resolved UI strings. Keys: status, label. */
    setStrings(next) {
      strings = Object.assign({}, strings, next || {});
      if (keyboardOn) root.setAttribute("aria-label", strings.label);
      queueStatus();
    },

    /** Re-measure after a layout change the ResizeObserver cannot see. */
    invalidateSize() { schedule(); emitMove(); },

    // ---- events ----

    on,
    off,

    // ---- teardown ----

    destroy() {
      destroyed = true;
      if (frame) cancelAnimationFrame(frame);
      if (tween) cancelAnimationFrame(tween);
      if (tileTimer) clearTimeout(tileTimer);
      if (statusTimer) clearTimeout(statusTimer);
      if (ro) ro.disconnect();
      else if (typeof window !== "undefined") window.removeEventListener("resize", onResize);
      root.removeEventListener("pointerdown", onPointerDown);
      root.removeEventListener("pointermove", onPointerMove);
      root.removeEventListener("pointerup", onPointerUp);
      root.removeEventListener("pointercancel", onPointerUp);
      root.removeEventListener("wheel", onWheel);
      root.removeEventListener("keydown", onKeyDown);
      markersEl.removeEventListener("click", onMarkerClick);
      clearTiles();
      listeners.clear();
    },
  };

  function recentre() {
    if (!fix) return;
    state.lat = fix.lat;
    state.lon = fix.lon;
    schedule();
    emitMove();
  }

  return map;
}

/* ===========================================================================
 * THE MOUNT API, in one place
 * ===========================================================================
 *
 *   import { createMap, stopsToMarkers, LAYERS } from "./map.js";
 *   const map = createMap(document.querySelector(".app"), { keyboard: true });
 *
 * The container must be positioned and must NOT be aria-hidden: p.map-attrib
 * and p.map-status are created as siblings of #map so both stay reachable,
 * and in keyboard mode #map itself is exposed and holds one tab stop.
 *
 * Driving it from main.js:
 *
 *   onFix(fix)             -> map.setPosition(fix)
 *   app.cell               -> map.setCell(app.cell)
 *   sector.geojson + here  -> map.setSectors(fc, currentSectorCode)
 *   stopsOf(shards)        -> map.setMarkers(stopsToMarkers(stops))
 *   dock resize            -> map.setDockHeight(px)
 *   #zoom-in / #zoom-out   -> map.zoomBy(+1) / map.zoomBy(-1)
 *   #locate                -> map.recentre()
 *   button.chip            -> map.setLayer("cell" | "sector" | "stops", on)
 *   li.go-stop selected    -> map.select(key)
 *
 * Listening to it:
 *
 *   map.on("move",   (e) => …)  {lat, lon, zoom, metresPerPixel, offCentre, w, h}
 *   map.on("zoom",   (e) => …)  {zoom, min, max}
 *   map.on("select", (e) => …)  {key, marker, source: "map" | "api"}
 *   map.on("tiles",  (e) => …)  {state: "live" | "failed" | "off", errors}
 *   map.on("layers", (e) => …)  {cell, sector, stops}
 *
 * Every `on()` returns its own unsubscribe function.
 */
