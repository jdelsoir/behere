/**
 * BeHERE projection layer.
 *
 * Three coordinate systems meet in this app and they must not be confused:
 *
 *   EPSG:4326  WGS84 degrees. Everything baked under web/data/ is in this.
 *   EPSG:3857  Web Mercator. What OSM raster tiles are cut in, and the only
 *              reason this file exists. Display only. Never stored.
 *   EPSG:3035  ETRS89-LAEA Europe. The GRD_NEWID 1 km grid lives here, and
 *              web/app/grid.js is the verified twin of scripts/grid.py for it.
 *
 * This module owns the closed-form WGS84 <-> Web Mercator pair and a Newton
 * inverse of grid.js's laeaForward. It owns NO dom, NO fetch and NO state, so
 * it runs unchanged in node, which is how its reference points are checked.
 *
 * grid.js IS NOT MODIFIED. Its forward projection is imported and used as the
 * residual function of the Newton solver, so the inverse can never drift from
 * the forward path that CI gate 8 pins against scripts/grid.py.
 *
 * Plain ES module. No build step, no bundler, no CDN, no dependency beyond
 * ./grid.js.
 */

import { laeaForward, parseCell } from "./grid.js";

// ---------------------------------------------------------------------------
// 0. Constants
// ---------------------------------------------------------------------------

/** Slippy-map tile edge, CSS pixels. */
export const TILE_SIZE = 256;

/** Integer zoom range, UI_SPEC 1.2. 11 is "the province", 17 is "the doorway". */
export const MIN_ZOOM = 11;
export const MAX_ZOOM = 17;
export const DEFAULT_ZOOM = 15;

/**
 * The Web Mercator latitude cut-off, atan(sinh(pi)) in degrees. Beyond it the
 * projection runs to infinity and the square world stops being square.
 */
export const MAX_LAT = 85.0511287798066;

/**
 * Ground resolution at the equator, metres per pixel at zoom 0 with 256 px
 * tiles. UI_SPEC 1.7 writes this constant to 11 significant figures and the
 * scale readout is derived from it, so it is reproduced exactly.
 */
export const EQUATOR_M_PER_PX = 156543.03392;

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// 1. WGS84 <-> Web Mercator, closed form
// ---------------------------------------------------------------------------

/** Pixels across the whole world at this integer zoom. */
export function worldSize(zoom) {
  return TILE_SIZE * Math.pow(2, zoom);
}

/** Clamp a latitude into the Mercator-representable band. */
export function clampLat(lat) {
  return lat > MAX_LAT ? MAX_LAT : lat < -MAX_LAT ? -MAX_LAT : lat;
}

/**
 * Longitude to world pixel x. Linear: Mercator is a cylinder.
 * @param {number} lon degrees @param {number} zoom @returns {number}
 */
export function lonToX(lon, zoom) {
  return ((lon + 180) / 360) * worldSize(zoom);
}

/**
 * Latitude to world pixel y.
 *
 *   y = (0.5 - ln((1 + sin phi) / (1 - sin phi)) / (4 pi)) * world
 *
 * That is the spherical Mercator the tile grid is cut in. It is deliberately
 * NOT the ellipsoidal form: EPSG:3857 is defined on a sphere of radius a, and
 * using the ellipsoidal one here would slide every tile by up to 20 km.
 * @param {number} lat degrees @param {number} zoom @returns {number}
 */
export function latToY(lat, zoom) {
  const s = Math.sin(clampLat(lat) * DEG);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * worldSize(zoom);
}

/** World pixel x back to longitude. Exact inverse of lonToX. */
export function xToLon(x, zoom) {
  return (x / worldSize(zoom)) * 360 - 180;
}

/** World pixel y back to latitude. Exact inverse of latToY (Gudermannian). */
export function yToLat(y, zoom) {
  const n = Math.PI - (2 * Math.PI * y) / worldSize(zoom);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/** @returns {{x: number, y: number}} world pixel of a WGS84 point. */
export function project(lat, lon, zoom) {
  return { x: lonToX(lon, zoom), y: latToY(lat, zoom) };
}

/** @returns {{lat: number, lon: number}} WGS84 point of a world pixel. */
export function unproject(x, y, zoom) {
  return { lat: yToLat(y, zoom), lon: xToLon(x, zoom) };
}

/**
 * Ground metres per CSS pixel at this latitude and zoom.
 * The scale readout prints `round(this * 100)` as "metres per 100 pixels".
 */
export function metresPerPixel(lat, zoom) {
  return (EQUATOR_M_PER_PX * Math.cos(clampLat(lat) * DEG)) / Math.pow(2, zoom);
}

// ---------------------------------------------------------------------------
// 2. Which tiles a viewport actually needs
// ---------------------------------------------------------------------------

/**
 * The tiles that intersect a viewport rectangle, and not one more.
 *
 * The prototype adds a +1 ring beyond the viewport. That ring is speculative
 * loading, the OSM tile usage policy forbids it, and it is not reproduced here.
 * The count returned is exactly ceil coverage of the rect.
 *
 * `originX`/`originY` are the world pixel that sits at screen (0, 0). The
 * caller computes them from its own centre and optical offset, so this
 * function stays free of viewport state.
 *
 * X wraps modulo 2**z, because the world is a cylinder. Y does NOT wrap and is
 * NOT clamped: a row outside [0, 2**z) has no tile, so it is omitted and the
 * ground colour shows through. Clamping would re-request the polar row over and
 * over for the same screen band, which is the bulk-download pattern the policy
 * exists to stop. At z >= 11 over Belgium neither branch is ever taken.
 *
 * @param {{originX:number, originY:number, w:number, h:number, zoom:number}} v
 * @returns {Array<{key:string, z:number, x:number, y:number, left:number, top:number}>}
 */
export function tilesForViewport(v) {
  const { originX, originY, w, h, zoom } = v;
  const out = [];
  if (!(w > 0) || !(h > 0)) return out;

  const span = Math.pow(2, zoom);
  const x0 = Math.floor(originX / TILE_SIZE);
  const x1 = Math.ceil((originX + w) / TILE_SIZE) - 1;
  const y0 = Math.floor(originY / TILE_SIZE);
  const y1 = Math.ceil((originY + h) / TILE_SIZE) - 1;

  for (let ty = y0; ty <= y1; ty++) {
    if (ty < 0 || ty >= span) continue;          // no such tile, leave the ground
    for (let tx = x0; tx <= x1; tx++) {
      const wrapped = ((tx % span) + span) % span;
      out.push({
        key: zoom + "/" + wrapped + "/" + ty,
        z: zoom,
        x: wrapped,
        y: ty,
        left: tx * TILE_SIZE - originX,
        top: ty * TILE_SIZE - originY,
      });
    }
  }
  return out;
}

/**
 * The tile a WGS84 point falls in at this zoom.
 * @returns {{z:number, x:number, y:number, fx:number, fy:number}}
 *          fx/fy are the pixel offsets inside the tile, 0..255.
 */
export function tileOf(lat, lon, zoom) {
  const px = lonToX(lon, zoom);
  const py = latToY(lat, zoom);
  const x = Math.floor(px / TILE_SIZE);
  const y = Math.floor(py / TILE_SIZE);
  return { z: zoom, x, y, fx: px - x * TILE_SIZE, fy: py - y * TILE_SIZE };
}

/**
 * The WGS84 bounds a tile covers, as [west, south, east, north].
 * Used by the reference checks, not by the renderer.
 */
export function tileBounds(z, x, y) {
  return [
    xToLon(x * TILE_SIZE, z),
    yToLat((y + 1) * TILE_SIZE, z),
    xToLon((x + 1) * TILE_SIZE, z),
    yToLat(y * TILE_SIZE, z),
  ];
}

// ---------------------------------------------------------------------------
// 3. EPSG:3035 inverse, by Newton on grid.js's own forward
// ---------------------------------------------------------------------------

/**
 * Invert grid.js's laeaForward numerically.
 *
 * The closed-form LAEA inverse exists (Snyder 3-16 through 3-18) and is not
 * used here on purpose. Writing it out would create a SECOND set of projection
 * constants that could disagree with grid.js and with scripts/grid.py without
 * any test noticing, and CI gate 8 only pins the forward direction. Solving the
 * forward function instead makes disagreement structurally impossible: if the
 * forward path moves, the inverse moves with it.
 *
 * Newton with a numerically differentiated 2x2 Jacobian, h = 1e-6 degrees
 * (about 11 cm). Five passes, early exit once the residual is under a
 * MICROMETRE. Measured from a seed 100 km away, every Belgian pilot converges
 * in three passes; the prototype's 1 mm threshold stopped one pass earlier and
 * returned points up to 0.68 mm out, which is invisible but needlessly loose
 * when the extra pass is one call to a closed-form function.
 *
 * The seed is a nearby WGS84 point; every caller has one, because a GRD_NEWID
 * cell is by construction within 1.5 km of the position that produced it.
 *
 * @param {number} x EPSG:3035 easting, metres
 * @param {number} y EPSG:3035 northing, metres
 * @param {number} seedLat @param {number} seedLon  a nearby WGS84 point
 * @returns {{lat:number, lon:number, residualM:number, iterations:number}}
 */
export function laeaInverse(x, y, seedLat, seedLon) {
  let lat = seedLat;
  let lon = seedLon;
  const h = 1e-6;
  let residual = Infinity;
  let i = 0;

  for (; i < 5; i++) {
    const p = laeaForward(lat, lon);
    const dx = x - p.x;
    const dy = y - p.y;
    residual = Math.sqrt(dx * dx + dy * dy);
    if (residual < 1e-6) break;                   // one micrometre

    const pLon = laeaForward(lat, lon + h);
    const pLat = laeaForward(lat + h, lon);
    const j11 = (pLon.x - p.x) / h;               // dx/dlon
    const j12 = (pLat.x - p.x) / h;               // dx/dlat
    const j21 = (pLon.y - p.y) / h;               // dy/dlon
    const j22 = (pLat.y - p.y) / h;               // dy/dlat
    const det = j11 * j22 - j12 * j21;
    if (!det || !Number.isFinite(det)) break;

    lon += (dx * j22 - dy * j12) / det;
    lat += (dy * j11 - dx * j21) / det;
  }

  return { lat, lon, residualM: residual, iterations: i };
}

/**
 * The four WGS84 corners of a GRD_NEWID 1 km cell.
 *
 * GRD_NEWID names the cell by the floor of its south-west corner in whole
 * kilometres of EPSG:3035 (CONTRACT 7.1), so the square is
 * [E*1000, E*1000+1000] x [N*1000, N*1000+1000] in projected metres. Returned
 * unclosed, in the prototype's order: NW, NE, SE, SW.
 *
 * The four corners are NOT a rectangle in WGS84. LAEA is equal-area, not
 * conformal, so the cell is a slightly skewed quadrilateral on the globe, and
 * drawing it as an axis-aligned box would be a lie of roughly 3 m at Belgian
 * latitudes. Each corner is inverted individually.
 *
 * @param {string} cell e.g. "1kmN3097E3924"
 * @param {number} seedLat @param {number} seedLon nearby WGS84 point
 * @returns {Array<[number, number]>|null} [[lon, lat] x 4], or null on a bad id
 */
export function cellRing(cell, seedLat, seedLon) {
  let parsed;
  try {
    parsed = parseCell(cell);
  } catch (e) {
    return null;
  }
  const e0 = parsed.east * 1000;
  const n0 = parsed.north * 1000;
  const corners = [
    [e0, n0 + 1000],
    [e0 + 1000, n0 + 1000],
    [e0 + 1000, n0],
    [e0, n0],
  ];
  const ring = [];
  let lat = seedLat;
  let lon = seedLon;
  for (const c of corners) {
    // Walk the seed along the ring: each corner is at most 1.4 km from the
    // previous one, so pass two is already inside a millimetre.
    const g = laeaInverse(c[0], c[1], lat, lon);
    lat = g.lat;
    lon = g.lon;
    ring.push([g.lon, g.lat]);
  }
  return ring;
}

// ---------------------------------------------------------------------------
// 4. Small geometry helpers the renderer needs
// ---------------------------------------------------------------------------

/**
 * Bounding box of a GeoJSON geometry, as [west, south, east, north].
 * Handles Polygon and MultiPolygon, which per CONTRACT 6 is everything that
 * ships. Returns null for anything else.
 */
export function geometryBounds(geometry) {
  if (!geometry || !Array.isArray(geometry.coordinates)) return null;
  const polys =
    geometry.type === "MultiPolygon" ? geometry.coordinates
      : geometry.type === "Polygon" ? [geometry.coordinates]
        : null;
  if (!polys) return null;

  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const poly of polys) {
    if (!Array.isArray(poly)) continue;
    for (const ring of poly) {
      if (!Array.isArray(ring)) continue;
      for (const pt of ring) {
        const lon = pt[0], lat = pt[1];
        if (lon < w) w = lon;
        if (lon > e) e = lon;
        if (lat < s) s = lat;
        if (lat > n) n = lat;
      }
    }
  }
  return w === Infinity ? null : [w, s, e, n];
}

/** Do two [w, s, e, n] boxes overlap? Inclusive, so a shared edge counts. */
export function boundsIntersect(a, b) {
  if (!a || !b) return false;
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}
