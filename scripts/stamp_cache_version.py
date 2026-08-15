#!/usr/bin/env python3
"""Replace __CACHE_VERSION__ in sw.js with a content hash of the precached assets.

Run this in the build/deploy step so each deploy busts the old service-worker cache.
Stdlib only.

Usage: python3 stamp_cache_version.py [SITE_DIR]   (default: .)
"""
import hashlib, os, re, sys

root = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else ".")
sw = os.path.join(root, "sw.js")
if not os.path.exists(sw):
    sys.exit("sw.js not found in %s" % root)

# Hash index.html + manifest + all CSS/JS so any asset change rotates the cache name.
h = hashlib.sha256()
files = []
for dp, dns, fns in os.walk(root):
    dns[:] = [d for d in dns if d not in (".git", "node_modules")]
    for fn in fns:
        if fn.endswith((".html", ".css", ".js", ".mjs", ".webmanifest")) and fn != "sw.js":
            files.append(os.path.join(dp, fn))
for f in sorted(files):
    with open(f, "rb") as fh:
        h.update(fh.read())
ver = h.hexdigest()[:12]

t = open(sw, encoding="utf-8").read()
n = t.count("__CACHE_VERSION__")
t = t.replace("__CACHE_VERSION__", ver)
open(sw, "w", encoding="utf-8").write(t)
if "__CACHE_VERSION__" in open(sw).read():
    sys.exit("ERROR: placeholder still present")
print("stamped sw.js cache version -> %s (%d replacement%s, %d files hashed)"
      % (ver, n, "" if n == 1 else "s", len(files)))
