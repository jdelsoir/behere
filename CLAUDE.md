# BeHERE

Location-first Belgian civic and tourist app. Static PWA on GitHub Pages, base path `/behere/`.

**Read `PLAN.md` before doing anything.** It is the full build brief: verified endpoints, the join spine, byte budget, build phases and acceptance tests. This file only carries the rules that must never be violated while working in this repo.

## Non-negotiables

- **No backend, no proxy, no API keys, no secrets.** The repo is public and Pages serves static files only. Every runtime source must be keyless and CORS-permissive. If a source needs a key, it gets baked at build time or dropped.
- **Runtime versus bake-time is decided by CORS, not by convenience.** Test with `curl -sI -H 'Origin: https://example.github.io' <url>` before adding any source. Lists of both are in `PLAN.md` section 3.
- **National layers first, local layers as enrichment.** Two pilot cities publish almost nothing locally. If the app looks empty there, the architecture is wrong, not the city.
- **Never render an empty panel.** A missing layer collapses, with copy that names what is missing.
- **Pin one data vintage per release** and record it in shard metadata. Belgium went from 581 to 565 municipalities on 1 January 2025, so cross-vintage NIS joins must pass through `data/nis_history.json`.
- **Postcode is not a municipality.** City of Brussels (NIS 21004) spans 10 postcodes. Resolve position to NIS via the address record or sector polygon.
- **Never machine-translate street or place names.** Only the curated override list in `web/data/i18n/en.json` supplies English.
- **Never rename `sw.js`.** A bad service worker serves stale HTML forever, and the fix is overwriting that exact URL.

## Gotchas that waste an hour if forgotten

- NAP GTFS `/static` endpoints return **404 to `HEAD`** and **200 to `GET`**. Never health-check them with HEAD.
- `doc.statbel.fgov.be` serves its Turtle catalogue as `application/octet-stream`. Tell the parser the format.
- Flemish GRB WFS caps `numberMatched` at exactly 10000. That is a server limit, not a count.
- `opendata.brussels.be` is the **City** of Brussels. The Region is `catalog.datastore.brussels`, and its `/api/search` path returns 403 (use `/geonetwork/srv/eng/q?_content_type=json`).
- Rate limits: iRail 3 requests per second (send a descriptive User-Agent), Opendatasoft 20,000 per day.

## Working agreements

- The bake script must be idempotent: identical input produces byte-identical output, so scheduled rebuilds give clean diffs.
- Keep generated data out of Git history where possible. Ship the seven pilot cities (about 2.15 MB gzipped), not the national bundle.
- Every layer in the UI shows its source and its vintage date.
- Use the `static-pwa-ghpages` skill for the pre-flight, PWA templates, deploy workflow and smoke test. Run its pre-flight before promising any deploy.
