#!/usr/bin/env python3
"""CI gate: every chrome string a band asks for exists in every shipped language.

PLAN acceptance test 4 has two clauses:

    "No UI string is ever blank. Untranslated strings are visibly marked."

The first clause was already met by the runtime fallbacks. The second was not:
a key that exists in NO i18n file falls all the way through to the band
module's own hardcoded English, which then renders inside a Dutch or French
interface with no marker at all, indistinguishable from a translation. That is
a silent failure, and a silent failure needs a build gate, not a code review.

So this script reads the keys the band modules actually ask for, straight out
of their source, and fails when one of them is missing from any of
web/data/i18n/{en,nl,fr}.json.

Where the keys come from
------------------------
  here.js    export const HERE_UI_DEFAULTS = { ... }
  zoom.js    export const ZOOM_UI_DEFAULTS = { ... }
  around.js  const COPY = { ... }
  go.js      t("key", "English fallback")   call sites
  now.js     t("key", "English fallback")   call sites
  main.js    chromeText("key", "English")   call sites
  index.html data-i18n="key"

A band that adds a key and forgets the translation now fails the build instead
of shipping unmarked English.

Standard library only. No pip, no node, nothing to install.

    python3 scripts/check_i18n.py            # exit 1 on any gap
    python3 scripts/check_i18n.py --list     # print the declared key inventory
"""
import argparse
import json
import os
import re
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(_HERE)
WEB = os.path.join(_REPO, "web")
I18N = os.path.join(WEB, "data", "i18n")

LANGS = ("en", "nl", "fr")

# Keys these tables hold that are NOT chrome: they are resolved through the
# `cat` group instead, or they are structural.
CAT_PREFIXES = ()


def brace_block(src, marker):
    """The `{...}` literal that follows `marker`, brace-matched."""
    i = src.find(marker)
    if i < 0:
        return None
    j = src.find("{", i)
    if j < 0:
        return None
    depth = 0
    for k in range(j, len(src)):
        if src[k] == "{":
            depth += 1
        elif src[k] == "}":
            depth -= 1
            if depth == 0:
                return src[j:k + 1]
    return None


_TOP_KEY = re.compile(r'^\s{2}"([^"]+)":', re.M)
_CALL_2 = re.compile(r'\bt\(\s*"([A-Za-z0-9._]+)"\s*,\s*\n?\s*"', re.S)
_CALL_1 = re.compile(r'\bt\(\s*"([A-Za-z0-9._]+)"\s*[),]')
_CHROME = re.compile(r'\bchromeText\(\s*"([A-Za-z0-9._]+)"')
_DATA_I18N = re.compile(r'data-i18n="([A-Za-z0-9._]+)"')


def read(path):
    with open(path, "r", encoding="utf-8") as fh:
        return fh.read()


def declared():
    """{key: [module, ...]} for every chrome key any shipped module asks for."""
    out = {}

    def add(key, where):
        out.setdefault(key, [])
        if where not in out[key]:
            out[key].append(where)

    tables = [
        ("app/here.js", "export const HERE_UI_DEFAULTS"),
        ("app/zoom.js", "export const ZOOM_UI_DEFAULTS"),
        ("app/around.js", "const COPY ="),
    ]
    for rel, marker in tables:
        path = os.path.join(WEB, rel)
        if not os.path.exists(path):
            continue
        block = brace_block(read(path), marker)
        if block is None:
            raise SystemExit("%s: could not find %s" % (rel, marker))
        for key in _TOP_KEY.findall(block):
            add(key, os.path.basename(rel))

    for rel in ("app/go.js", "app/now.js"):
        path = os.path.join(WEB, rel)
        if not os.path.exists(path):
            continue
        src = read(path)
        for key in _CALL_2.findall(src):
            add(key, os.path.basename(rel))
        for key in _CALL_1.findall(src):
            add(key, os.path.basename(rel))

    main = os.path.join(WEB, "app/main.js")
    if os.path.exists(main):
        for key in _CHROME.findall(read(main)):
            add(key, "main.js")

    for rel in ("index.html", "404.html", "offline.html"):
        path = os.path.join(WEB, rel)
        if not os.path.exists(path):
            continue
        for key in _DATA_I18N.findall(read(path)):
            add(key, rel)

    return out


def load_i18n():
    docs = {}
    for lang in LANGS:
        path = os.path.join(I18N, "%s.json" % lang)
        if not os.path.exists(path):
            raise SystemExit("missing i18n file: %s" % path)
        with open(path, "r", encoding="utf-8") as fh:
            docs[lang] = json.load(fh)
    return docs


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--list", action="store_true", help="print the key inventory")
    args = ap.parse_args(argv)

    keys = declared()
    docs = load_i18n()
    groups = {lang: docs[lang].get("ui", {}) for lang in LANGS}
    cats = {lang: docs[lang].get("cat", {}) for lang in LANGS}

    if args.list:
        for key in sorted(keys):
            print("%-30s %s" % (key, ",".join(sorted(keys[key]))))
        print("\n%d declared keys" % len(keys))

    problems = []

    # 1. every declared key is present in every language, and non-blank.
    for key in sorted(keys):
        where = ",".join(sorted(keys[key]))
        for lang in LANGS:
            value = groups[lang].get(key)
            if value is None:
                problems.append(
                    "%s: asked for by %s, missing from web/data/i18n/%s.json ui"
                    % (key, where, lang))
            elif not isinstance(value, str) or value == "":
                problems.append(
                    "%s: blank in web/data/i18n/%s.json ui" % (key, lang))

    # 2. parity: no language may carry a ui or cat key the others lack.
    for group_name, table in (("ui", groups), ("cat", cats)):
        union = set()
        for lang in LANGS:
            union |= set(table[lang])
        for key in sorted(union):
            missing = [lang for lang in LANGS if key not in table[lang]]
            if missing:
                problems.append("%s.%s: missing from %s"
                                % (group_name, key, ", ".join(missing)))

    # 3. no blank value anywhere in ui or cat, declared or not.
    for lang in LANGS:
        for group_name in ("ui", "cat"):
            for key, value in sorted(docs[lang].get(group_name, {}).items()):
                if not isinstance(value, str) or value == "":
                    problems.append("%s.%s is blank in %s.json"
                                    % (group_name, key, lang))

    # 4. placeholders must agree across languages: a translation that drops
    #    {n} silently loses a number.
    for key in sorted(set(groups["en"])):
        want = set(re.findall(r"\{(\w+)\}", groups["en"][key]))
        for lang in ("nl", "fr"):
            if key not in groups[lang]:
                continue
            got = set(re.findall(r"\{(\w+)\}", groups[lang][key]))
            if got != want:
                problems.append(
                    "%s: placeholders differ, en %s vs %s %s"
                    % (key, sorted(want) or "none", lang, sorted(got) or "none"))

    counts = ", ".join("%s ui %d / cat %d" % (l, len(groups[l]), len(cats[l]))
                       for l in LANGS)
    print("declared by band modules: %d keys" % len(keys))
    print("shipped: %s" % counts)

    if problems:
        print("\n%d i18n problem(s):" % len(problems))
        for p in problems:
            print("  " + p)
        return 1
    print("every declared key exists in en, nl and fr, non-blank, "
          "with matching placeholders.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
