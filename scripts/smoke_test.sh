#!/usr/bin/env bash
# Post-deploy smoke test for the BeHERE PWA on GitHub Pages.
#
# Vendored from the static-pwa-ghpages skill, then extended: the shell checks
# are the skill's, the data checks below them are BeHERE's. web/data/ is NOT in
# Git (see .gitignore), so a shell that deploys without its shards is the exact
# failure this repo is most exposed to, and it looks perfectly healthy from the
# outside. The shell asset checks alone would call that deploy PASS.
#
# Usage: bash scripts/smoke_test.sh https://<user>.github.io/behere/
set -uo pipefail
BASE="${1:?usage: smoke_test.sh https://<user>.github.io/behere/}"
BASE="${BASE%/}/"
fail=0

check() {  # path  expected_substring_in_content_type
  local url="${BASE}$1" want="$2"
  local out code ct
  out=$(curl -sSL -o /dev/null -w '%{http_code} %{content_type}' "$url")
  code="${out%% *}"; ct="${out#* }"
  if [ "$code" != "200" ]; then
    echo "FAIL  $1 -> HTTP $code"; fail=1
  elif [ -n "$want" ] && ! printf '%s' "$ct" | grep -qi "$want"; then
    echo "WARN  $1 -> 200 but Content-Type='$ct' (want ~ '$want')"
  else
    echo "ok    $1 -> 200 $ct"
  fi
}

echo "Smoke testing $BASE"
echo "-- app shell"
check ""                     "text/html"
check "index.html"           "text/html"
check "manifest.webmanifest" "manifest"
check "sw.js"                "javascript"
check "offline.html"         "text/html"
check "404.html"             "text/html"
check "icons/icon-192.png"   "image/png"
check "icons/icon-512.png"   "image/png"

# Every entry of sw.js's SHELL_REQUIRED that is not checked above. This tier is
# fetched with cache.addAll, so ONE 404 here fails the whole service worker
# install and the user gets no worker, and therefore no offline data: a missing
# stylesheet or font takes out acceptance test 1. Added 15 August 2026 with the
# map-first revamp, which is what put fonts and three new modules in that tier.
echo "-- app shell: the rest of SHELL_REQUIRED"
check "app/tokens.css"       "text/css"
check "app/app.css"          "text/css"
check "app/map.css"          "text/css"
for m in main map mercator grid geo i18n icons stats sw-register offline; do
  check "app/$m.js"          "javascript"
done

# The faces, and the licence texts whose presence is the condition under which
# redistributing an OFL font is legal at all. Pages must serve woff2 as
# font/woff2; a text/plain body here would still install but render as nothing.
echo "-- self-hosted fonts (OFL-1.1)"
for f in caprasimo-400-latin caprasimo-400-latin-ext figtree-var-latin figtree-var-latin-ext; do
  check "fonts/$f.woff2"     "font/woff2"
done
check "fonts/OFL-Caprasimo.txt" "text/plain"
check "fonts/OFL-Figtree.txt"   "text/plain"

echo "-- baked data"
check "data/meta.json"          "json"
check "data/precache.json"      "json"
check "data/nis_history.json"   "json"
check "data/i18n/en.json"       "json"
# One shard per pilot municipality. If the bake was skipped these 404 while
# every line above still passes, which is the whole reason this section exists.
# All NINE pilots. 25023 and 25068 landed in the "add Court-Saint-Etienne and
# Mont-Saint-Guibert" commit and were never added here, so a deploy that lost
# either of them passed this test.
for nis in 21004 25023 25068 25121 35013 44021 62063 81001 92003; do
  check "data/$nis/meta.json"    "json"
  check "data/$nis/streets.json" "json"
  check "data/$nis/sector.geojson" "json"
done

# The vintage the deployed tree actually carries. Pinned to 2025 (CLAUDE.md);
# a deploy serving anything else means a shard set from another release leaked
# through, and every NIS join in it is suspect.
echo "-- vintage"
vintage=$(curl -sSL "${BASE}data/meta.json" | tr -d ' \n' | sed -n 's/.*"vintage":"\([^"]*\)".*/\1/p')
if [ "$vintage" = "2025-01-01" ]; then
  echo "ok    data/meta.json vintage=$vintage"
else
  echo "FAIL  data/meta.json vintage='$vintage' (want 2025-01-01)"; fail=1
fi

# CLAUDE.md, PLAN acceptance test 7: no runtime call may carry a credential.
echo "-- no credentials served"
# Same no-pipe-into-grep-q rule as below: safe today only because a clean tree
# has no match and grep therefore reads to EOF, which is luck, not design.
if printf '%s' "$(curl -sSL "${BASE}sw.js")" | grep -qiE 'api[_-]?key|access[_-]?token|client[_-]?secret'; then
  echo "FAIL  sw.js contains a credential-shaped string"; fail=1
else
  echo "ok    sw.js carries no credential-shaped string"
fi

# NEVER WRITE `curl ... | grep -q` IN THIS FILE.
#
# `grep -q` exits the instant it matches. curl then writes into a closed pipe,
# gives up with exit 23, and `set -o pipefail` at the top of this script makes
# the whole pipeline non-zero -- so a check whose string IS present reports
# FAIL. It is a race against the pipe buffer, so it passes in isolation and
# fails under load: measured here at 5 false failures in 12 runs against the
# live site. The three checks below therefore fetch into a variable first and
# grep that. `body_of <path>` does exactly that, and returns the body on stdout.
body_of() { curl -sSL "${BASE}$1"; }

# ODbL 1.0 requires the credit, and the OSMF attribution guidelines require it
# be legible on the map rather than hidden behind an info button. It is a
# licence term for a layer we do not own, so it gets a deploy gate: a markup
# refactor that drops the link is a licence breach, not a cosmetic regression.
echo "-- OpenStreetMap attribution (ODbL, required)"
html=$(body_of "index.html")
if printf '%s' "$html" | grep -q 'openstreetmap.org/copyright'; then
  echo "ok    index.html links to openstreetmap.org/copyright"
else
  echo "FAIL  index.html has no ODbL attribution link"; fail=1
fi
if printf '%s' "$html" | grep -q 'img-src[^;]*tile\.openstreetmap\.org'; then
  echo "ok    CSP img-src admits the tile host"
else
  echo "FAIL  CSP img-src does not admit tile.openstreetmap.org: no basemap will load"; fail=1
fi

# The other half of the tile policy: tiles are runtime-cached only. The build
# gate in gen_precache.py proves this about the repo; this proves it about the
# bytes actually being served, which is what OSM would see.
echo "-- the basemap is never precached (OSM tile usage policy)"
if printf '%s' "$(body_of "data/precache.json")" | grep -q 'tile.openstreetmap.org'; then
  echo "FAIL  precache.json names the tile host: install would bulk-download tiles"; fail=1
else
  echo "ok    precache.json names no tile host"
fi

# Left unstamped, the shell cache keeps one name for ever and every deploy
# after the first serves the previous HTML out of cache. sw.js is never
# renamed (CLAUDE.md), so this is the only thing that rotates.
echo "-- the service worker cache version was stamped"
if printf '%s' "$(body_of "sw.js")" | grep -q '__CACHE_VERSION__'; then
  echo "FAIL  sw.js still carries the __CACHE_VERSION__ placeholder"; fail=1
else
  echo "ok    sw.js cache version is stamped"
fi

echo ""
if [ "$fail" = 0 ]; then
  echo "=> PASS"
else
  echo "=> FAIL (shell 404s? Settings -> Pages -> Source: GitHub Actions."
  echo "         data 404s? the deploy published an app shell with no shards.)"
  exit 1
fi
