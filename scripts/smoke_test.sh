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

echo "-- baked data"
check "data/meta.json"          "json"
check "data/precache.json"      "json"
check "data/nis_history.json"   "json"
check "data/i18n/en.json"       "json"
# One shard per pilot municipality. If the bake was skipped these 404 while
# every line above still passes, which is the whole reason this section exists.
for nis in 21004 25121 35013 44021 62063 81001 92003; do
  check "data/$nis/meta.json"    "json"
  check "data/$nis/streets.json" "json"
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
if curl -sSL "${BASE}sw.js" | grep -qiE 'api[_-]?key|access[_-]?token|client[_-]?secret'; then
  echo "FAIL  sw.js contains a credential-shaped string"; fail=1
else
  echo "ok    sw.js carries no credential-shaped string"
fi

echo ""
if [ "$fail" = 0 ]; then
  echo "=> PASS"
else
  echo "=> FAIL (shell 404s? Settings -> Pages -> Source: GitHub Actions."
  echo "         data 404s? the deploy published an app shell with no shards.)"
  exit 1
fi
