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
    python3 scripts/gen_precache.py --tiles-only   # run just the tile gate

THE TILE GATE
-------------
This script also carries the two greps that prove the OSM basemap is never
precached. They live here rather than in a workflow step because this file is
already run by CI (`gen_precache.py --check`) and by anyone regenerating the
manifest by hand, so the gate cannot be skipped by editing YAML, and it fails
on a laptop before it fails in Actions. Both run in --check and in write mode.
See tile_gate() for what exactly is asserted and why each half is needed.
"""
import argparse
import json
import os
import re
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


# ---------------------------------------------------------------- the tile gate

TILE_HOST = "tile.openstreetmap.org"

# `const NAME = [ ... ];` for the three shell lists in web/sw.js.
_SHELL_LIST = re.compile(
    r"const\s+(SHELL_REQUIRED|SHELL_EXPECTED|SHELL_OPTIONAL)\s*=\s*\[(.*?)\]\s*;",
    re.S)
_STRING = re.compile(r"""["']([^"']*)["']""")
# A line that adds something to a Cache: cache.add(...), cache.addAll(...).
_CACHE_ADD = re.compile(r"\.add(?:All)?\s*\(")
# Every /* ... */ block, and everything from // to end of line -- but NOT the
# "//" in "https://", which is why the lookbehind is there.
#
# THIS GATE LOOKS FOR FORBIDDEN STRINGS, so over-stripping makes it LAXER, not
# stricter, and that is the opposite of what a naive reading suggests: a shell
# list entry "https://tile.openstreetmap.org/..." would have its own URL blanked
# as a comment and sail straight through. Learned the hard way. Comment
# stripping is therefore used ONLY for the "named exactly once" count, where a
# prose mention of the host would otherwise be a false positive. Every scan for
# a forbidden string runs on the RAW source, so a commented-out offender fails
# the gate rather than hiding in it.
_LINE_COMMENT = re.compile(r"(?<!:)//.*$", re.M)
_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.S)


def strip_js_comments(text):
    """Blank out comments while preserving line count, so numbers stay true."""
    def blank(m):
        return re.sub(r"[^\n]", " ", m.group(0))
    return _LINE_COMMENT.sub(blank, _BLOCK_COMMENT.sub(blank, text))


def tile_gate(manifest_bytes, sw_path):
    """Prove no OSM tile URL can reach precache.json or the install precache.

    Returns a list of failure strings; empty means the gate passed.

    Two greps, because they close two different doors:

      1. THE MANIFEST. web/sw.js precaches every entry of precache.json at
         install, for all seven pilot cities at once. A tile URL in that list
         would be bulk downloading, which the OSM tile usage policy forbids in
         terms. bake.py's assert_baked_relpath() already makes it impossible to
         WRITE one; this checks the bytes that are actually shipped, so a
         hand-edited or merge-mangled manifest is caught too.

      2. THE WORKER'S OWN INSTALL PATH. The manifest is not the only way into a
         precache: cache.add()/cache.addAll() take any URL. So the tile host
         must appear in executable code exactly once, as the TILE_HOST
         constant, and must never appear on a line that adds to a cache; and
         no shell list may contain a scheme at all. The only tile write left is
         the runtime one in fetchTile(), which stores a tile the user has
         already looked at -- the one thing the policy does allow.
    """
    fail = []

    text = manifest_bytes.decode("utf-8", "replace")
    if TILE_HOST in text or "://" in text:
        fail.append("%s names an absolute URL or the tile host. The install "
                    "precache would bulk-download it, which breaches the OSM "
                    "tile usage policy." % PRECACHE_NAME)
    doc = json.loads(text)
    for rel in doc.get("files", []):
        if not isinstance(rel, str) or rel.startswith("/") or "://" in rel \
                or rel.startswith("//") or ".." in rel:
            fail.append("%s lists a non-relative entry: %r" % (PRECACHE_NAME, rel))

    if not os.path.exists(sw_path):
        fail.append("no service worker at %s to check" % sw_path)
        return fail

    with open(sw_path, "r", encoding="utf-8") as fh:
        sw = fh.read()
    code = strip_js_comments(sw)

    # Comment-stripped: prose in this file names the host several times, and
    # that is not a defect.
    occurrences = code.count(TILE_HOST)
    if occurrences != 1:
        fail.append("sw.js names %s %d times outside a comment; exactly one is "
                    "allowed (the TILE_HOST constant)" % (TILE_HOST, occurrences))
    if not re.search(r'const\s+TILE_HOST\s*=\s*"%s"\s*;' % re.escape(TILE_HOST), code):
        fail.append('sw.js has no `const TILE_HOST = "%s";`' % TILE_HOST)

    # RAW from here down: see the note on strip_js_comments.
    for n, line in enumerate(sw.split("\n"), 1):
        if _CACHE_ADD.search(line) and ("TILE" in line or TILE_HOST in line
                                        or "://" in line):
            fail.append("sw.js:%d passes a tile or off-origin URL to a cache "
                        "add: %s" % (n, line.strip()))

    listed = 0
    for name, body in _SHELL_LIST.findall(sw):
        entries = _STRING.findall(body)
        listed += len(entries)
        for entry in entries:
            if "://" in entry or entry.startswith("//") or TILE_HOST in entry:
                fail.append("sw.js %s contains an off-origin entry: %r"
                            % (name, entry))
    if listed == 0:
        fail.append("sw.js: found no shell list to check; the gate would pass "
                    "vacuously, so it fails instead")
    return fail


def run_tile_gate(manifest_bytes, quiet=False):
    """Print the verdict; return 0 on pass, 1 on failure."""
    sw_path = os.path.join(_REPO, "web", "sw.js")
    fail = tile_gate(manifest_bytes, sw_path)
    if fail:
        for line in fail:
            sys.stderr.write("TILE GATE   %s\n" % line)
        return 1
    if not quiet:
        print("tile gate    no %s in %s, none in any sw.js shell list, "
              "none near a cache add" % (TILE_HOST, PRECACHE_NAME))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=os.path.join(_REPO, "web", "data"),
                    help="the data root (default web/data)")
    ap.add_argument("--check", action="store_true",
                    help="do not write; exit 1 when the manifest is stale")
    ap.add_argument("--tiles-only", action="store_true",
                    help="run only the tile gate, against the manifest on disk")
    args = ap.parse_args(argv)

    root = os.path.abspath(args.out)
    if not os.path.isdir(root):
        sys.stderr.write("no such data root: %s\n" % root)
        return 2

    if args.tiles_only:
        target = os.path.join(root, PRECACHE_NAME)
        if not os.path.exists(target):
            sys.stderr.write("no %s at %s\n" % (PRECACHE_NAME, target))
            return 2
        with open(target, "rb") as fh:
            return run_tile_gate(fh.read())

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

    # Gate the bytes that are about to be shipped, in both modes. A stale
    # manifest fails below anyway, so checking `blob` covers `existing` too.
    if run_tile_gate(blob):
        return 1

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
