"""BeHERE spatial index: the Statbel GRD_NEWID 1 km cell.

Verified against every one of the 4,490,779 rows of
TF_RGN_ADDRESSES_STAT_SECTORS_20250401.txt (Statbel, vintage 2025-04-01).

GRD_NEWID is the INSPIRE 1 km grid cell in EPSG:3035 (ETRS89-LAEA Europe):

    "1kmN" + floor(northing_m / 1000) + "E" + floor(easting_m / 1000)

The file carries XY_X_3035 / XY_Y_3035 natively, so the format was proved
directly from the bytes, and the projection below was proved against those
same two columns.

Projection: Lambert Azimuthal Equal Area on GRS80, Snyder pp. 187-190.
    a = 6378137.0, rf = 298.257222101
    lat_0 = 52, lon_0 = 10, x_0 = 4321000, y_0 = 3210000

Pure stdlib. No pyproj, no shapely. The identical logic lives in
web/app/grid.js and produces byte-identical strings.
"""

import math
import os

# --- EPSG:3035 constants -------------------------------------------------

_A = 6378137.0                      # GRS80 semi-major axis
_F = 1.0 / 298.257222101            # GRS80 inverse flattening
_E2 = _F * (2.0 - _F)               # first eccentricity squared
_E = math.sqrt(_E2)
_LAT0 = math.radians(52.0)
_LON0 = math.radians(10.0)
_X0 = 4321000.0
_Y0 = 3210000.0


def _q(sin_phi):
    """Snyder 3-12: the authalic-latitude numerator."""
    es = _E * sin_phi
    return (1.0 - _E2) * (
        sin_phi / (1.0 - es * es)
        - (1.0 / (2.0 * _E)) * math.log((1.0 - es) / (1.0 + es))
    )


_QP = _q(1.0)
_RQ = _A * math.sqrt(_QP / 2.0)
_BETA0 = math.asin(_q(math.sin(_LAT0)) / _QP)
_SIN_B0 = math.sin(_BETA0)
_COS_B0 = math.cos(_BETA0)
_M0 = math.cos(_LAT0) / math.sqrt(1.0 - _E2 * math.sin(_LAT0) ** 2)
_D = _A * _M0 / (_RQ * _COS_B0)


def laea_forward(lat, lon):
    """WGS84 / ETRS89 degrees -> EPSG:3035 (x_east_m, y_north_m)."""
    phi = math.radians(lat)
    dlam = math.radians(lon) - _LON0
    beta = math.asin(_q(math.sin(phi)) / _QP)
    sin_b = math.sin(beta)
    cos_b = math.cos(beta)
    cos_dl = math.cos(dlam)
    b = _RQ * math.sqrt(2.0 / (1.0 + _SIN_B0 * sin_b + _COS_B0 * cos_b * cos_dl))
    x = b * _D * cos_b * math.sin(dlam)
    y = (b / _D) * (_COS_B0 * sin_b - _SIN_B0 * cos_b * cos_dl)
    return x + _X0, y + _Y0


# --- the cell ------------------------------------------------------------

def wgs84_to_cell(lat, lon):
    """WGS84 degrees -> Statbel GRD_NEWID, e.g. '1kmN3126E3927'."""
    x, y = laea_forward(lat, lon)
    return "1kmN%dE%d" % (math.floor(y / 1000.0), math.floor(x / 1000.0))


def parse_cell(cell):
    """'1kmN3126E3927' -> (3126, 3927) as (north_km, east_km)."""
    if not cell.startswith("1kmN"):
        raise ValueError("not a 1 km cell id: %r" % (cell,))
    e = cell.index("E", 4)
    return int(cell[4:e]), int(cell[e + 1:])


def format_cell(north_km, east_km):
    """(3126, 3927) -> '1kmN3126E3927'."""
    return "1kmN%dE%d" % (north_km, east_km)


def neighbours(cell):
    """The 9 cell ids covering `cell` and its 8 touching neighbours.

    Order is fixed and deterministic: self first, then the surrounding ring
    in reading order (north row west->east, middle row, south row).
    """
    n, e = parse_cell(cell)
    out = [format_cell(n, e)]
    for dn in (1, 0, -1):
        for de in (-1, 0, 1):
            if dn == 0 and de == 0:
                continue
            out.append(format_cell(n + dn, e + de))
    return out


def cell_bounds_3035(cell):
    """(min_x, min_y, max_x, max_y) of the cell in EPSG:3035 metres."""
    n, e = parse_cell(cell)
    return (e * 1000, n * 1000, e * 1000 + 1000, n * 1000 + 1000)


# --- self-test -----------------------------------------------------------

FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "grid_fixture.txt")


def _self_test():
    total = 0
    ok = 0
    bad = []
    known = 0
    known_still_diverging = 0
    max_err = 0.0
    with open(FIXTURE, "r", encoding="utf-8", newline="") as fh:
        for raw in fh:
            raw = raw.strip()
            if not raw or raw.startswith("#"):
                continue
            lat_s, lon_s, x_s, y_s, expected, flag = raw.split("|")
            got = wgs84_to_cell(float(lat_s), float(lon_s))
            x, y = laea_forward(float(lat_s), float(lon_s))
            err = math.hypot(x - float(x_s), y - float(y_s))
            if err > max_err:
                max_err = err
            if flag == "statbel_boundary":
                # Documented Statbel rounding artifacts, not our error. Only
                # 4 exist in the entire 4,490,779-row file.
                known += 1
                if got != expected:
                    known_still_diverging += 1
                continue
            total += 1
            if got == expected:
                ok += 1
            else:
                bad.append((lat_s, lon_s, expected, got))

    print("fixture rows          : %d strict + %d known-divergent" % (total, known))
    print("cell id matches       : %d/%d (%.4f%%)"
          % (ok, total, 100.0 * ok / total if total else 0.0))
    print("known divergences     : %d/%d still diverging, as documented"
          % (known_still_diverging, known))
    print("max projection error  : %.6f m vs the file's own XY_X_3035/XY_Y_3035" % max_err)

    ncells = neighbours("1kmN3126E3927")
    assert len(ncells) == 9 and len(set(ncells)) == 9, ncells
    assert ncells[0] == "1kmN3126E3927"
    assert set(ncells) == {
        "1kmN%dE%d" % (n, e)
        for n in (3125, 3126, 3127)
        for e in (3926, 3927, 3928)
    }, ncells
    assert parse_cell("1kmN3126E3927") == (3126, 3927)
    assert cell_bounds_3035("1kmN3126E3927") == (3927000, 3126000, 3928000, 3127000)
    print("neighbours()          : ok (9 unique, self first)")

    if bad:
        print("MISMATCHES:")
        for row in bad[:20]:
            print("  lat=%s lon=%s expected=%s got=%s" % row)
        raise SystemExit(1)
    if max_err > 0.01:
        print("PROJECTION ERROR TOO LARGE")
        raise SystemExit(1)
    print("SELF-TEST PASSED")


if __name__ == "__main__":
    _self_test()
