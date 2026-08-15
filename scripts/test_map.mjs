/**
 * BeHERE map engine test.
 *
 * Covers web/app/mercator.js (projection, tile extent, the EPSG:3035 inverse)
 * and web/app/map.js (mount, layers, tile policy, offline degradation,
 * selection, keyboard mode, teardown).
 *
 * Two halves:
 *   A. Projection, checked against published reference values and against the
 *      real baked tree in web/data/.
 *   B. The engine itself, mounted on a DOM small enough to live in this file.
 *      There is no npm in this repo and never will be, so there is no jsdom;
 *      the stub below implements exactly the surface map.js touches, and any
 *      call outside that surface throws rather than passing silently.
 *
 * Run: node scripts/test_map.mjs        Exits 0 on success, 1 on any failure.
 * No dependencies, no package.json, exactly like the other scripts/test_*.mjs.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  worldSize, lonToX, latToY, project, unproject,
  metresPerPixel, tilesForViewport, tileOf, tileBounds,
  laeaInverse, cellRing, geometryBounds, boundsIntersect,
} from "../web/app/mercator.js";
import { laeaForward, wgs84ToCell, parseCell } from "../web/app/grid.js";
import { decodeShard, haversineMetres } from "../web/app/geo.js";
import { installDom } from "./domstub.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const read = (p) => JSON.parse(readFileSync(join(REPO, p), "utf8"));

let fails = 0;
function ok(cond, label, extra) {
  if (!cond) fails++;
  console.log((cond ? "PASS " : "FAIL ") + label + (extra !== undefined ? "  " + extra : ""));
}
const f = (n, d = 3) => Number(n).toFixed(d);
const line = (t) => { console.log(); console.log("=".repeat(74)); console.log(t); console.log("=".repeat(74)); };

// ------------------------------------------------------------------------
// PART A: PROJECTION
// ------------------------------------------------------------------------

console.log("=".repeat(74));
console.log("A1. NULL ISLAND: lon 0, lat 0 must be the exact centre of the world");
console.log("=".repeat(74));
for (const z of [0, 1, 12, 15]) {
  const p = project(0, 0, z);
  const w = worldSize(z);
  console.log(`  z=${z}  world=${w}px  project(0,0) = (${p.x}, ${p.y})  world/2 = ${w / 2}`);
  ok(p.x === w / 2 && p.y === w / 2, `z${z} lon0/lat0 -> world centre`);
}
{
  const t = tileOf(0, 0, 0);
  console.log(`  tileOf(0,0,z0) = ${t.z}/${t.x}/${t.y}  offset inside tile = (${t.fx}, ${t.fy})`);
  ok(t.z === 0 && t.x === 0 && t.y === 0 && t.fx === 128 && t.fy === 128,
     "z0 lon0/lat0 lands dead centre of tile 0/0/0");
}

console.log();
console.log("=".repeat(74));
console.log("A2. ROUND TRIP: project -> unproject, over the Belgian bounding box");
console.log("=".repeat(74));
{
  let worst = 0, worstAt = null;
  for (let lat = 49.4; lat <= 51.6; lat += 0.05) {
    for (let lon = 2.5; lon <= 6.5; lon += 0.05) {
      for (const z of [11, 15, 17]) {
        const p = project(lat, lon, z);
        const g = unproject(p.x, p.y, z);
        const d = haversineMetres(lat, lon, g.lat, g.lon);
        if (d > worst) { worst = d; worstAt = [lat, lon, z]; }
      }
    }
  }
  console.log(`  worst round-trip error over ${45 * 81 * 3} points: ${worst.toExponential(3)} m  at ${JSON.stringify(worstAt)}`);
  ok(worst < 1e-6, "project/unproject round trip is exact to under a micrometre");
}

console.log();
console.log("=".repeat(74));
console.log("A3. THE PROTOTYPE'S PROBE TILE 12/2094/1368, and where Brussels really is");
console.log("=".repeat(74));
{
  const b = tileBounds(12, 2094, 1368);
  console.log(`  tile 12/2094/1368 covers  lon ${f(b[0], 5)} .. ${f(b[2], 5)}   lat ${f(b[1], 5)} .. ${f(b[3], 5)}`);

  // Grand-Place, City of Brussels. The exact centroid of the prototype's own
  // fixture position, and the anchor of 21004/sector.geojson feature 21004A001.
  const BRU = { lat: 50.84673, lon: 4.35247 };
  const t12 = tileOf(BRU.lat, BRU.lon, 12);
  console.log(`  Brussels ${BRU.lat}, ${BRU.lon}  at z12 -> tile ${t12.z}/${t12.x}/${t12.y}`);
  console.log(`     px within tile: (${f(t12.fx, 3)}, ${f(t12.fy, 3)})`);
  const bb = tileBounds(t12.z, t12.x, t12.y);
  console.log(`     that tile covers lon ${f(bb[0], 5)} .. ${f(bb[2], 5)}  lat ${f(bb[1], 5)} .. ${f(bb[3], 5)}`);
  ok(BRU.lon >= bb[0] && BRU.lon <= bb[2] && BRU.lat >= bb[1] && BRU.lat <= bb[3],
     "Brussels falls inside the tile tileOf() names");
  const insideProbe = BRU.lon >= b[0] && BRU.lon <= b[2] && BRU.lat >= b[1] && BRU.lat <= b[3];
  console.log(`  is Brussels inside 12/2094/1368?  ${insideProbe}`);

  // Sanity: world px of the tile corner must equal x*256.
  const px = lonToX(bb[0], 12), py = latToY(bb[3], 12);
  console.log(`  tile corner world px = (${f(px, 4)}, ${f(py, 4)})  expected (${t12.x * 256}, ${t12.y * 256})`);
  ok(Math.abs(px - t12.x * 256) < 1e-6 && Math.abs(py - t12.y * 256) < 1e-6,
     "tile corner reprojects to exactly x*256, y*256");
}

console.log();
console.log("=".repeat(74));
console.log("A4. SCALE: metresPerPixel against published OSM ground resolutions");
console.log("=".repeat(74));
{
  // Published slippy-map resolution at the equator, 256px tiles.
  const eq = [
    [0, 156543.03],
    [11, 76.437],
    [15, 4.777],
    [17, 1.194],
  ];
  for (const [z, want] of eq) {
    const got = metresPerPixel(0, z);
    console.log(`  z=${z}  equator m/px = ${f(got, 5)}   published ${want}`);
    // The published table is rounded, so the test is against half a unit in
    // its own last printed place, not against a tighter number than exists.
    const dp = (String(want).split(".")[1] || "").length;
    const tol = 0.5 * Math.pow(10, -dp);
    ok(Math.abs(got - want) <= tol, `equator resolution at z${z}`,
       `|${f(got,5)} - ${want}| = ${(Math.abs(got-want)).toExponential(2)} <= ${tol}`);
  }
  for (const z of [11, 15, 17]) {
    const m = metresPerPixel(50.8467, z);
    console.log(`  z=${z}  Brussels (50.8467 N) m/px = ${f(m, 5)}   scale readout = "${Math.round(m * 100)} m per 100 px"`);
  }
}

console.log();
console.log("=".repeat(74));
console.log("A5. TILE EXTENT: exactly the tiles that intersect, and not one more");
console.log("=".repeat(74));
{
  // A 390x844 phone (iPhone 14) and a 1440x900 laptop, centred on Brussels.
  for (const [w, h, label] of [[390, 844, "phone 390x844"], [1440, 900, "laptop 1440x900"]]) {
    const z = 15;
    const ox = lonToX(4.35247, z) - w / 2;
    const oy = latToY(50.84673, z) - h / 2;
    const tiles = tilesForViewport({ originX: ox, originY: oy, w, h, zoom: z });
    const cols = new Set(tiles.map((t) => t.x)).size;
    const rows = new Set(tiles.map((t) => t.y)).size;
    const minCols = Math.ceil(w / 256), minRows = Math.ceil(h / 256);
    console.log(`  ${label} @z15 -> ${tiles.length} tiles (${cols} x ${rows}); ceil coverage is ${minCols} x ${minRows}, plus at most one partial each way`);
    ok(cols <= minCols + 1 && rows <= minRows + 1, `${label}: no speculative ring`);
    // Every tile must actually touch the viewport.
    let stray = 0;
    for (const t of tiles) {
      if (t.left >= w || t.top >= h || t.left + 256 <= 0 || t.top + 256 <= 0) stray++;
    }
    ok(stray === 0, `${label}: every requested tile intersects the viewport`, `strays=${stray}`);
  }
  // The prototype's +1 ring, for comparison.
  const protoRx = Math.ceil(390 / 2 / 256) + 1, protoRy = Math.ceil(844 / 2 / 256) + 1;
  console.log(`  prototype on the same phone: (2*${protoRx}+1) x (2*${protoRy}+1) = ${(2 * protoRx + 1) * (2 * protoRy + 1)} tiles`);
}

console.log();
console.log("=".repeat(74));
console.log("A6. EPSG:3035 INVERSE: Newton on grid.js's own laeaForward");
console.log("=".repeat(74));
{
  const pts = [
    ["Grand-Place, Brussels", 50.84673, 4.35247],
    ["Ghent centre", 51.05430, 3.72510],
    ["Liege centre", 50.64520, 5.57490],
    ["Ostend", 51.22470, 2.91260],
    ["Arlon", 49.68330, 5.81670],
    ["Andenne", 50.48920, 5.09650],
    ["Ottignies-LLN", 50.66840, 4.61240],
  ];
  let worstM = 0, worstIter = 0;
  for (const [name, lat, lon] of pts) {
    const p = laeaForward(lat, lon);
    const inv = laeaInverse(p.x, p.y, 50.5, 4.5);   // one seed for all of them
    const err = haversineMetres(lat, lon, inv.lat, inv.lon);
    worstM = Math.max(worstM, err);
    worstIter = Math.max(worstIter, inv.iterations);
    console.log(`  ${name.padEnd(24)} 3035 = (${f(p.x, 3)}, ${f(p.y, 3)})  inverse err ${err.toExponential(2)} m in ${inv.iterations} passes`);
  }
  ok(worstM < 1e-6, "laeaInverse recovers WGS84 to under a micrometre", `worst ${worstM.toExponential(2)} m`);
  // And the definitive test, independent of any distance model: forward-project
  // the answer and compare in EPSG:3035 metres, which is where the cell lives.
  let worstXY = 0;
  for (const [, lat, lon] of pts) {
    const p = laeaForward(lat, lon);
    const inv = laeaInverse(p.x, p.y, 50.5, 4.5);
    const back = laeaForward(inv.lat, inv.lon);
    worstXY = Math.max(worstXY, Math.hypot(back.x - p.x, back.y - p.y));
  }
  console.log(`  forward(inverse(xy)) - xy, worst over the seven pilots: ${worstXY.toExponential(2)} m`);
  ok(worstXY < 1e-6, "the inverse closes on grid.js's own forward to under a micrometre");
  ok(worstIter <= 4, "converges in at most 4 passes from a 100 km seed", `worst ${worstIter}`);
}

console.log();
console.log("=".repeat(74));
console.log("A7. cellRing AGAINST REAL BAKED SHARDS");
console.log("=".repeat(74));
{
  /* Vincenty inverse on WGS84. The yardstick matters here: spherical haversine
     at R = 6 371 008.8 m UNDERSTATES a Belgian ground distance by about 0.19%,
     which is 1.9 m per kilometre, so measuring a 1 km cell edge with it would
     make a correct projection look 2 m wrong. */
  function vincenty(lat1, lon1, lat2, lon2) {
    const a = 6378137.0, f = 1 / 298.257223563, b = (1 - f) * a;
    const L = (lon2 - lon1) * Math.PI / 180;
    const U1 = Math.atan((1 - f) * Math.tan(lat1 * Math.PI / 180));
    const U2 = Math.atan((1 - f) * Math.tan(lat2 * Math.PI / 180));
    const sU1 = Math.sin(U1), cU1 = Math.cos(U1), sU2 = Math.sin(U2), cU2 = Math.cos(U2);
    let lam = L, lamP, it = 0, sS, cS, sig, sA, c2Sm, C;
    do {
      const sL = Math.sin(lam), cL = Math.cos(lam);
      sS = Math.sqrt((cU2 * sL) ** 2 + (cU1 * sU2 - sU1 * cU2 * cL) ** 2);
      if (sS === 0) return 0;
      cS = sU1 * sU2 + cU1 * cU2 * cL;
      sig = Math.atan2(sS, cS);
      sA = cU1 * cU2 * sL / sS;
      const c2A = 1 - sA * sA;
      c2Sm = c2A === 0 ? 0 : cS - 2 * sU1 * sU2 / c2A;
      C = f / 16 * c2A * (4 + f * (4 - 3 * c2A));
      lamP = lam;
      lam = L + (1 - C) * f * sA * (sig + C * sS * (c2Sm + C * cS * (-1 + 2 * c2Sm * c2Sm)));
    } while (Math.abs(lam - lamP) > 1e-12 && ++it < 100);
    const u2 = (1 - sA * sA) * (a * a - b * b) / (b * b);
    const A = 1 + u2 / 16384 * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
    const B = u2 / 1024 * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
    const dS = B * sS * (c2Sm + B / 4 * (cS * (-1 + 2 * c2Sm * c2Sm)
      - B / 6 * c2Sm * (-3 + 4 * sS * sS) * (-3 + 4 * c2Sm * c2Sm)));
    return b * A * (sig - dS);
  }

  function inRing(lat, lon, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > lat) !== (yj > lat) && lon < xi + (lat - yi) * (xj - xi) / (yj - yi)) inside = !inside;
    }
    return inside;
  }

  const meta = read("web/data/21004/meta.json");
  const cells = meta.cells.slice(0, 6);
  let worstCorner = 0, worstEdgeV = 0, worstEdgeH = 0, totalAddr = 0, outside = 0, offCell = 0;

  for (const cell of cells) {
    const { north, east } = parseCell(cell);
    const shard = decodeShard(read("web/data/grid/" + cell + ".json"));
    const seed = shard.addresses.length
      ? shard.addresses[0]
      : { lat: (shard.origin[0] + 500) / 1e5, lon: (shard.origin[1] + 500) / 1e5 };
    const ring = cellRing(cell, seed.lat, seed.lon);

    /* THE DEFINITIVE CHECK: forward-project each returned corner with grid.js
       and compare to the exact EPSG:3035 metres the cell id names. This is
       model-free, and it is the only claim cellRing actually makes. */
    const want = [
      [east * 1000, north * 1000 + 1000],
      [east * 1000 + 1000, north * 1000 + 1000],
      [east * 1000 + 1000, north * 1000],
      [east * 1000, north * 1000],
    ];
    let cornerErr = 0;
    for (let i = 0; i < 4; i++) {
      const p = laeaForward(ring[i][1], ring[i][0]);
      cornerErr = Math.max(cornerErr, Math.hypot(p.x - want[i][0], p.y - want[i][1]));
    }
    worstCorner = Math.max(worstCorner, cornerErr);

    const eN = vincenty(ring[0][1], ring[0][0], ring[1][1], ring[1][0]);
    const eE = vincenty(ring[1][1], ring[1][0], ring[2][1], ring[2][0]);
    const eS = vincenty(ring[2][1], ring[2][0], ring[3][1], ring[3][0]);
    const eW = vincenty(ring[3][1], ring[3][0], ring[0][1], ring[0][0]);
    worstEdgeH = Math.max(worstEdgeH, Math.abs(eN - 1000), Math.abs(eS - 1000));
    worstEdgeV = Math.max(worstEdgeV, Math.abs(eE - 1000), Math.abs(eW - 1000));

    let out = 0, redrive = 0;
    for (const a of shard.addresses) {
      if (!inRing(a.lat, a.lon, ring)) out++;
      if (wgs84ToCell(a.lat, a.lon) !== cell) redrive++;
    }
    totalAddr += shard.addresses.length;
    outside += out;
    offCell += redrive;

    console.log(`  ${cell}  SW=(${f(ring[3][1], 5)}, ${f(ring[3][0], 5)})`);
    console.log(`     corner error vs exact EPSG:3035 metres: ${cornerErr.toExponential(2)} m`);
    console.log(`     Vincenty edges N/E/S/W = ${f(eN, 3)} ${f(eE, 3)} ${f(eS, 3)} ${f(eW, 3)} m`);
    console.log(`     ${shard.addresses.length} baked addresses, ${out} outside the drawn ring, ${redrive} re-derive to another cell`);
    ok(cornerErr < 1e-5, `${cell}: corners land on the exact 3035 kilometre grid`);
  }

  console.log(`  worst corner error over ${cells.length} real cells: ${worstCorner.toExponential(2)} m`);
  console.log(`  worst edge deviation from 1000 m, Vincenty on WGS84: E-W ${f(worstEdgeH, 3)} m, N-S ${f(worstEdgeV, 3)} m`);
  console.log(`  (LAEA is equal-AREA, not conformal, so a 1 km projected edge is not exactly 1 km on the ground)`);
  console.log(`  ${totalAddr} baked addresses: ${outside} fall outside the drawn ring, ${offCell} re-derive to another cell`);
  ok(worstCorner < 1e-5, "every corner is exact in the projection the cell is defined in");
  ok(worstEdgeH < 3 && worstEdgeV < 3, "ground edges are 1 km to within LAEA's own distortion");
  ok(outside / Math.max(1, totalAddr) < 0.005, "over 99.5% of baked addresses fall inside the drawn ring",
     `${outside}/${totalAddr}`);

  // The handful that do not: 5-decimal-place coordinates are ~1.1 m of
  // latitude (CONTRACT 1.2), so an address within about a metre of a cell edge
  // can round across it. Show that this is what they are.
  {
    const cell = "1kmN3092E3924";
    const { north, east } = parseCell(cell);
    const shard = decodeShard(read("web/data/grid/" + cell + ".json"));
    for (const a of shard.addresses) {
      if (wgs84ToCell(a.lat, a.lon) === cell) continue;
      const p = laeaForward(a.lat, a.lon);
      const dE = Math.min(p.x - east * 1000, (east + 1) * 1000 - p.x);
      const dN = Math.min(p.y - north * 1000, (north + 1) * 1000 - p.y);
      console.log(`  boundary case in ${cell}: house ${a.house}, 3035 offset inside cell = (${f(dE, 3)}, ${f(dN, 3)}) m from the nearest edge -> re-derives to ${wgs84ToCell(a.lat, a.lon)}`);
    }
  }

  const r = cellRing(cells[0], 50.85, 4.35);
  const conv = Math.atan2((r[0][0] - r[3][0]) * Math.cos(50.85 * Math.PI / 180), r[0][1] - r[3][1]) * 180 / Math.PI;
  console.log(`  grid convergence at ${cells[0]}: the cell's north edge bears ${f(conv, 3)} deg from true north`);
  console.log(`     predicted by dLon * sin(lat) = ${f((4.35 - 10) * Math.sin(50.85 * Math.PI / 180), 3)} deg`);
  ok(Math.abs(conv - (4.35 - 10) * Math.sin(50.85 * Math.PI / 180)) < 0.15,
     "the cell's rotation matches EPSG:3035 meridian convergence, so it is not drawn axis-aligned");
  ok(cellRing("not a cell", 50, 4) === null, "cellRing refuses a malformed id instead of throwing");
}

console.log();
console.log("=".repeat(74));
console.log("A8. A REAL SECTOR POLYGON PROJECTS TO SANE SCREEN COORDINATES");
console.log("=".repeat(74));
{
  const fc = read("web/data/21004/sector.geojson");
  console.log(`  21004/sector.geojson: ${fc.features.length} features, tolerance ${fc.properties.tolerance_m} m, vintage ${fc.properties.vintage}`);

  // Screen model: a 390x844 phone at z15, centred on the Grand-Place, dock 168.
  const w = 390, h = 844, z = 15, dock = 168;
  const cLat = 50.84673, cLon = 4.35247;
  const ox = lonToX(cLon, z) - w / 2;
  const oy = latToY(cLat, z) - (h - dock) / 2;
  const scr = (lat, lon) => ({ x: lonToX(lon, z) - ox, y: latToY(lat, z) - oy });

  // The sector the position is standing in.
  const target = fc.features.find((ft) => ft.properties.s === "21004A001") || fc.features[0];
  const g = target.geometry;
  console.log(`  feature ${target.properties.s}  "${target.properties.fr}" / "${target.properties.nl}"  type ${g.type}`);
  const ring = g.coordinates[0][0];
  console.log(`  outer ring: ${ring.length} vertices`);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of ring) {
    const s = scr(p[1], p[0]);
    minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x);
    minY = Math.min(minY, s.y); maxY = Math.max(maxY, s.y);
  }
  console.log(`  projected screen bbox: x ${f(minX, 1)} .. ${f(maxX, 1)}   y ${f(minY, 1)} .. ${f(maxY, 1)}`);
  console.log(`  first five vertices:`);
  for (let i = 0; i < 5 && i < ring.length; i++) {
    const s = scr(ring[i][1], ring[i][0]);
    console.log(`     [${f(ring[i][0], 5)}, ${f(ring[i][1], 5)}]  ->  (${f(s.x, 1)}, ${f(s.y, 1)}) px`);
  }
  ok(Number.isFinite(minX) && Number.isFinite(minY), "every vertex projects to a finite pixel");
  ok(minX > -5000 && maxX < 5000 && minY > -5000 && maxY < 5000,
     "the sector lands within a few screens of the viewport, not at infinity");
  const mpp = metresPerPixel(cLat, z);
  const widthM = (maxX - minX) * mpp, heightM = (maxY - minY) * mpp;
  console.log(`  that is ${f(widthM, 0)} x ${f(heightM, 0)} m on the ground at ${f(mpp, 3)} m/px`);
  ok(widthM > 50 && widthM < 20000, "sector ground width is plausible for a city block");

  // Culling: how many of the 112 features intersect this viewport?
  const a = unproject(ox - 64, oy - 64, z);
  const b = unproject(ox + w + 64, oy + h + 64, z);
  const vb = [Math.min(a.lon, b.lon), Math.min(a.lat, b.lat), Math.max(a.lon, b.lon), Math.max(a.lat, b.lat)];
  let vis = 0, verts = 0, visVerts = 0;
  for (const ft of fc.features) {
    const bb = geometryBounds(ft.geometry);
    let n = 0;
    for (const poly of ft.geometry.coordinates) for (const r of poly) n += r.length;
    verts += n;
    if (boundsIntersect(bb, vb)) { vis++; visVerts += n; }
  }
  console.log(`  viewport bbox lon ${f(vb[0], 5)} .. ${f(vb[2], 5)}  lat ${f(vb[1], 5)} .. ${f(vb[3], 5)}`);
  console.log(`  culling: ${vis} of ${fc.features.length} features intersect, ${visVerts} of ${verts} vertices projected per frame (${f(100 * visVerts / verts, 1)}%)`);
  ok(vis < fc.features.length, "bbox culling actually removes features");
}

console.log();
console.log("=".repeat(74));
console.log("A9. GHENT: the worst-case sector file, culled");
console.log("=".repeat(74));
{
  const fc = read("web/data/44021/sector.geojson");
  let verts = 0;
  for (const ft of fc.features) for (const poly of ft.geometry.coordinates) for (const r of poly) verts += r.length;
  console.log(`  44021/sector.geojson: ${fc.features.length} features, ${verts} vertices, tolerance ${fc.properties.tolerance_m} m`);
  const w = 390, h = 844, z = 15, dock = 168;
  const cLat = 51.05430, cLon = 3.72510;
  const ox = lonToX(cLon, z) - w / 2;
  const oy = latToY(cLat, z) - (h - dock) / 2;
  const a = unproject(ox - 64, oy - 64, z);
  const b = unproject(ox + w + 64, oy + h + 64, z);
  const vb = [Math.min(a.lon, b.lon), Math.min(a.lat, b.lat), Math.max(a.lon, b.lon), Math.max(a.lat, b.lat)];
  let vis = 0, visVerts = 0;
  for (const ft of fc.features) {
    const bb = geometryBounds(ft.geometry);
    let n = 0;
    for (const poly of ft.geometry.coordinates) for (const r of poly) n += r.length;
    if (boundsIntersect(bb, vb)) { vis++; visVerts += n; }
  }
  console.log(`  at z15 on a phone: ${vis} of ${fc.features.length} features, ${visVerts} of ${verts} vertices per frame (${f(100 * visVerts / verts, 1)}%)`);
  // and at the widest zoom, where nothing is culled
  const z11 = 11;
  const ox11 = lonToX(cLon, z11) - w / 2, oy11 = latToY(cLat, z11) - (h - dock) / 2;
  const a11 = unproject(ox11 - 64, oy11 - 64, z11), b11 = unproject(ox11 + w + 64, oy11 + h + 64, z11);
  const vb11 = [Math.min(a11.lon, b11.lon), Math.min(a11.lat, b11.lat), Math.max(a11.lon, b11.lon), Math.max(a11.lat, b11.lat)];
  let vis11 = 0, visVerts11 = 0;
  for (const ft of fc.features) {
    const bb = geometryBounds(ft.geometry);
    let n = 0;
    for (const poly of ft.geometry.coordinates) for (const r of poly) n += r.length;
    if (boundsIntersect(bb, vb11)) { vis11++; visVerts11 += n; }
  }
  console.log(`  at z11 (widest): ${vis11} features, ${visVerts11} vertices per frame`);
  ok(visVerts < verts, "Ghent is culled at phone zoom");
}

console.log();
console.log("=".repeat(74));
console.log("A10. STOPS FROM A REAL SHARD -> MARKERS -> SCREEN");
console.log("=".repeat(74));
{
  const meta = read("web/data/21004/meta.json");
  let best = null;
  for (const cell of meta.cells) {
    const shard = decodeShard(read("web/data/grid/" + cell + ".json"));
    if (!best || shard.stops.length > best.stops.length) best = shard;
  }
  console.log(`  busiest Brussels cell ${best.cell}: ${best.stops.length} stops, ${best.addresses.length} addresses`);
  const groups = new Map();
  for (const s of best.stops) {
    const k = s.parent || s.id;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  console.log(`  grouped by parent station -> ${groups.size} boarding points`);
  const z = 15, w = 390, h = 844, dock = 168;
  const cLat = best.stops[0].lat, cLon = best.stops[0].lon;
  const ox = lonToX(cLon, z) - w / 2, oy = latToY(cLat, z) - (h - dock) / 2;
  let i = 0, onScreen = 0;
  for (const [k, list] of groups) {
    const lat = list.reduce((s, x) => s + x.lat, 0) / list.length;
    const lon = list.reduce((s, x) => s + x.lon, 0) / list.length;
    const x = lonToX(lon, z) - ox, y = latToY(lat, z) - oy;
    const vis = x > -64 && x < w + 64 && y > -64 && y < h + 64;
    if (vis) onScreen++;
    if (i++ < 6) {
      console.log(`     ${k.padEnd(34)} ${list.length} platform(s)  ${f(lat, 5)},${f(lon, 5)}  ->  (${f(x, 1)}, ${f(y, 1)}) px  ${vis ? "on screen" : "culled"}`);
    }
  }
  console.log(`  ${onScreen} of ${groups.size} boarding points inside the phone viewport at z15`);
  ok(onScreen > 0 && onScreen <= groups.size, "marker culling keeps a sane subset");
}

console.log();

// ------------------------------------------------------------------------
// The DOM stub
// ------------------------------------------------------------------------

/* A DOM small enough to fit in one file and real enough to run web/app/map.js.
   No jsdom, because there is no npm in this repo and never will be. */

/* The DOM stub used to be inlined here. It now lives in scripts/domstub.mjs,
   because scripts/test_integration.mjs boots the whole shell against the same
   DOM and two copies would have become two different opinions about what a
   DOM is. installDom() is byte-for-byte the function that was here; the
   integration test layers shellDom() on top of it. */


// ------------------------------------------------------------------------
// PART B: THE ENGINE
// ------------------------------------------------------------------------

const dom = installDom({ w: 390, h: 844 });
const { createMap, stopsToMarkers, LAYERS } = await import("../web/app/map.js");


line("B1. MOUNT");
const container = dom.makeContainer();
const map = createMap(container, { centre: { lat: 50.84673, lon: 4.35247 }, zoom: 15 });
dom.flush();

const mapEl = container.querySelector("#map");
ok(!!mapEl, "#map created inside the container");
ok(mapEl.getAttribute("aria-hidden") === "true", "#map is aria-hidden by default");
ok(mapEl.getAttribute("tabindex") === null, "#map has no tabindex, so it cannot be entered or trapped");
for (const cls of ["map-tiles", "map-veil", "map-vectors", "map-markers", "map-position"]) {
  ok(!!mapEl.querySelector("." + cls), "layer present: ." + cls);
}
const order = mapEl.childNodes.map((c) => c.className);
console.log("  child order, bottom to top: " + JSON.stringify(order));
ok(order.join("|") === "map-tiles|map-veil|map-vectors|map-markers|map-position",
   "stacking order matches UI_SPEC 1.1");
const svgEl = mapEl.querySelector(".map-vectors");
const svgOrder = svgEl.childNodes.map((c) => c.getAttribute("class"));
console.log("  svg child order: " + JSON.stringify(svgOrder));
ok(svgOrder[0] === "map-cell" && svgOrder[1] === "map-sectors" && svgOrder[2] === "map-accuracy",
   "cell first child, sectors after it, accuracy last child");

line("B2. ATTRIBUTION IS AN ODbL LICENCE TERM");
const attrib = container.querySelector(".map-attrib");
ok(!!attrib, "p.map-attrib exists");
ok(attrib.parentNode === container && attrib.parentNode !== mapEl,
   "it is a SIBLING of #map, not a child, so the link stays focusable and announced");
const a = attrib.querySelector("a");
console.log(`  <a href="${a.getAttribute("href")}" rel="${a.getAttribute("rel")}">${a.textContent}</a>`);
ok(a.textContent === "© OpenStreetMap contributors", "the exact required string");
ok(a.getAttribute("href") === "https://www.openstreetmap.org/copyright", "links to the copyright page");
ok(a.getAttribute("rel") === "noopener noreferrer", "rel is noopener noreferrer");
ok(attrib.hidden === false, "visible while tiles are live");

line("B3. TILE REQUESTS: only what the viewport needs, no key, no query string");
const tilesEl = mapEl.querySelector(".map-tiles");
console.log(`  ${dom.requested.length} tiles requested for a 390x844 viewport at z15`);
console.log("  first five:");
for (const u of dom.requested.slice(0, 5)) console.log("     " + u);
ok(dom.requested.length === 8, "exactly the 8 intersecting tiles, no speculative ring", dom.requested.length);
ok(dom.requested.every((u) => u.startsWith("https://tile.openstreetmap.org/")), "one host only");
ok(dom.requested.every((u) => !u.includes("?")), "no query string on any tile URL");
ok(!dom.requested.some((u) => /key=|token|apikey|auth/i.test(u)), "no credential anywhere (acceptance test 7)");
const img0 = tilesEl.childNodes[0];
console.log(`  tile element: fetchpriority=${img0.getAttribute("fetchpriority")} alt="${img0.alt}" decoding=${img0.decoding}`);
ok(img0.getAttribute("fetchpriority") === "low", "a tile never competes with a grid shard");
ok(img0.alt === "", "empty alt keeps tiles out of the accessibility tree");

line("B4. VECTOR LAYERS FROM REAL BAKED DATA");
const sectorFC = read("web/data/21004/sector.geojson");
const shard = decodeShard(read("web/data/grid/1kmN3097E3924.json"));

map.setPosition({ lat: 50.84673, lon: 4.35247, accuracy: 12, at: Date.now() });
map.setCell("1kmN3097E3924");
map.setSectors(sectorFC, "21004A001");
const markers = stopsToMarkers(shard.stops);
map.setMarkers(markers);
dom.flush();

const cellPath = svgEl.querySelector(".map-cell");
const d = cellPath.getAttribute("d");
console.log("  map-cell d = " + d);
ok(/^M[\d.]+ [\d.]+ (L[\d.-]+ [\d.-]+ ){3}Z$/.test(d.replace(/-/g, "")) || d.split("L").length === 4,
   "the cell is a closed 4-corner path", d.split("L").length - 1 + " L segments");
ok(cellPath.getAttribute("visibility") === "visible", "cell visible");

const sectorNodes = svgEl.querySelector(".map-sectors").childNodes;
const current = sectorNodes.filter((n) => n.getAttribute("data-current") === "true");
console.log(`  sectors rendered: ${sectorNodes.length} of ${sectorFC.features.length} (bbox culled)`);
console.log(`  current sector marked: ${current.length} node, code ${current.map((n) => n.getAttribute("data-sector")).join()}`);
ok(sectorNodes.length > 0 && sectorNodes.length < sectorFC.features.length, "culling works and something is drawn");
ok(current.length === 1 && current[0].getAttribute("data-sector") === "21004A001",
   "exactly one sector carries data-current");
ok(sectorNodes[sectorNodes.length - 1].getAttribute("data-current") === "true",
   "the current sector draws LAST, so its 3px stroke is never overpainted");
const anyD = sectorNodes[0].getAttribute("d");
console.log("  first sector path starts: " + anyD.slice(0, 70) + " ...");
ok(anyD.startsWith("M") && anyD.endsWith("Z"), "sector paths are closed");
ok(!/NaN|Infinity/.test(anyD), "no NaN or Infinity in any path string");

const accEl = svgEl.querySelector(".map-accuracy");
console.log(`  accuracy circle: cx=${accEl.getAttribute("cx")} cy=${accEl.getAttribute("cy")} r=${accEl.getAttribute("r")} (fix accuracy 12 m at ${f(map.metresPerPixel())} m/px)`);
ok(Number(accEl.getAttribute("r")) > 0, "accuracy circle drawn from the REAL reported accuracy");

const posEl = mapEl.querySelector(".map-position");
console.log(`  position dot at left=${posEl.style.getPropertyValue ? posEl.style._p.get("left") || posEl.style.left : ""} top=${posEl.style.top}  hidden=${posEl.hidden}`);
ok(posEl.hidden === false, "position dot shown");
ok(posEl.style.left === "195.0px" || Math.abs(parseFloat(posEl.style.left) - 195) < 1,
   "dot sits on the horizontal centre of a 390px viewport", posEl.style.left);
ok(Math.abs(parseFloat(posEl.style.top) - 844 / 2) < 1,
   "and on the vertical centre while the dock is 0", posEl.style.top);

const markerEls = mapEl.querySelector(".map-markers").childNodes;
const labelled = markerEls.filter((n) => n.getAttribute("data-labelled") === "true");
console.log(`  ${markers.length} boarding points from ${shard.stops.length} baked stops -> ${markerEls.length} in the DOM, ${labelled.length} labelled`);
ok(markerEls.length > 0 && markerEls.length <= markers.length, "markers culled to the viewport");
ok(labelled.length === Math.min(8, markerEls.length),
   "the 8 nearest DRAWN markers carry a label", `${labelled.length} of ${markerEls.length} drawn`);
ok(markerEls.every((n) => n.getAttribute("role") === "presentation"),
   "every marker is role=presentation, never a button: no new tab stops");
console.log("  nearest three: " + markerEls.slice(0, 3).map((n) => `"${n.lastChild.textContent}"`).join(", "));

line("B5. THE OPTICAL CENTRE LIFTS WHEN A BAND OPENS");
const beforeTop = parseFloat(posEl.style.top);
map.setDockHeight(360, false);   // snap, no tween
dom.flush();
const afterTop = parseFloat(posEl.style.top);
console.log(`  dock 0 -> 360 px: dot y ${f(beforeTop, 1)} -> ${f(afterTop, 1)} px  (lifted ${f(beforeTop - afterTop, 1)})`);
ok(Math.abs((beforeTop - afterTop) - 180) < 1, "the dot lifts by exactly half the dock height");
ok(container.style._p.get("--dock-height") === "360px",
   "--dock-height is published on the container, which is what .map-attrib reads");
map.setDockHeight(0, false);
dom.flush();

line("B6. OFFLINE: TILE FAILURE DEGRADES TO THE VECTOR MAP");
const beforeCell = svgEl.querySelector(".map-cell").getAttribute("d");
const beforeSectors = svgEl.querySelector(".map-sectors").childNodes.length;
const beforeMarkers = mapEl.querySelector(".map-markers").childNodes.length;
const tileEls = tilesEl.childNodes.slice();
console.log(`  before: ${tileEls.length} tile elements, state "${map.getTileState()}"`);
let tileEvents = [];
map.on("tiles", (e) => tileEvents.push(e.state));
for (let i = 0; i < 3; i++) tileEls[i].dispatch("error", { noBubble: true });
dom.flush();
console.log(`  after 3 tile errors: ${tilesEl.childNodes.length} tile elements, state "${map.getTileState()}", events ${JSON.stringify(tileEvents)}`);
ok(map.getTileState() === "failed", "three failures in one viewport stand the layer down");
ok(tilesEl.childNodes.length === tileEls.length - 3,
   "only the three failed elements are removed: ground colour, never a broken-image glyph",
   `${tileEls.length} -> ${tilesEl.childNodes.length}`);
ok(tileEls.slice(0, 3).every((t) => t.getAttribute("src") === null || t.src === ""),
   "no failed <img> keeps a src, so no broken-image glyph can be painted");
ok(tileEvents.includes("failed"), "the host is told, so it can paint the tile note");

const requestedBefore = dom.requested.length;
map.panBy(300, 200);   // a pan that would normally pull in a fresh row
dom.flush();
console.log(`  panned 300x200 px while failed: tile requests ${requestedBefore} -> ${dom.requested.length}`);
ok(dom.requested.length === requestedBefore, "NOTHING is requested during the 60 s cooldown");
const survivor = tilesEl.childNodes[0];
console.log(`  a tile that DID load keeps panning: transform ${survivor ? survivor.style.transform : "(none)"}`);
ok(!!survivor, "successfully loaded tiles are not thrown away, so the attribution stays honest");
// And nothing retries on a timer: a phone left alone in airplane mode must be silent.
await new Promise((r) => setTimeout(r, 250));
const idleFrames = dom.pendingFrames();
dom.flush();
console.log(`  250 ms of doing nothing: ${dom.requested.length - requestedBefore} new requests, ${idleFrames} frames scheduled`);
ok(dom.requested.length === requestedBefore && idleFrames === 0,
   "the 60 s cooldown does NOT self-retry: no background loop, no polling");

console.log(`  cell path unchanged? ${svgEl.querySelector(".map-cell").getAttribute("d") !== ""}`);
ok(svgEl.querySelector(".map-cell").getAttribute("d") !== "", "the 1 km cell still draws with no tiles");
ok(svgEl.querySelector(".map-sectors").childNodes.length > 0, "sectors still draw with no tiles");
ok(mapEl.querySelector(".map-markers").childNodes.length > 0, "markers still draw with no tiles");
ok(mapEl.querySelector(".map-position").hidden === false, "the position dot still draws with no tiles");
console.log("  -> airplane mode still answers where-am-I from baked shards alone");
ok(attrib.hidden === true, "attribution hides only once nothing raster is painted at all");

line("B7. SAVE-DATA MEANS NO TILE IS REQUESTED AT ALL");
{
  const dom2 = installDom({ w: 390, h: 844, saveData: true });
  const mod = await import("../web/app/map.js?v=2");
  const c2 = dom2.makeContainer();
  const m2 = mod.createMap(c2, { centre: { lat: 51.0543, lon: 3.7251 }, zoom: 15 });
  dom2.flush();
  m2.setSectors(read("web/data/44021/sector.geojson"), null);
  m2.setPosition({ lat: 51.0543, lon: 3.7251, accuracy: 30 });
  dom2.flush();
  console.log(`  navigator.connection.saveData = true -> ${dom2.requested.length} tile requests, state "${m2.getTileState()}"`);
  ok(dom2.requested.length === 0, "no tile is requested under save-data");
  ok(m2.getTileState() === "off", 'state is "off", which is a real state and not a failure');
  const sc = c2.querySelector("#map").querySelector(".map-sectors").childNodes.length;
  console.log(`  and Ghent still draws ${sc} sector polygons on the token ground colour`);
  ok(sc > 0, "the vector map is complete without any raster");
  m2.destroy();
  dom2.restore();
}

line("B8. ZOOM DEBOUNCE: a fast '- - -' costs ONE round of tiles, not four");
{
  const dom3 = installDom({ w: 390, h: 844 });
  const mod = await import("../web/app/map.js?v=3");
  const c3 = dom3.makeContainer();
  const m3 = mod.createMap(c3, { centre: { lat: 50.84673, lon: 4.35247 }, zoom: 17 });
  dom3.flush();
  const base = dom3.requested.length;
  m3.zoomBy(-1); m3.zoomBy(-1); m3.zoomBy(-1);   // 17 -> 14, as fast as a finger
  dom3.flush();
  console.log(`  z17 mount = ${base} tiles; then three immediate zoom-outs -> ${dom3.requested.length - base} further requests`);
  ok(dom3.requested.length === base, "no intermediate zoom level is ever fetched");
  ok(m3.getZoom() === 14, "the zoom itself changed immediately", m3.getZoom());
  await new Promise((r) => setTimeout(r, 160));
  dom3.flush();
  const after = dom3.requested.length - base;
  const zs = new Set(dom3.requested.slice(base).map((u) => u.split("/")[3]));
  console.log(`  after the 120 ms settle: ${after} requests, at zoom level(s) ${JSON.stringify([...zs])}`);
  ok(zs.size === 1 && [...zs][0] === "14", "one settle, one zoom level, no scraping loop");
  ok(m3.getZoom() === 14 && m3.getZoom() >= 11, "clamped inside [11, 17]");
  m3.zoomBy(-9); ok(m3.getZoom() === 11, "clamps at MIN_ZOOM", m3.getZoom());
  m3.zoomBy(+9); ok(m3.getZoom() === 17, "clamps at MAX_ZOOM", m3.getZoom());
  m3.destroy();
  dom3.restore();
}

line("B9. NO ANIMATION LOOP WHEN NOTHING MOVES, AND NO POLLING");
{
  const dom4 = installDom({ w: 390, h: 844 });
  const mod = await import("../web/app/map.js?v=4");
  const c4 = dom4.makeContainer();
  const m4 = mod.createMap(c4, { centre: { lat: 50.8, lon: 4.3 }, zoom: 15 });
  const n1 = dom4.flush();
  console.log(`  frames consumed by mount: ${n1}`);
  console.log(`  frames pending while idle: ${dom4.pendingFrames()}`);
  ok(dom4.pendingFrames() === 0, "a stationary map has ZERO outstanding animation frames");
  m4.panBy(10, 0);
  ok(dom4.pendingFrames() === 1, "one pan schedules exactly one frame", dom4.pendingFrames());
  m4.panBy(10, 0); m4.panBy(10, 0); m4.panBy(10, 0);
  ok(dom4.pendingFrames() === 1, "four pans in one tick still coalesce to one frame", dom4.pendingFrames());
  dom4.flush();
  ok(dom4.pendingFrames() === 0, "and it goes quiet again");
  m4.destroy();
  ok(dom4.pendingFrames() === 0, "destroy() leaves no frame behind");
  dom4.restore();
}

line("B10. SELECTION IS BIDIRECTIONAL, AND PANS BUT NEVER ZOOMS");
{
  const events = [];
  map.on("select", (e) => events.push(e));
  const far = markers.slice().sort((x, y) => y.lat - x.lat)[0];   // a marker off-screen
  const zoomBefore = map.getZoom();
  const centreBefore = map.getCentre();
  map.select(far.key);
  dom.flush();
  const allNodes = mapEl.querySelector(".map-markers").childNodes;
  const node = allNodes.find((n) => n.dataset.key === far.key);
  console.log(`  selected ${far.key} "${far.label}"`);
  console.log(`  event: ${JSON.stringify(events.map((e) => ({ key: e.key, source: e.source })))}`);
  ok(events.length === 1 && events[0].key === far.key && events[0].source === "api",
     "one select event, carrying the key and its source");
  ok(map.getSelected() === far.key, "getSelected() agrees");
  ok(!!node && node.getAttribute("data-selected") === "true",
     "the marker is in the DOM and carries data-selected");
  ok(node.getAttribute("data-labelled") === "true", "a selected marker always carries its label");
  ok(map.getZoom() === zoomBefore, "selection NEVER changes zoom");
  const moved = Math.abs(map.getCentre().lat - centreBefore.lat) + Math.abs(map.getCentre().lon - centreBefore.lon);
  console.log(`  centre moved by ${moved.toExponential(2)} deg to bring it into the visible rect`);
  ok(moved > 0, "it panned to bring an off-screen selection into view");

  // Marker tap -> select, with source "map", driven from the pointer sequence
  // so that setPointerCapture on the map root cannot swallow it.
  events.length = 0;
  const first = mapEl.querySelector(".map-markers").childNodes[0];
  first.dispatch("pointerdown", { pointerId: 1, clientX: 100, clientY: 100, pointerType: "touch" });
  mapEl.dispatch("pointerup", { pointerId: 1, clientX: 101, clientY: 100, noBubble: true });
  dom.flush();
  console.log(`  tap on "${first.lastChild.textContent}" -> ${JSON.stringify(events.map((e) => ({ key: e.key, source: e.source })))}`);
  ok(events.length === 1 && events[0].source === "map",
     'a marker tap emits select with source "map", which the Go band mirrors');
  // And a DRAG that starts on a marker must not select it.
  events.length = 0;
  const second = mapEl.querySelector(".map-markers").childNodes[1];
  second.dispatch("pointerdown", { pointerId: 2, clientX: 100, clientY: 100, pointerType: "touch" });
  mapEl.dispatch("pointermove", { pointerId: 2, clientX: 180, clientY: 140, noBubble: true });
  mapEl.dispatch("pointerup", { pointerId: 2, clientX: 180, clientY: 140, noBubble: true });
  dom.flush();
  console.log(`  drag starting on a marker -> ${events.length} select event(s)`);
  ok(events.length === 0, "a drag that begins on a marker pans the map and selects nothing");
}

line("B11. LAYER CHIPS TOGGLE REAL LAYERS");
console.log("  LAYERS = " + JSON.stringify(LAYERS));
map.setLayer("cell", false);
map.setLayer("sector", false);
map.setLayer("stops", false);
dom.flush();
ok(svgEl.querySelector(".map-cell").getAttribute("visibility") === "hidden", "cell off");
ok(svgEl.querySelector(".map-sectors").childNodes.length === 0, "sectors off");
ok(mapEl.querySelector(".map-markers").childNodes.length === 0, "stops off");
ok(mapEl.querySelector(".map-position").hidden === false,
   "the position dot is NOT a toggleable layer: it never disappears");
map.setLayer("cell", true); map.setLayer("sector", true); map.setLayer("stops", true);
dom.flush();
ok(svgEl.querySelector(".map-sectors").childNodes.length > 0, "and back on again");

line("B12. KEYBOARD MODE IS OPT-IN AND IS NOT A TRAP");
{
  const dom5 = installDom({ w: 390, h: 844 });
  const mod = await import("../web/app/map.js?v=5");
  const c5 = dom5.makeContainer();
  const m5 = mod.createMap(c5, { centre: { lat: 50.8, lon: 4.3 }, zoom: 15, keyboard: true });
  dom5.flush();
  const e5 = c5.querySelector("#map");
  console.log(`  keyboard:true -> tabindex=${e5.getAttribute("tabindex")} aria-hidden=${e5.getAttribute("aria-hidden")} role=${e5.getAttribute("role")} aria-label="${e5.getAttribute("aria-label")}"`);
  ok(e5.getAttribute("tabindex") === "0", "one tab stop");
  ok(e5.getAttribute("aria-hidden") === null,
     "aria-hidden is REMOVED: a focusable node inside an aria-hidden subtree is an error");
  const c0 = m5.getCentre();
  let prevented = 0;
  e5.dispatch("keydown", { key: "ArrowRight", preventDefault() { prevented++; } });
  dom5.flush();
  const c1 = m5.getCentre();
  console.log(`  ArrowRight: lon ${f(c0.lon, 6)} -> ${f(c1.lon, 6)} (+${((c1.lon - c0.lon) * 111320 * Math.cos(50.8 * Math.PI / 180)).toFixed(0)} m east)`);
  ok(c1.lon > c0.lon, "ArrowRight pans east");
  e5.dispatch("keydown", { key: "ArrowUp", preventDefault() {} });
  dom5.flush();
  ok(m5.getCentre().lat > c1.lat, "ArrowUp pans north");
  const z0 = m5.getZoom();
  e5.dispatch("keydown", { key: "+", preventDefault() {} });
  ok(m5.getZoom() === z0 + 1, "'+' zooms in");
  e5.dispatch("keydown", { key: "-", preventDefault() {} });
  ok(m5.getZoom() === z0, "'-' zooms out");
  let tabPrevented = false;
  e5.dispatch("keydown", { key: "Tab", preventDefault() { tabPrevented = true; } });
  ok(tabPrevented === false, "Tab is NEVER preventDefault()ed, so focus can always leave: not a trap");
  let escPrevented = false;
  e5.dispatch("keydown", { key: "Escape", preventDefault() { escPrevented = true; } });
  ok(escPrevented === false, "Escape passes through to the shell too");
  m5.destroy();
  dom5.restore();
}

line("B13. RECENTRE AND THE OFF-CENTRE TEST");
map.setPosition({ lat: 50.84673, lon: 4.35247, accuracy: 12 });
map.setCentre(50.84673, 4.35247);
ok(map.isOffCentre() === false, "centred on the fix");
map.panBy(0, 400);
console.log(`  after a 400 px drag: centre ${f(map.getCentre().lat, 6)}, ${f(map.getCentre().lon, 6)}; offCentre = ${map.isOffCentre()}`);
ok(map.isOffCentre() === true, "the prototype's |dLat| > 0.0008 test fires");
map.recentre();
ok(map.isOffCentre() === false, "recentre() puts it back");
ok(Math.abs(map.getCentre().lat - 50.84673) < 1e-12, "exactly back on the fix");

line("B14. TEARDOWN");
const pending = dom.pendingFrames();
map.destroy();
ok(dom.pendingFrames() === 0, "destroy() cancels every outstanding frame", `${pending} -> ${dom.pendingFrames()}`);


console.log();
console.log("=".repeat(74));
console.log(fails === 0 ? "ALL MAP CHECKS PASS" : fails + " MAP CHECK(S) FAILED");
console.log("=".repeat(74));
process.exit(fails ? 1 : 0);
