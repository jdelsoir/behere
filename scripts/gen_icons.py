#!/usr/bin/env python3
"""BeHERE PWA icons, written with the Python standard library only.

Pillow is NOT installed on the build machine and must never become a dependency,
so this module writes PNG bytes directly: zlib for the IDAT stream, struct for
the chunk framing, and an analytic coverage function for anti-aliasing.

Emitted (all opaque RGB, colour type 2, 8 bits per channel):

    web/icons/icon-192.png            192x192   manifest, purpose "any"
    web/icons/icon-512.png            512x512   manifest, purpose "any"
    web/icons/icon-512-maskable.png   512x512   manifest, purpose "maskable",
                                                mark held inside the centre 80%
    web/icons/apple-touch-icon.png    180x180   iOS home screen, no alpha
    web/favicon-32.png                 32x32    browser tab

The mark is deliberately geometric and restrained: a solid terracotta field with
a cream ring and a cream centre dot, the universal "you are here" glyph. No
typography, no gradient, no icon library. It survives being 32 pixels wide.

Determinism: the output depends only on the constants in this file. Running it
twice produces byte-identical PNGs, so a scheduled rebuild gives a clean diff.

Usage:
    python3 scripts/gen_icons.py [--out WEB_DIR] [--verify-only]
"""

import argparse
import os
import struct
import sys
import zlib

# --- palette -------------------------------------------------------------
# Organic, from web/app/tokens.css. Both values are token colours, not new ones.
#
# The field is --color-accent-700, NOT the brand --color-accent #c67139. The
# brand hue carries cream at 3.03:1, which is enough for a large decorative
# shape and not enough for a 3-pixel ring on a 32-pixel favicon. The 700 step
# carries the same cream at 5.72:1, so the ring survives the tab strip. This is
# the same rule the UI applies everywhere: any solid accent fill that carries a
# cream mark uses the 700 step (docs/UI_SPEC.md section 7.4, row F1).
#
# Field over mark rather than mark over field, because the launcher composites
# the icon against wallpaper of any colour: a cream-grounded icon would vanish
# on a light home screen, and the manifest background_color already supplies the
# cream for the splash.
FIELD = (0x8C, 0x49, 0x1A)   # --color-accent-700  #8C491A  terracotta
MARK = (0xF5, 0xEA, 0xD8)    # --color-bg          #F5EAD8  cream

# --- mark geometry, as fractions of the canvas edge -----------------------
RING_OUTER = 0.360
RING_WIDTH = 0.075
DOT_RADIUS = 0.125
# Maskable icons are cropped to an arbitrary shape by the launcher. Everything
# meaningful must sit inside the centre 80%, so the mark is scaled by 0.8.
MASKABLE_SCALE = 0.80


def _clamp01(v):
    if v < 0.0:
        return 0.0
    if v > 1.0:
        return 1.0
    return v


def _coverage(dist, radius):
    """Anti-aliased coverage of a disc edge, one pixel wide.

    Returns 1.0 well inside the disc, 0.0 well outside, and a linear ramp
    across the one-pixel band at the boundary. Cheap, deterministic, and
    visually indistinguishable from supersampling for circles this large.
    """
    return _clamp01(0.5 + (radius - dist))


def render(size, scale=1.0):
    """Render the mark at `size` x `size`. Returns a list of RGB row bytes."""
    cx = cy = size / 2.0
    r_out = RING_OUTER * size * scale
    r_in = (RING_OUTER - RING_WIDTH) * size * scale
    r_dot = DOT_RADIUS * size * scale

    fr, fg, fb = FIELD
    mr, mg, mb = MARK
    rows = []
    for y in range(size):
        py = y + 0.5 - cy
        row = bytearray(size * 3)
        for x in range(size):
            px = x + 0.5 - cx
            d = (px * px + py * py) ** 0.5

            # Annulus: inside the outer edge AND outside the inner edge.
            ring = _coverage(d, r_out) * (1.0 - _coverage(d, r_in))
            dot = _coverage(d, r_dot)
            a = ring if ring > dot else dot

            i = x * 3
            row[i] = int(fr + (mr - fr) * a + 0.5)
            row[i + 1] = int(fg + (mg - fg) * a + 0.5)
            row[i + 2] = int(fb + (mb - fb) * a + 0.5)
        rows.append(bytes(row))
    return rows


# --- PNG container -------------------------------------------------------

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def _chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def write_png(path, rows):
    """Write an opaque 8-bit RGB PNG. `rows` is a list of w*3 byte strings."""
    h = len(rows)
    w = len(rows[0]) // 3
    # Filter type 0 (None) on every scanline: the images are flat colour plus a
    # short gradient band, so a smarter filter buys almost nothing and costs
    # determinism review time.
    raw = b"".join(b"\x00" + r for r in rows)
    blob = (PNG_MAGIC
            + _chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + _chunk(b"IDAT", zlib.compress(raw, 9))
            + _chunk(b"IEND", b""))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(blob)
    return len(blob)


# --- read the bytes back and prove they are a valid PNG ------------------

COLOUR_TYPES = {0: "grey", 2: "rgb", 3: "palette", 4: "grey+alpha", 6: "rgba"}


def verify_png(path):
    """Parse the file back from disk. Raises on anything malformed.

    Checks the signature, every chunk CRC, the IHDR fields, and that the
    decompressed IDAT stream is exactly height * (1 + width * 3) bytes, which
    is the only way to be sure the pixels really are the dimensions claimed.
    """
    with open(path, "rb") as fh:
        blob = fh.read()
    if not blob.startswith(PNG_MAGIC):
        raise ValueError("%s: not a PNG (bad signature)" % path)

    pos = len(PNG_MAGIC)
    ihdr = None
    idat = b""
    saw_iend = False
    while pos < len(blob):
        (length,) = struct.unpack(">I", blob[pos:pos + 4])
        tag = blob[pos + 4:pos + 8]
        data = blob[pos + 8:pos + 8 + length]
        (crc,) = struct.unpack(">I", blob[pos + 8 + length:pos + 12 + length])
        if crc != (zlib.crc32(tag + data) & 0xFFFFFFFF):
            raise ValueError("%s: CRC mismatch in chunk %s" % (path, tag))
        if tag == b"IHDR":
            ihdr = struct.unpack(">IIBBBBB", data)
        elif tag == b"IDAT":
            idat += data
        elif tag == b"IEND":
            saw_iend = True
        pos += 12 + length

    if ihdr is None:
        raise ValueError("%s: no IHDR" % path)
    if not saw_iend:
        raise ValueError("%s: no IEND" % path)

    w, h, depth, colour, comp, filt, inter = ihdr
    if (depth, colour, comp, filt, inter) != (8, 2, 0, 0, 0):
        raise ValueError("%s: unexpected IHDR %r" % (path, ihdr))

    raw = zlib.decompress(idat)
    expect = h * (1 + w * 3)
    if len(raw) != expect:
        raise ValueError("%s: IDAT decodes to %d bytes, expected %d"
                         % (path, len(raw), expect))

    return {"w": w, "h": h, "depth": depth, "colour": COLOUR_TYPES[colour],
            "bytes": len(blob)}


# --- the set -------------------------------------------------------------

def targets(web):
    return [
        (os.path.join(web, "icons", "icon-192.png"), 192, 1.0),
        (os.path.join(web, "icons", "icon-512.png"), 512, 1.0),
        (os.path.join(web, "icons", "icon-512-maskable.png"), 512, MASKABLE_SCALE),
        (os.path.join(web, "icons", "apple-touch-icon.png"), 180, 1.0),
        (os.path.join(web, "favicon-32.png"), 32, 1.0),
    ]


def main(argv=None):
    here = os.path.dirname(os.path.abspath(__file__))
    default_web = os.path.join(os.path.dirname(here), "web")

    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--out", default=default_web,
                   help="site root that holds icons/ (default: %s)" % default_web)
    p.add_argument("--verify-only", action="store_true",
                   help="do not write, just re-read what is on disk")
    a = p.parse_args(argv)

    rc = 0
    print("%-42s %-11s %-6s %s" % ("file", "dimensions", "type", "bytes"))
    for path, size, scale in targets(a.out):
        if not a.verify_only:
            write_png(path, render(size, scale))
        try:
            info = verify_png(path)
        except (OSError, ValueError) as exc:
            print("FAIL %s" % exc)
            rc = 1
            continue
        ok = (info["w"] == size and info["h"] == size)
        print("%-42s %4dx%-6d %-6s %6d %s"
              % (os.path.relpath(path, a.out), info["w"], info["h"],
                 info["colour"], info["bytes"], "ok" if ok else "WRONG SIZE"))
        if not ok:
            rc = 1

    print("\n%d icons, all read back from disk and parsed." % len(targets(a.out)))
    return rc


if __name__ == "__main__":
    sys.exit(main())
