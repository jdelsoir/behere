#!/usr/bin/env python3
"""Stamp the service worker's shell-cache version with a hash of the shell.

Stdlib only, like everything else in scripts/.

WHY THIS EXISTS
---------------
web/sw.js ships `const VERSION = "__CACHE_VERSION__"`. Left unstamped, the
shell cache is called `behere-shell-__CACHE_VERSION__` for ever, the activate
handler never sees a name it should delete, and every deploy after the first
serves the previous HTML and JS out of cache. CLAUDE.md's rule is that sw.js
must never be renamed; the cache INSIDE it is the thing that has to rotate.

IDEMPOTENT
----------
The version is a hash of every .html, .css, .js, .mjs and .webmanifest under
the site directory EXCEPT sw.js itself, so stamping does not change its own
input. Running it twice on unchanged content writes the same twelve
characters. It accepts either the placeholder or an already-stamped value, so
it can be run on a working tree or on a copy, in any order, any number of
times.

    python3 scripts/stamp_sw.py                 # stamps web/ in place
    python3 scripts/stamp_sw.py dist            # stamps a staging copy
    python3 scripts/stamp_sw.py --check web     # exit 1 if the stamp is stale

The repo keeps the PLACEHOLDER committed. Stamping is a deploy step, not a
source edit, so the working tree stays byte-stable between releases.
"""
import argparse
import hashlib
import os
import re
import sys

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

PATTERN = re.compile(r'(const VERSION = ")(__CACHE_VERSION__|[0-9a-f]{12})(";)')
# EVERY suffix the shell cache holds, not just the text ones. The fonts and the
# app icons are cache-first entries in sw.js's SHELL_REQUIRED, so if re-
# vendoring a woff2 or regenerating an icon left this hash unchanged, the cache
# name would not rotate and returning users would be served the old bytes for
# ever, under the correct filename. web/data is excluded by SKIP_DIRS and holds
# only JSON anyway, so no data vintage can rotate the shell through this.
HASHED_SUFFIXES = (".html", ".css", ".js", ".mjs", ".webmanifest",
                   ".woff2", ".png")
SKIP_DIRS = {".git", "node_modules", "data", "__pycache__"}


def shell_hash(root):
    """A hash of every shell asset. `data/` is excluded on purpose: a new data
    vintage must NOT rotate the shell cache, because the two have different
    lifetimes and the worker drops the data cache separately on PURGE_DATA."""
    h = hashlib.sha256()
    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        for name in sorted(filenames):
            if name == "sw.js" or not name.endswith(HASHED_SUFFIXES):
                continue
            files.append(os.path.join(dirpath, name))
    for path in sorted(files):
        # The path is part of the identity: moving a file is a shell change.
        h.update(os.path.relpath(path, root).replace(os.sep, "/").encode("utf-8"))
        h.update(b"\0")
        with open(path, "rb") as fh:
            h.update(fh.read())
    return h.hexdigest()[:12], files


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("site", nargs="?", default=os.path.join(_REPO, "web"),
                   help="the site directory holding sw.js (default: web/)")
    p.add_argument("--check", action="store_true",
                   help="do not write; exit 1 when the stamp is missing or stale")
    args = p.parse_args(argv)

    root = os.path.abspath(args.site)
    sw = os.path.join(root, "sw.js")
    if not os.path.exists(sw):
        print("stamp_sw: no sw.js in %s" % root, file=sys.stderr)
        return 2

    with open(sw, encoding="utf-8") as fh:
        text = fh.read()
    m = PATTERN.search(text)
    if not m:
        print('stamp_sw: sw.js has no `const VERSION = "..."` line to stamp',
              file=sys.stderr)
        return 2

    version, files = shell_hash(root)
    current = m.group(2)

    if args.check:
        if current == version:
            print("stamp_sw: %s is current (%d shell files)" % (version, len(files)))
            return 0
        print("stamp_sw: stale stamp %r, expected %r" % (current, version),
              file=sys.stderr)
        return 1

    if current == version:
        print("stamp_sw: already %s (%d shell files, unchanged)" % (version, len(files)))
        return 0

    with open(sw, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(PATTERN.sub(lambda _m: _m.group(1) + version + _m.group(3), text, count=1))
    print("stamp_sw: %s -> %s (%d shell files)" % (current, version, len(files)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
