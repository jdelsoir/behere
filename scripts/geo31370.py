"""EPSG:31370 (Belgian Lambert 72) <-> WGS84, plus a Douglas-Peucker simplifier.

Pure Python standard library. No numpy, no pyproj, no shapely.

Why this file exists
--------------------
Every Belgian WFS/WMS layer, the Statbel statistical sector geometry and the
`XY_X_LB72` / `XY_Y_LB72` columns of the Statbel address file are in EPSG:31370.
The browser needs WGS84. There is no runtime reprojection library available to a
static PWA, so the reprojection happens once, at bake time, here.

The transformation is a two-step chain, both steps closed form:

  1. Lambert Conformal Conic 2SP inverse (EPSG method 9802) from easting/northing
     to geographic coordinates on the International 1924 (Hayford) ellipsoid,
     i.e. datum Belge 1972.
  2. A seven-parameter Helmert similarity transformation from Belge 1972 to
     WGS84, applied in geocentric Cartesian space (EPSG method 9606,
     "Position Vector"), with the parameters of the canonical PROJ definition of
     EPSG:31370. Read the comment above `_HX` before touching those constants:
     the rotation signs are a 65 m trap.

Step 1 uses Snyder's series for the inverse conformal latitude rather than the
usual fixed-point iteration, so the whole chain is genuinely closed form: a
fixed number of arithmetic operations, no convergence loop, byte-identical
output for identical input.

Measured accuracy against 2,245 addresses sampled nationwide from
TF_RGN_ADDRESSES_STAT_SECTORS_20250401 (rows carrying both the LB72 and the
WGS84 columns): see `scripts/geo31370_validate.py`.

Sources for the constants
-------------------------
EPSG:31370 projection and datum-shift parameters : the canonical PROJ
    definition of EPSG:31370, cross-checked against the EPSG Geodetic Parameter
    Dataset and then verified numerically against Statbel ground truth.
Snyder, J.P. (1987), "Map Projections -- A Working Manual",
    USGS Professional Paper 1395: eq. 3-5 (inverse conformal latitude series),
    eq. 14-15 / 15-1..15-9 (Lambert Conformal Conic).
"""

import math

__all__ = [
    "lb72_to_wgs84",
    "wgs84_to_lb72",
    "douglas_peucker",
    "simplify_ring_lonlat",
]

# --- Ellipsoid: International 1924 (Hayford), the ellipsoid of Belge 1972 ----
_A_INTL = 6378388.0
_F_INTL = 1.0 / 297.0
_B_INTL = _A_INTL * (1.0 - _F_INTL)
_E2_INTL = 2.0 * _F_INTL - _F_INTL * _F_INTL
_E_INTL = math.sqrt(_E2_INTL)

# --- Ellipsoid: WGS84 -------------------------------------------------------
_A_WGS = 6378137.0
_F_WGS = 1.0 / 298.257223563
_B_WGS = _A_WGS * (1.0 - _F_WGS)
_E2_WGS = 2.0 * _F_WGS - _F_WGS * _F_WGS

# --- EPSG:31370 Lambert Conformal Conic 2SP defining parameters -------------
# Standard parallels are 51 deg 10' 00.00204" N and 49 deg 50' 00.00204" N.
# They are NOT the round values 51 deg 10' and 49 deg 50'; the extra 0.00204"
# is part of the official definition and is worth about 6 cm on the ground.
_LAT_1 = math.radians(51.16666723333333)
_LAT_2 = math.radians(49.83333390000000)
_LAT_F = math.radians(90.0)                    # latitude of false origin
_LON_F = math.radians(4.367486666666666)       # 4 deg 22' 02.952" E
_E_F = 150000.013                              # easting at false origin
_N_F = 5400088.438                             # northing at false origin


def _t(lat, e):
    """Snyder eq. 15-9: the isometric-latitude auxiliary t."""
    s = e * math.sin(lat)
    return math.tan(math.pi / 4.0 - lat / 2.0) / math.pow(
        (1.0 - s) / (1.0 + s), e / 2.0
    )


def _m(lat, e):
    """Snyder eq. 14-15: the parallel-radius auxiliary m."""
    s = math.sin(lat)
    return math.cos(lat) / math.sqrt(1.0 - e * e * s * s)


# Cone constant n and projection constant F, precomputed once.
_M1 = _m(_LAT_1, _E_INTL)
_M2 = _m(_LAT_2, _E_INTL)
_T1 = _t(_LAT_1, _E_INTL)
_T2 = _t(_LAT_2, _E_INTL)
_N = (math.log(_M1) - math.log(_M2)) / (math.log(_T1) - math.log(_T2))
_BIGF = _M1 / (_N * math.pow(_T1, _N))
_AF = _A_INTL * _BIGF
# Latitude of false origin is exactly 90 deg, so t_F is 0 and therefore r_F is 0.
_R_F = 0.0 if abs(_LAT_F - math.pi / 2.0) < 1e-12 else _AF * math.pow(
    _t(_LAT_F, _E_INTL), _N
)

# --- Snyder eq. 3-5, inverse of the conformal latitude, series in e^2 -------
# Truncated at e^8; for the International 1924 ellipsoid the neglected e^10 term
# is below 1e-11 rad, i.e. under 0.1 mm.
_C2 = (_E2_INTL / 2.0 + 5.0 * _E2_INTL ** 2 / 24.0
       + _E2_INTL ** 3 / 12.0 + 13.0 * _E2_INTL ** 4 / 360.0)
_C4 = (7.0 * _E2_INTL ** 2 / 48.0 + 29.0 * _E2_INTL ** 3 / 240.0
       + 811.0 * _E2_INTL ** 4 / 11520.0)
_C6 = 7.0 * _E2_INTL ** 3 / 120.0 + 81.0 * _E2_INTL ** 4 / 1120.0
_C8 = 4279.0 * _E2_INTL ** 4 / 161280.0

# --- Belge 1972 -> WGS84, seven-parameter Helmert ---------------------------
# Translations in metres, rotations in arc-seconds, scale in parts per million.
# These are the values in the canonical PROJ definition of EPSG:31370:
#   +towgs84=-106.868628,52.297783,-103.723893,0.336570,-0.456955,1.842183,-1.2747
# and they are applied below through the Position Vector matrix (EPSG method
# 9606). Note the two sign traps, both of which are worth tens of metres:
#
#   * The rotation signs are the opposite of the way EPSG publishes
#     transformation 1609 "BD72 to WGS 84 (3)". Feeding EPSG's published signs
#     into the Position Vector matrix puts every Belgian point about 65 m out,
#     because a 1.842" rotation about the polar axis is roughly 57 m at this
#     latitude. Position Vector and Coordinate Frame differ by exactly this
#     sign flip, and the two are trivially easy to swap by accident.
#   * The scale is NEGATIVE 1.2747 ppm. Flipping it alone costs about 5 cm,
#     small enough to survive a casual eyeball check and still be wrong.
#
# The combination below was not taken on trust. It was chosen by running all
# four sign combinations against 2,245 addresses sampled nationwide from the
# Statbel address-to-sector file, each of which carries the same point in both
# EPSG:31370 and WGS84. This combination reproduces Statbel's own WGS84 columns
# to a maximum of 1.8 mm; the next best is 30x worse and the other two are
# 37,000x worse. See scripts/geo31370_validate.py.
_HX = -106.868628
_HY = 52.297783
_HZ = -103.723893
_ARCSEC = math.pi / 180.0 / 3600.0
_RX = 0.336570 * _ARCSEC
_RY = -0.456955 * _ARCSEC
_RZ = 1.842183 * _ARCSEC
_DS = 1.0 - 1.2747e-6


def _geodetic_to_geocentric(lat, lon, h, a, e2):
    sin_lat = math.sin(lat)
    cos_lat = math.cos(lat)
    nu = a / math.sqrt(1.0 - e2 * sin_lat * sin_lat)
    x = (nu + h) * cos_lat * math.cos(lon)
    y = (nu + h) * cos_lat * math.sin(lon)
    z = (nu * (1.0 - e2) + h) * sin_lat
    return x, y, z


def _geocentric_to_geodetic(x, y, z, a, b, e2):
    """Bowring's closed-form inverse. Sub-millimetre for terrestrial heights."""
    ep2 = (a * a - b * b) / (b * b)
    p = math.hypot(x, y)
    if p == 0.0:
        return (math.copysign(math.pi / 2.0, z), 0.0, abs(z) - b)
    theta = math.atan2(z * a, p * b)
    sin_t = math.sin(theta)
    cos_t = math.cos(theta)
    lat = math.atan2(z + ep2 * b * sin_t ** 3, p - e2 * a * cos_t ** 3)
    lon = math.atan2(y, x)
    sin_lat = math.sin(lat)
    nu = a / math.sqrt(1.0 - e2 * sin_lat * sin_lat)
    h = p / math.cos(lat) - nu
    return lat, lon, h


def _helmert_pv(x, y, z, tx, ty, tz, rx, ry, rz, s):
    """Position Vector 7-parameter similarity transformation (EPSG 9606)."""
    return (
        tx + s * (x - rz * y + ry * z),
        ty + s * (rz * x + y - rx * z),
        tz + s * (-ry * x + rx * y + z),
    )


def lb72_to_wgs84(x, y):
    """EPSG:31370 easting/northing in metres -> (lon, lat) in degrees, WGS84.

    Returns lon first, matching GeoJSON coordinate order.
    """
    dx = x - _E_F
    dy = _R_F - (y - _N_F)
    # sign(n) * hypot, per EPSG guidance note 7-2. n is positive for Belgium.
    r = math.copysign(math.hypot(dx, dy), _N)
    theta = math.atan2(dx, dy) if _N > 0 else math.atan2(-dx, -dy)
    t = math.pow(r / _AF, 1.0 / _N)
    chi = math.pi / 2.0 - 2.0 * math.atan(t)
    lat = (chi
           + _C2 * math.sin(2.0 * chi)
           + _C4 * math.sin(4.0 * chi)
           + _C6 * math.sin(6.0 * chi)
           + _C8 * math.sin(8.0 * chi))
    lon = theta / _N + _LON_F

    gx, gy, gz = _geodetic_to_geocentric(lat, lon, 0.0, _A_INTL, _E2_INTL)
    gx, gy, gz = _helmert_pv(gx, gy, gz, _HX, _HY, _HZ, _RX, _RY, _RZ, _DS)
    lat, lon, _h = _geocentric_to_geodetic(gx, gy, gz, _A_WGS, _B_WGS, _E2_WGS)
    return math.degrees(lon), math.degrees(lat)


def wgs84_to_lb72(lon, lat):
    """(lon, lat) in degrees WGS84 -> EPSG:31370 easting/northing in metres."""
    la = math.radians(lat)
    lo = math.radians(lon)
    gx, gy, gz = _geodetic_to_geocentric(la, lo, 0.0, _A_WGS, _E2_WGS)
    # Inverse Helmert: negate translations/rotations and invert the scale.
    inv_s = 1.0 / _DS
    gx, gy, gz = (gx - _HX, gy - _HY, gz - _HZ)
    gx, gy, gz = _helmert_pv(
        gx, gy, gz, 0.0, 0.0, 0.0, -_RX, -_RY, -_RZ, inv_s
    )
    la, lo, _h = _geocentric_to_geodetic(gx, gy, gz, _A_INTL, _B_INTL, _E2_INTL)

    t = _t(la, _E_INTL)
    r = _AF * math.pow(t, _N)
    theta = _N * (lo - _LON_F)
    return _E_F + r * math.sin(theta), _N_F + _R_F - r * math.cos(theta)


# --------------------------------------------------------------------------
# Douglas-Peucker
# --------------------------------------------------------------------------

def _seg_dist_sq(px, py, ax, ay, bx, by):
    """Squared perpendicular distance from P to segment AB, same units in, out."""
    vx = bx - ax
    vy = by - ay
    len_sq = vx * vx + vy * vy
    if len_sq == 0.0:
        dx = px - ax
        dy = py - ay
        return dx * dx + dy * dy
    tpar = ((px - ax) * vx + (py - ay) * vy) / len_sq
    if tpar < 0.0:
        tpar = 0.0
    elif tpar > 1.0:
        tpar = 1.0
    dx = px - (ax + tpar * vx)
    dy = py - (ay + tpar * vy)
    return dx * dx + dy * dy


def douglas_peucker_indices(points, tolerance):
    """Indices of the vertices Ramer-Douglas-Peucker keeps, in ascending order.

    `points` is a sequence of (x, y) pairs. `tolerance` is in the same units as
    the coordinates. The first and last indices are always kept.

    Iterative, so a 200,000-vertex coastline ring cannot blow the recursion
    limit. Deterministic: the same input always yields the same output, which is
    what makes the bake reproducible.
    """
    n = len(points)
    if n < 3 or tolerance <= 0.0:
        return list(range(n))
    tol_sq = tolerance * tolerance
    keep = [False] * n
    keep[0] = True
    keep[n - 1] = True
    stack = [(0, n - 1)]
    while stack:
        first, last = stack.pop()
        if last <= first + 1:
            continue
        ax, ay = points[first]
        bx, by = points[last]
        max_d = -1.0
        idx = -1
        for i in range(first + 1, last):
            px, py = points[i]
            d = _seg_dist_sq(px, py, ax, ay, bx, by)
            if d > max_d:
                max_d = d
                idx = i
        if max_d > tol_sq:
            keep[idx] = True
            stack.append((first, idx))
            stack.append((idx, last))
    return [i for i in range(n) if keep[i]]


def douglas_peucker(points, tolerance):
    """Ramer-Douglas-Peucker simplification of a 2D polyline.

    Returns the kept (x, y) pairs. See `douglas_peucker_indices`.
    """
    return [points[i] for i in douglas_peucker_indices(points, tolerance)]


# One degree of latitude, in metres, on the WGS84 ellipsoid at 50.6 N, the
# latitudinal centre of Belgium. Belgium spans 49.5 N to 51.5 N, over which this
# varies by under 0.1%, so a constant is honest here.
_M_PER_DEG_LAT = 111256.0


def simplify_ring_lonlat(ring, tolerance_m, min_points=4):
    """Simplify a closed lon/lat ring with the tolerance expressed in metres.

    Longitude is scaled by cos(latitude) before simplification so the tolerance
    means the same thing in both axes. The ring stays closed: the returned list
    begins and ends with the same coordinate.

    If simplification would leave fewer than `min_points` vertices the ring is
    returned with its most significant vertices only, never fewer than 4, so a
    tiny sector never degenerates into an unclosable sliver. If the input ring
    is itself shorter than `min_points`, it is returned unchanged.
    """
    if len(ring) < min_points:
        return list(ring)
    closed = ring[0] == ring[-1]
    work = ring[:-1] if closed else list(ring)
    if not work:
        return list(ring)
    lat_mean = sum(p[1] for p in work) / len(work)
    kx = math.cos(math.radians(lat_mean))
    if kx <= 0.0:
        kx = 1.0
    scaled = [(p[0] * kx, p[1]) for p in work]

    # Back off the tolerance until at least `min_points` vertices survive, so a
    # small sector degrades into a coarse quadrilateral rather than vanishing.
    tol = tolerance_m / _M_PER_DEG_LAT
    kept = douglas_peucker_indices(scaled, tol)
    for _ in range(24):
        if len(kept) >= min_points or tol <= 0.0:
            break
        tol /= 2.0
        kept = douglas_peucker_indices(scaled, tol)

    out = [work[i] for i in kept]
    if len(out) < min_points:
        out = list(work)
    if closed:
        out = out + [out[0]]
    return out
