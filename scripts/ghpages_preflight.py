#!/usr/bin/env python3
"""ghpages_preflight — can this code base ship to GitHub Pages (as a PWA)?

GitHub Pages serves STATIC files only (no server runtime, no rewrites). Run this
BEFORE promising a deploy. It returns GO / GO-WITH-FIXES / NO-GO plus a checklist.

Usage:
  python3 ghpages_preflight.py [DIR] [--repo-name NAME] [--build-dir dist]

Checks: static-only, secrets, absolute asset paths vs project base path, SPA 404
fallback, .nojekyll, site/file size limits, build tooling + base config.
Stdlib only.
"""
import argparse, json, os, re, sys

ROOT = None
def rel(p): return os.path.relpath(p, ROOT)

def walk_files(root, exts=None, skip=(".git", "node_modules", ".terraform", "dist", "build")):
    for dp, dns, fns in os.walk(root):
        dns[:] = [d for d in dns if d not in skip]
        for fn in fns:
            if exts is None or fn.lower().endswith(exts):
                yield os.path.join(dp, fn)

class Report:
    def __init__(self): self.fail=[]; self.warn=[]; self.ok=[]; self.info=[]
    def F(self,m): self.fail.append(m)
    def W(self,m): self.warn.append(m)
    def OK(self,m): self.ok.append(m)
    def I(self,m): self.info.append(m)

def check_static(root, r):
    """Server-side runtime markers that GitHub Pages cannot run."""
    php = list(walk_files(root, (".php",)))
    if php: r.F("PHP files present (%d) — GitHub Pages cannot execute PHP: %s" % (len(php), rel(php[0])))
    reqs = os.path.join(root, "requirements.txt")
    if os.path.exists(reqs):
        t = open(reqs, errors="ignore").read().lower()
        if any(k in t for k in ("flask", "django", "fastapi", "uvicorn", "gunicorn")):
            r.F("Python web server in requirements.txt — needs a host, not Pages (static export only).")
    pj = os.path.join(root, "package.json")
    framework = None
    if os.path.exists(pj):
        try: data = json.load(open(pj))
        except Exception: data = {}
        deps = {**data.get("dependencies", {}), **data.get("devDependencies", {})}
        scripts = data.get("scripts", {})
        if "next" in deps: framework = "next"; r.W("Next.js detected — only ships to Pages with `output: 'export'` (static export). SSR/API routes will NOT work.")
        elif "nuxt" in deps: framework = "nuxt"; r.W("Nuxt detected — use `nuxi generate` (static). SSR will not work on Pages.")
        elif "vite" in deps: framework = "vite"; r.OK("Vite detected — builds to a static `dist/` (Pages-friendly).")
        elif "react-scripts" in deps: framework = "cra"; r.OK("CRA detected — `npm run build` emits static `build/`.")
        if "build" in scripts: r.I("Build step: `npm run build` (scripts.build present).")
        else: r.W("No `build` script in package.json — confirm how the static output is produced.")
    return framework

def check_secrets(root, r):
    pats = [
        ("Bearer token", re.compile(r"Bearer\s+eyJ[A-Za-z0-9_\-]{10,}")),
        ("JWT", re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}")),
        ("Authorization header", re.compile(r"[\"']?[Aa]uthorization[\"']?\s*[:=]\s*[\"']?(Bearer|Basic)\s")),
        ("AWS access key", re.compile(r"AKIA[0-9A-Z]{16}")),
        ("Azure client secret-ish", re.compile(r"client_secret\s*[:=]\s*[\"'][^\"']{16,}")),
        ("Generic api key", re.compile(r"(api[_-]?key|secret|password)\s*[:=]\s*[\"'][^\"']{12,}", re.I)),
    ]
    hits = []
    for f in walk_files(root, (".html", ".js", ".mjs", ".ts", ".tsx", ".json", ".css", ".env")):
        try: t = open(f, errors="ignore").read()
        except Exception: continue
        for name, pat in pats:
            if pat.search(t): hits.append((name, rel(f))); break
    if hits:
        r.F("Possible SECRETS in client-shipped files (Pages is public-readable):")
        for name, f in hits[:8]: r.fail.append("    - %s in %s" % (name, f))
    else:
        r.OK("No obvious secrets found in client files.")

def check_asset_paths(root, repo, framework, r):
    """Absolute root-relative paths break under a project base path /<repo>/."""
    abs_re = re.compile(r"""(?:href|src)\s*=\s*["']/(?!/)[^"']*["']|url\(\s*/(?!/)""")
    bad = []
    for f in walk_files(root, (".html", ".css")):
        try: t = open(f, errors="ignore").read()
        except Exception: continue
        for m in abs_re.finditer(t):
            bad.append((rel(f), m.group(0)[:60]))
    is_project_page = bool(repo) and not repo.endswith(".github.io")
    if bad and is_project_page:
        r.W("Absolute root-relative asset paths (%d) will 404 under /%s/ — use relative paths or set a base path:" % (len(bad), repo))
        for f, s in bad[:6]: r.warn.append("    - %s : %s" % (f, s))
    elif bad:
        r.I("%d absolute asset paths found (fine for a user/org root page, broken for a project page)." % len(bad))
    else:
        r.OK("No problematic absolute asset paths.")
    # Vite base config
    vcfg = next((p for p in (os.path.join(root,"vite.config.ts"), os.path.join(root,"vite.config.js")) if os.path.exists(p)), None)
    if vcfg and is_project_page:
        t = open(vcfg, errors="ignore").read()
        if re.search(r"base\s*:", t): r.OK("vite.config has a `base` — verify it equals '/%s/'." % repo)
        else: r.W("vite.config has NO `base` — set base:'/%s/' for a project page." % repo)

def check_spa_routing(root, r):
    for f in walk_files(root, (".js", ".mjs", ".ts", ".tsx", ".jsx")):
        try: t = open(f, errors="ignore").read()
        except Exception: continue
        if "BrowserRouter" in t or "createBrowserRouter" in t:
            has404 = os.path.exists(os.path.join(root, "404.html")) or os.path.exists(os.path.join(root, "public", "404.html"))
            (r.OK if has404 else r.W)(
                "SPA history routing detected — %s 404.html fallback (Pages has no server rewrites)." %
                ("404.html present, good" if has404 else "ADD a 404.html that boots the app"))
            return
    r.I("No SPA history router detected (hash routing or MPA — no 404 fallback needed).")

def check_nojekyll(root, r):
    has = os.path.exists(os.path.join(root, ".nojekyll")) or os.path.exists(os.path.join(root, "public", ".nojekyll"))
    underscore = [d for d in os.listdir(root) if d.startswith("_") and os.path.isdir(os.path.join(root, d))]
    if has: r.OK(".nojekyll present (Jekyll disabled — `_`-prefixed assets served).")
    elif underscore: r.F("`_`-prefixed dirs %s exist but NO .nojekyll — Jekyll will drop them. Add .nojekyll." % underscore)
    else: r.W("No .nojekyll — add it; Vite/build output often uses `_`-prefixed asset folders.")

def check_size(root, r):
    total = 0; big = []
    for f in walk_files(root):
        try: s = os.path.getsize(f)
        except Exception: continue
        total += s
        if s > 100*1024*1024: big.append((rel(f), s))
    gb = total / 1e9
    if big: r.F("File(s) over GitHub's 100 MB hard limit: " + ", ".join("%s (%.0fMB)" % (f, s/1e6) for f, s in big[:4]))
    if gb > 1: r.W("Total size %.2f GB — above the ~1 GB Pages soft limit; trim assets/history." % gb)
    else: r.OK("Total size %.0f MB — within Pages limits." % (total/1e6))

def check_sw(root, r):
    """Service-worker footguns: hashed filename (never updates) + scope under base."""
    sws = [p for p in walk_files(root, (".js",)) if os.path.basename(p).startswith("sw")
           and re.search(r"serviceworker|self\.addEventListener\(['\"]install", open(p, errors="ignore").read()[:4000], re.I)]
    # hashed SW filename anywhere referenced in registration?
    hashed = []
    for f in walk_files(root, (".html", ".js", ".mjs", ".ts", ".tsx")):
        try: t = open(f, errors="ignore").read()
        except Exception: continue
        for m in re.finditer(r"register\(\s*['\"]([^'\"]+)['\"]", t):
            if re.search(r"sw[.\-][0-9a-f]{6,}\.js|service-worker[.\-][0-9a-f]{6,}", m.group(1)):
                hashed.append((rel(f), m.group(1)))
    if hashed:
        r.F("Service worker registered with a HASHED filename — browsers byte-compare the SW URL, so a hashed name means updates NEVER reach users: %s" % hashed[0][1])
    elif sws:
        r.OK("Service worker present with a stable filename (updates will be detected).")
    else:
        r.I("No service worker found yet (fine — manifest alone makes it installable; SW adds offline).")

def check_mixed_content(root, r):
    bad = []
    rx = re.compile(r"""(?:src|href)\s*=\s*['"]http://|url\(\s*['"]?http://""", re.I)
    for f in walk_files(root, (".html", ".css", ".js", ".mjs")):
        try: t = open(f, errors="ignore").read()
        except Exception: continue
        if rx.search(t): bad.append(rel(f))
    if bad: r.F("Mixed content — http:// resources will be blocked on the HTTPS Pages site: %s" % ", ".join(bad[:5]))
    else: r.OK("No mixed-content (http://) references.")

def check_apple_csp(root, r):
    html = [p for p in walk_files(root, (".html",))]
    txt = "".join(open(p, errors="ignore").read() for p in html[:30])
    if not txt: return
    if re.search(r"apple-touch-icon", txt): r.OK("apple-touch-icon present (iOS home-screen icon).")
    else: r.W("No apple-touch-icon — iOS uses a blurry screenshot for the home-screen icon. Add a 180×180 opaque PNG.")
    if re.search(r"Content-Security-Policy", txt): r.OK("CSP meta tag present (Pages can't set CSP via headers).")
    else: r.W("No CSP — GitHub Pages can't set headers, so add a <meta http-equiv=\"Content-Security-Policy\">.")

def main(argv=None):
    global ROOT
    p = argparse.ArgumentParser()
    p.add_argument("dir", nargs="?", default=".")
    p.add_argument("--repo-name", default=os.environ.get("REPO_NAME", ""))
    p.add_argument("--build-dir", default="")
    a = p.parse_args(argv)
    ROOT = os.path.abspath(a.dir)
    r = Report()
    print("== GitHub Pages shippability pre-flight ==\n   dir: %s\n   repo: %s\n" % (ROOT, a.repo_name or "(unknown — pass --repo-name)"))
    fw = check_static(ROOT, r)
    check_secrets(ROOT, r)
    check_asset_paths(ROOT, a.repo_name, fw, r)
    check_spa_routing(ROOT, r)
    check_nojekyll(ROOT, r)
    check_size(ROOT, r)
    check_sw(ROOT, r)
    check_mixed_content(ROOT, r)
    check_apple_csp(ROOT, r)

    for tag, items in (("FAIL", r.fail), ("WARN", r.warn), ("OK", r.ok), ("INFO", r.info)):
        for m in items:
            mark = {"FAIL": "❌", "WARN": "⚠️ ", "OK": "✅", "INFO": "ℹ️ "}[tag]
            print("%s %s" % (mark, m) if not m.startswith("    ") else m)
    verdict = "NO-GO" if r.fail else ("GO-WITH-FIXES" if r.warn else "GO")
    print("\n=> VERDICT: %s" % verdict)
    return 2 if r.fail else 0

if __name__ == "__main__":
    raise SystemExit(main())
