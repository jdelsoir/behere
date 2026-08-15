#!/usr/bin/env python3
"""Write web/data/precache.json from the tree already on disk.

scripts/bake.py emits this manifest as its last step, so a full bake keeps it
in step automatically. This script exists for the two cases where a full bake
is not what you want:

  * regenerating the manifest against shards that are already committed,
    without re-downloading 546 MB of source archives
  * checking in CI that the committed manifest still matches the tree

It shares bake.py's precache_doc() and dumps(), so there is exactly one
implementation of the format and one serialiser. Standard library only.

    python3 scripts/gen_precache.py                # rewrite web/data/precache.json
    python3 scripts/gen_precache.py --check        # exit 1 if it is stale
    python3 scripts/gen_precache.py --out /tmp/x   # a different data root
"""
import argparse
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(_HERE)
sys.path.insert(0, _HERE)

from bake import PRECACHE_NAME, VINTAGE, dumps, precache_doc  # noqa: E402


def scan(root):
    """Every file under the data root, as LF-joined relative paths, sorted."""
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for name in sorted(filenames):
            if name.startswith("."):
                continue
            rel = os.path.relpath(os.path.join(dirpath, name), root)
            out.append(rel.replace(os.sep, "/"))
    return sorted(out)


def cities_and_cells(root, relpaths):
    """{nis: [cell id, ...]} read from each shipped <nis>/meta.json."""
    cities = sorted({r.split("/")[0] for r in relpaths
                     if "/" in r and r.split("/")[0].isdigit()
                     and len(r.split("/")[0]) == 5})
    cells = {}
    for nis in cities:
        path = os.path.join(root, nis, "meta.json")
        if not os.path.exists(path):
            cells[nis] = []
            continue
        with open(path, "r", encoding="utf-8") as fh:
            meta = json.load(fh)
        cells[nis] = sorted(meta.get("cells", []))
    return cities, cells


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=os.path.join(_REPO, "web", "data"),
                    help="the data root (default web/data)")
    ap.add_argument("--check", action="store_true",
                    help="do not write; exit 1 when the manifest is stale")
    args = ap.parse_args(argv)

    root = os.path.abspath(args.out)
    if not os.path.isdir(root):
        sys.stderr.write("no such data root: %s\n" % root)
        return 2

    relpaths = scan(root)
    cities, cells = cities_and_cells(root, relpaths)
    blob = dumps(precache_doc(relpaths, cells, cities, VINTAGE))

    target = os.path.join(root, PRECACHE_NAME)
    existing = None
    if os.path.exists(target):
        with open(target, "rb") as fh:
            existing = fh.read()

    doc = json.loads(blob.decode("utf-8"))
    summary = "%s: %d files, %d cities, vintage %s, %d B" % (
        PRECACHE_NAME, doc["count"], len(doc["cities"]), doc["vintage"], len(blob))

    if args.check:
        if existing == blob:
            print("up to date  " + summary)
            return 0
        sys.stderr.write("STALE       %s\n" % summary)
        sys.stderr.write("            run: python3 scripts/gen_precache.py\n")
        return 1

    if existing == blob:
        print("unchanged   " + summary)
        return 0
    with open(target, "wb") as fh:
        fh.write(blob)
    print("wrote       " + summary)
    return 0


if __name__ == "__main__":
    sys.exit(main())
