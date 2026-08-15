"""Validate scripts/geo31370.py against Statbel ground truth.

The Statbel address-to-sector file carries, on every row, the same point in both
EPSG:31370 (`XY_X_LB72`, `XY_Y_LB72`) and WGS84 (`XY_LON_WGS84`,
`XY_LAT_WGS84`). That makes it 4,490,779 independent check points for the
reprojection, produced by Statbel's own geodetic stack rather than by ours.

Usage:
    python3 scripts/geo31370_validate.py <samples.psv>

`samples.psv` is pipe-delimited with a header row containing at least
CD_REFNIS, XY_X_LB72, XY_Y_LB72, XY_LON_WGS84, XY_LAT_WGS84.

Exit status is non-zero if the 99th percentile forward error exceeds 2 metres,
which is the accuracy floor BeHERE requires: a sector boundary drawn 2 m out is
invisible at any zoom the app offers, a 20 m one is not.
"""

import math
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from geo31370 import lb72_to_wgs84, wgs84_to_lb72  # noqa: E402

_R_EARTH = 6371008.8  # mean radius, metres


def haversine_m(lon1, lat1, lon2, lat2):
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * _R_EARTH * math.asin(math.sqrt(a))


def pct(sorted_vals, p):
    if not sorted_vals:
        return float("nan")
    k = (len(sorted_vals) - 1) * p / 100.0
    lo = int(math.floor(k))
    hi = int(math.ceil(k))
    if lo == hi:
        return sorted_vals[lo]
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (k - lo)


def main(path):
    fwd = []      # metres, our lb72->wgs84 vs Statbel's wgs84
    rt = []       # metres, round-trip lb72 -> wgs84 -> lb72
    worst = None
    with open(path, encoding="utf-8") as fh:
        hdr = fh.readline().rstrip("\n").split("|")
        ix = {k: i for i, k in enumerate(hdr)}
        for line in fh:
            f = line.rstrip("\n").split("|")
            if len(f) < len(hdr):
                continue
            x = float(f[ix["XY_X_LB72"]])
            y = float(f[ix["XY_Y_LB72"]])
            ref_lon = float(f[ix["XY_LON_WGS84"]])
            ref_lat = float(f[ix["XY_LAT_WGS84"]])
            lon, lat = lb72_to_wgs84(x, y)
            d = haversine_m(lon, lat, ref_lon, ref_lat)
            fwd.append(d)
            if worst is None or d > worst[0]:
                worst = (d, f[ix["CD_REFNIS"]], x, y, lon, lat, ref_lon, ref_lat)
            bx, by = wgs84_to_lb72(ref_lon, ref_lat)
            rt.append(math.hypot(bx - x, by - y))

    fwd.sort()
    rt.sort()
    n = len(fwd)
    print("check points: %d" % n)
    print("")
    print("EPSG:31370 -> WGS84, distance to the Statbel WGS84 columns (metres)")
    print("  mean   %.4f" % (sum(fwd) / n))
    print("  median %.4f" % pct(fwd, 50))
    print("  p95    %.4f" % pct(fwd, 95))
    print("  p99    %.4f" % pct(fwd, 99))
    print("  max    %.4f" % fwd[-1])
    print("")
    print("WGS84 -> EPSG:31370, distance to the Statbel LB72 columns (metres)")
    print("  mean   %.4f" % (sum(rt) / n))
    print("  p99    %.4f" % pct(rt, 99))
    print("  max    %.4f" % rt[-1])
    print("")
    print("worst forward point: %.4f m  NIS %s" % (worst[0], worst[1]))
    print("  lb72   %.2f %.2f" % (worst[2], worst[3]))
    print("  ours   %.9f %.9f" % (worst[4], worst[5]))
    print("  statbel %.9f %.9f" % (worst[6], worst[7]))

    ok = pct(fwd, 99) <= 2.0 and fwd[-1] <= 2.0
    print("")
    print("VERDICT: %s (threshold 2 m)" % ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
