/**
 * BeHERE spatial index: the Statbel GRD_NEWID 1 km cell.
 *
 * Verified against every one of the 4,490,779 rows of
 * TF_RGN_ADDRESSES_STAT_SECTORS_20250401.txt (Statbel, vintage 2025-04-01).
 *
 * GRD_NEWID is the INSPIRE 1 km grid cell in EPSG:3035 (ETRS89-LAEA Europe):
 *
 *     "1kmN" + floor(northing_m / 1000) + "E" + floor(easting_m / 1000)
 *
 * Projection: Lambert Azimuthal Equal Area on GRS80, Snyder pp. 187-190.
 *     a = 6378137.0, rf = 298.257222101
 *     lat_0 = 52, lon_0 = 10, x_0 = 4321000, y_0 = 3210000
 *
 * This is the exact twin of scripts/grid.py. Same constants, same operation
 * order, byte-identical output strings. Plain ES module, no build step.
 */

// --- EPSG:3035 constants -------------------------------------------------

const A = 6378137.0;                 // GRS80 semi-major axis
const F = 1.0 / 298.257222101;       // GRS80 inverse flattening
const E2 = F * (2.0 - F);            // first eccentricity squared
const E = Math.sqrt(E2);
const LAT0 = (52.0 * Math.PI) / 180.0;
const LON0 = (10.0 * Math.PI) / 180.0;
const X0 = 4321000.0;
const Y0 = 3210000.0;

/** Snyder 3-12: the authalic-latitude numerator. */
function q(sinPhi) {
  const es = E * sinPhi;
  return (
    (1.0 - E2) *
    (sinPhi / (1.0 - es * es) -
      (1.0 / (2.0 * E)) * Math.log((1.0 - es) / (1.0 + es)))
  );
}

const QP = q(1.0);
const RQ = A * Math.sqrt(QP / 2.0);
const BETA0 = Math.asin(q(Math.sin(LAT0)) / QP);
const SIN_B0 = Math.sin(BETA0);
const COS_B0 = Math.cos(BETA0);
const M0 = Math.cos(LAT0) / Math.sqrt(1.0 - E2 * Math.pow(Math.sin(LAT0), 2));
const D = (A * M0) / (RQ * COS_B0);

/**
 * WGS84 / ETRS89 degrees to EPSG:3035 metres.
 * @param {number} lat @param {number} lon
 * @returns {{x: number, y: number}} easting, northing
 */
export function laeaForward(lat, lon) {
  const phi = (lat * Math.PI) / 180.0;
  const dlam = (lon * Math.PI) / 180.0 - LON0;
  const beta = Math.asin(q(Math.sin(phi)) / QP);
  const sinB = Math.sin(beta);
  const cosB = Math.cos(beta);
  const cosDl = Math.cos(dlam);
  const b = RQ * Math.sqrt(2.0 / (1.0 + SIN_B0 * sinB + COS_B0 * cosB * cosDl));
  const x = b * D * cosB * Math.sin(dlam);
  const y = (b / D) * (COS_B0 * sinB - SIN_B0 * cosB * cosDl);
  return { x: x + X0, y: y + Y0 };
}

// --- the cell ------------------------------------------------------------

/**
 * WGS84 degrees to a Statbel GRD_NEWID, e.g. "1kmN3126E3927".
 * @param {number} lat @param {number} lon @returns {string}
 */
export function wgs84ToCell(lat, lon) {
  const p = laeaForward(lat, lon);
  return "1kmN" + Math.floor(p.y / 1000.0) + "E" + Math.floor(p.x / 1000.0);
}

/**
 * "1kmN3126E3927" to { north: 3126, east: 3927 } in whole km.
 * @param {string} cell
 */
export function parseCell(cell) {
  if (typeof cell !== "string" || !cell.startsWith("1kmN")) {
    throw new Error("not a 1 km cell id: " + cell);
  }
  const i = cell.indexOf("E", 4);
  if (i < 0) throw new Error("not a 1 km cell id: " + cell);
  return { north: parseInt(cell.slice(4, i), 10), east: parseInt(cell.slice(i + 1), 10) };
}

/** (3126, 3927) to "1kmN3126E3927". */
export function formatCell(northKm, eastKm) {
  return "1kmN" + northKm + "E" + eastKm;
}

/**
 * The 9 cell ids covering `cell` and its 8 touching neighbours.
 * Order is fixed and deterministic: self first, then the surrounding ring in
 * reading order (north row west to east, middle row, south row).
 * @param {string} cell @returns {string[]}
 */
export function neighbours(cell) {
  const { north, east } = parseCell(cell);
  const out = [formatCell(north, east)];
  for (const dn of [1, 0, -1]) {
    for (const de of [-1, 0, 1]) {
      if (dn === 0 && de === 0) continue;
      out.push(formatCell(north + dn, east + de));
    }
  }
  return out;
}

/** [minX, minY, maxX, maxY] of the cell in EPSG:3035 metres. */
export function cellBounds3035(cell) {
  const { north, east } = parseCell(cell);
  return [east * 1000, north * 1000, east * 1000 + 1000, north * 1000 + 1000];
}
