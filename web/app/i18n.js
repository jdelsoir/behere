/**
 * BeHERE language layer.
 *
 * Two jobs, kept separate on purpose:
 *
 *   1. resolveLabel() decides which STRING to show for one entity, and whether
 *      that string is a translation or a fallback. docs/CONTRACT.md section 9.
 *   2. The uiLang functions decide which LANGUAGE the interface is in. It
 *      defaults from the municipality under your feet, never from the browser
 *      locale, and a user override survives a reload. PLAN acceptance test 5.
 *
 * The rule that shapes everything here: street and place names are never
 * translated. A translated street name is a wrong street name when you ask a
 * local for directions. The resolver therefore falls back to the local
 * language rather than inventing English, and reports translated:false so the
 * UI can say so once, honestly, instead of pretending.
 *
 * Plain ES module. No build step, no dependencies.
 */

// --- constants -----------------------------------------------------------

/** Languages the interface itself ships in. DE is a resolver language only. */
export const UI_LANGS = ["nl", "fr", "en"];

/** All languages the resolver can read, including DE. */
export const RESOLVE_LANGS = ["nl", "fr", "de", "en"];

/**
 * Step 4's fixed order. Not arbitrary: it matches source coverage (NL missing
 * on 32.92% of streets, FR on 61.70%, DE on 99.24%), so it reaches a real
 * string soonest. Fixed order is also what makes the resolver deterministic.
 * docs/CONTRACT.md 9.2.
 */
export const FALLBACK_ORDER = ["nl", "fr", "de", "en"];

/** Statbel region codes. */
export const RGN_FLANDERS = "02000";
export const RGN_WALLONIA = "03000";
export const RGN_BRUSSELS = "04000";

/**
 * The German-speaking Community: nine municipalities, all in Liege province,
 * all inside the Walloon Region. docs/CONTRACT.md 4.1.
 * Amel, Bullingen, Butgenbach, Eupen, Kelmis, Lontzen, Raeren, Sankt Vith,
 * Burg-Reuland.
 */
export const DE_COMMUNITY = Object.freeze([
  "63001", "63012", "63013", "63023", "63040",
  "63048", "63061", "63067", "63087",
]);

const DE_SET = new Set(DE_COMMUNITY);

/**
 * Language a GTFS stop_name is authored in, per operator (docs/CONTRACT.md
 * 7.2: "stop_name verbatim, in the operator's authored language").
 *
 * nmbssncb is deliberately absent. NMBS authors station names in the language
 * of the station's own municipality ("Gent-Sint-Pieters", "Liege-Guillemins")
 * and bilingually in Brussels ("Brussel-Zuid/Bruxelles-Midi"), so its language
 * comes from the municipality, not from the operator. See entityFromStop().
 */
const STOP_NAME_LANG = { delijn: "nl", tec: "fr", stibmivb: "fr" };

/** localStorage key for the user's language override. */
export const LANG_STORE_KEY = "behere.uilang";

// --- small helpers -------------------------------------------------------

/** A usable authored string is a non-empty string. "" means "not authored". */
function authored(v) {
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * Substitute {placeholders}. Unknown placeholders are left intact rather than
 * replaced with "undefined", so a missing parameter is visible in review and
 * never produces a blank or a lie.
 * @param {string} text @param {Object} [params] @returns {string}
 */
export function format(text, params) {
  if (!params || typeof text !== "string") return text;
  return text.replace(/\{(\w+)\}/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m
  );
}

// --- which language is the interface in ----------------------------------

/**
 * The language names RESOLVE in, for a given municipality. This is a property
 * of the ground, not of the user: it is what step 3 of the resolver falls back
 * to. It is NOT the same thing as the UI language.
 *
 * Prefers the baked value in <nis>/meta.json.lang.default and derives it from
 * rgn + nis only as a fallback, so the two can never drift.
 *
 * @param {Object} [muntyMeta] <nis>/meta.json, or a municipalities.json record
 *                             plus a `nis` field.
 * @returns {"nl"|"fr"|"de"}
 */
export function regionDefaultLang(muntyMeta) {
  if (!muntyMeta) return "fr";
  const baked = muntyMeta.lang && muntyMeta.lang.default;
  if (baked === "nl" || baked === "fr" || baked === "de") return baked;
  if (muntyMeta.rgn === RGN_FLANDERS) return "nl";
  if (muntyMeta.rgn === RGN_BRUSSELS) return "fr";
  if (DE_SET.has(muntyMeta.nis)) return "de";
  return "fr";
}

/**
 * The official languages of a municipality, as an array.
 * Brussels returns two, and docs/CONTRACT.md 4.1 requires the UI to show both
 * names together when it does.
 * @param {Object} [muntyMeta] @returns {string[]}
 */
export function officialLangs(muntyMeta) {
  const baked = muntyMeta && muntyMeta.lang && muntyMeta.lang.official;
  if (Array.isArray(baked) && baked.length) return baked.slice();
  if (muntyMeta && muntyMeta.rgn === RGN_BRUSSELS) return ["fr", "nl"];
  return [regionDefaultLang(muntyMeta)];
}

/**
 * The UI language implied by standing in this municipality.
 *
 * PLAN section 5: "Default the UI language from the municipality the user is
 * standing in, not from the browser locale."
 *
 * The browser is consulted in exactly one place, and only as a tie-break:
 * Brussels is officially bilingual, so the ground alone does not decide
 * between FR and NL (docs/CONTRACT.md 4.1). Everywhere else the browser is
 * ignored outright.
 *
 * The nine German-speaking municipalities get "fr": DE is not one of the three
 * UI languages, and all nine sit in the Walloon Region. Their names still
 * resolve in German, because regionDefaultLang() stays "de" there, so a German
 * place name is shown as German with the endonym note rather than replaced.
 *
 * @param {Object} [muntyMeta]
 * @param {string[]} [navLangs] navigator.languages, or [] when unknown.
 * @returns {"nl"|"fr"|"en"}
 */
export function municipalityUiLang(muntyMeta, navLangs) {
  const prefs = normaliseNavLangs(navLangs);
  if (!muntyMeta) {
    // Outside the shipped municipalities: nothing on the ground to default
    // from, so and only so, fall back to the browser.
    for (const l of prefs) if (UI_LANGS.indexOf(l) >= 0) return l;
    return "en";
  }
  const rgn = muntyMeta.rgn;
  if (rgn === RGN_FLANDERS) return "nl";
  if (rgn === RGN_BRUSSELS) {
    for (const l of prefs) {
      if (l === "nl" || l === "fr") return l;
    }
    return "fr";
  }
  return "fr"; // Wallonia, German-speaking Community included
}

/** ["en-GB","nl"] -> ["en","nl"], lowercased, deduplicated. */
function normaliseNavLangs(navLangs) {
  const src =
    Array.isArray(navLangs) && navLangs.length
      ? navLangs
      : typeof navigator !== "undefined" && navigator.languages
      ? navigator.languages
      : [];
  const out = [];
  for (const raw of src) {
    if (typeof raw !== "string") continue;
    const base = raw.toLowerCase().split("-")[0];
    if (base && out.indexOf(base) < 0) out.push(base);
  }
  return out;
}

/**
 * The user's stored language override, or null when they have not chosen one.
 * Wrapped because Safari in private mode throws on localStorage access.
 * @returns {"nl"|"fr"|"en"|null}
 */
export function readStoredUiLang() {
  try {
    const v = globalThis.localStorage && globalThis.localStorage.getItem(LANG_STORE_KEY);
    return UI_LANGS.indexOf(v) >= 0 ? v : null;
  } catch (_) {
    return null;
  }
}

/**
 * Persist a language override so it survives a reload and a cold start.
 * Pass null or "auto" to clear it and go back to defaulting from the ground.
 * @param {"nl"|"fr"|"en"|"auto"|null} lang
 * @returns {boolean} true when the choice was actually stored.
 */
export function storeUiLang(lang) {
  try {
    const s = globalThis.localStorage;
    if (!s) return false;
    if (lang == null || lang === "auto") {
      s.removeItem(LANG_STORE_KEY);
      return true;
    }
    if (UI_LANGS.indexOf(lang) < 0) return false;
    s.setItem(LANG_STORE_KEY, lang);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * The language the interface should actually be in right now.
 * A stored user override always wins; otherwise the ground decides.
 *
 * @param {Object} [muntyMeta] @param {string[]} [navLangs]
 * @returns {{lang: "nl"|"fr"|"en", source: "user"|"municipality"|"browser"}}
 */
export function activeUiLang(muntyMeta, navLangs) {
  const stored = readStoredUiLang();
  if (stored) return { lang: stored, source: "user" };
  const lang = municipalityUiLang(muntyMeta, navLangs);
  return { lang, source: muntyMeta ? "municipality" : "browser" };
}

// --- the resolver --------------------------------------------------------

/**
 * How the UI should mark translated:false, per kind. docs/CONTRACT.md 9.3.
 *
 * "inline": a per-string marker. These kinds should have been curated, so a
 *           fallback is a real gap worth pointing at.
 * "note":   no per-string marker. Show ui["flag.endonym"] once per panel.
 *           In English every one of Ghent's 2,637 street names falls to step
 *           3; 2,637 inline markers would be the app complaining about its own
 *           policy. The note says the true thing once.
 *
 * @param {string} kind @returns {"inline"|"note"}
 */
export function markerPolicy(kind) {
  return kind === "munty" || kind === "cat" || kind === "ui" ? "inline" : "note";
}

/**
 * The inline marker itself, for the callers that hand back a STRING rather
 * than a DOM node.
 *
 * Entity labels are rendered as nodes, so they carry <sup class="untranslated">
 * and a title. Chrome strings are consumed as plain text by four band modules
 * with four different renderers, and threading nodes through all of them would
 * mean rewriting them; appending the same asterisk they already print is the
 * honest, mechanical equivalent. ui["flag.untranslated"] explains it once.
 *
 * PLAN acceptance test 4, second clause: "untranslated strings are visibly
 * marked". An English sentence standing in for a missing Dutch one is
 * untranslated, and until this existed it was invisible.
 */
export const UNTRANSLATED_MARK = " *";

/**
 * Append the marker unless the string is already marked or is blank.
 * @param {string} text @returns {string}
 */
export function markUntranslated(text) {
  if (typeof text !== "string" || text === "") return text;
  return text.endsWith(UNTRANSLATED_MARK) ? text : text + UNTRANSLATED_MARK;
}

/**
 * Resolve one label. docs/CONTRACT.md 9.1 and 9.2.
 *
 *   1. entity.name[uiLang]                      authored in the UI language
 *   2. ctx.override[kind][entity.id]            the curated list, EN only
 *   3. entity.name[ctx.regionDefault]           nl in Flanders, fr in Wallonia
 *   4. first non-empty of nl, fr, de, en        never blank
 *
 * Step 1 runs before step 2 so the curated override can never shadow an
 * authored name; it only ever fills a genuine hole.
 *
 * The override value "=" is an assertion, not a name: "reviewed, English keeps
 * the local official name". It resolves its TEXT through steps 3 and 4 but
 * reports translated:true, because a reviewed decision is not a fallback.
 * The returned `lang` stays the language the text really came from, so
 * `step === 2 && lang !== uiLang` is exactly "this is the local name, adopted
 * into English on review" and the UI can say so with ui["flag.endonym_adopted"]
 * rather than silently passing it off as a translation.
 *
 * @param {Object} entity
 * @param {Object} [entity.name] {nl?, fr?, de?, en?}. "" and undefined both
 *                               mean "not authored".
 * @param {string} [entity.id]   key into the curated override.
 * @param {"munty"|"street"|"sector"|"stop"|"poi"|"ui"|"cat"} kind
 * @param {"nl"|"fr"|"en"} uiLang
 * @param {Object} ctx
 * @param {Object} [ctx.override]      parsed web/data/i18n/en.json
 * @param {string} [ctx.overrideLang]  language that override is written in,
 *                                     default "en"
 * @param {"nl"|"fr"|"de"} [ctx.regionDefault] from <nis>/meta.json lang.default
 * @returns {{text: string, lang: string, translated: boolean, step: 1|2|3|4}}
 */
export function resolveLabel(entity, kind, uiLang, ctx) {
  const e = entity || {};
  const names = e.name || {};
  const c = ctx || {};
  const regionDefault = c.regionDefault || "fr";

  // 1. authored in the UI language.
  const direct = authored(names[uiLang]);
  if (direct !== null) {
    return { text: direct, lang: uiLang, translated: true, step: 1 };
  }

  // 2. the curated override.
  const ov = overrideValue(c, kind, e.id, uiLang);
  if (ov !== null) {
    if (ov === "=") {
      const base = fallbackChain(names, regionDefault, e.id);
      return { text: base.text, lang: base.lang, translated: true, step: 2 };
    }
    return { text: ov, lang: uiLang, translated: true, step: 2 };
  }

  // 3 and 4.
  return fallbackChain(names, regionDefault, e.id);
}

/**
 * Steps 3 and 4, shared with the "=" branch of step 2.
 * Never returns a blank text. PLAN acceptance test 4.
 */
function fallbackChain(names, regionDefault, id) {
  const regional = authored(names[regionDefault]);
  if (regional !== null) {
    return { text: regional, lang: regionDefault, translated: false, step: 3 };
  }
  for (const l of FALLBACK_ORDER) {
    const v = authored(names[l]);
    if (v !== null) return { text: v, lang: l, translated: false, step: 4 };
  }
  // The baker must never emit a record with no name in any language, and CI
  // gate 5 fails the build if one exists. At runtime we still refuse to return
  // a blank: show the id in brackets so the gap is reportable, not invisible.
  return { text: "[" + (id != null ? id : "?") + "]", lang: "?", translated: false, step: 4 };
}

/**
 * Look up the curated override.
 *
 * docs/CONTRACT.md 9.2 writes this as ctx.override[kind][entity.id][uiLang],
 * but the shipped file (section 8.3) stores a bare string per id, because it
 * is a single-language file: {"munty": {"44021": "Ghent"}}. Indexing that
 * string by "en" yields undefined, so both shapes are accepted. A bare string
 * is used only when uiLang matches the file's own language.
 *
 * @returns {string|null}
 */
function overrideValue(ctx, kind, id, uiLang) {
  if (!ctx.override || id == null) return null;
  const table = ctx.override[kind];
  if (!table) return null;
  const raw = table[id];
  if (typeof raw === "string") {
    const overrideLang = ctx.overrideLang || "en";
    if (uiLang !== overrideLang) return null;
    return raw === "" ? null : raw;
  }
  if (raw && typeof raw === "object") return authored(raw[uiLang]);
  return null;
}

/**
 * The official names of a municipality, side by side.
 *
 * docs/CONTRACT.md 4.1: when a municipality has more than one official
 * language, the UI shows both names together. Brussels ships ["fr","nl"], so
 * this returns Bruxelles and Brussel. Identical names collapse to one entry,
 * because "Anderlecht / Anderlecht" is noise.
 *
 * @param {Object} entity @param {Object} [muntyMeta]
 * @returns {{lang: string, text: string}[]}
 */
export function officialLabels(entity, muntyMeta) {
  const names = (entity && entity.name) || {};
  const out = [];
  const seen = new Set();
  for (const l of officialLangs(muntyMeta)) {
    const v = authored(names[l]);
    if (v === null || seen.has(v)) continue;
    seen.add(v);
    out.push({ lang: l, text: v });
  }
  return out;
}

// --- turning shipped records into resolver entities ----------------------

/**
 * A municipalities.json record, or a <nis>/meta.json, as a resolver entity.
 * @param {string} nis @param {Object} rec carries nl / fr / de, or a `name`
 * @returns {{id: string, name: Object}}
 */
export function entityFromMunicipality(nis, rec) {
  const src = (rec && rec.name) || rec || {};
  return { id: nis, name: { nl: src.nl, fr: src.fr, de: src.de } };
}

/**
 * One street out of a decoded <nis>/streets.json.
 * Street ids are national, so the id is passed through, but there is no
 * override table for streets and there never will be: street names are not
 * translated. The id only ever reaches the "[id]" guard in step 4.
 * @param {Object} streets parsed streets.json
 * @param {number} index   row index, not the street id
 * @param {number} [streetId]
 */
export function entityFromStreet(streets, index, streetId) {
  const pick = (l) => (streets && streets[l] ? streets[l][index] : undefined);
  return { id: streetId, name: { nl: pick("nl"), fr: pick("fr"), de: pick("de") } };
}

/**
 * A grid shard stop object as a resolver entity.
 *
 * `t` carries the operator's own AUTHORED translations (STIB 1,088 names,
 * NMBS 654, docs/CONTRACT.md 7.7). Those are the operator's words, not ours,
 * so they legitimately satisfy step 1.
 *
 * `n` is the untagged authored name. It is filed under the language the
 * operator authors in, and only into a slot the translations left empty, so a
 * real translation always wins. For NMBS, which has no single authoring
 * language, it is filed under the municipality's own language, which is how
 * NMBS names stations.
 *
 * @param {Object} stop  {o, i, n, t?}
 * @param {"nl"|"fr"|"de"} regionDefault
 */
export function entityFromStop(stop, regionDefault) {
  const s = stop || {};
  const name = {};
  if (s.t) for (const l of RESOLVE_LANGS) if (authored(s.t[l])) name[l] = s.t[l];
  const lang = STOP_NAME_LANG[s.o] || regionDefault || "fr";
  if (!authored(name[lang]) && authored(s.n)) name[lang] = s.n;
  return { id: s.i, name };
}

// --- bound instance ------------------------------------------------------

/**
 * Bind the resolver to a loaded set of files so the UI does not thread ctx
 * through every call site.
 *
 * `chrome` is {nl?, fr?, en?}, each the parsed i18n/<lang>.json. en.json is
 * both the English chrome file and the curated override; passing it as both is
 * intentional and costs nothing, since for uiLang "en" step 1 already hits and
 * step 2 is never reached for chrome keys.
 *
 * @param {Object} opts
 * @param {Object} opts.chrome           {nl?, fr?, en?} parsed i18n files
 * @param {Object} [opts.override]       parsed en.json
 * @param {"nl"|"fr"|"en"} [opts.uiLang]
 * @param {Object} [opts.muntyMeta]      current <nis>/meta.json
 * @param {string[]} [opts.navLangs]
 */
export function createI18n(opts) {
  const o = opts || {};
  const chrome = o.chrome || {};
  const state = {
    chrome,
    override: o.override || chrome.en || null,
    overrideLang: "en",
    muntyMeta: o.muntyMeta || null,
    navLangs: o.navLangs || null,
    uiLang: null,
    uiLangSource: "municipality",
  };

  // An explicit uiLang at construction behaves like a user override: it wins
  // over the ground, survives setMunicipality, and is cleared by setUiLang.
  let explicit = o.uiLang && UI_LANGS.indexOf(o.uiLang) >= 0 ? o.uiLang : null;

  function recompute() {
    if (explicit) {
      state.uiLang = explicit;
      state.uiLangSource = "explicit";
      return;
    }
    const a = activeUiLang(state.muntyMeta, state.navLangs);
    state.uiLang = a.lang;
    state.uiLangSource = a.source;
  }
  recompute();

  function ctx() {
    return {
      override: state.override,
      overrideLang: state.overrideLang,
      regionDefault: regionDefaultLang(state.muntyMeta),
    };
  }

  /** Chrome or category strings, resolved through the same four steps. */
  function group(groupName, key, kind, params) {
    const name = {};
    for (const l of RESOLVE_LANGS) {
      const doc = state.chrome[l];
      const g = doc && doc[groupName];
      if (g && authored(g[key])) name[l] = g[key];
    }
    const r = resolveLabel({ id: key, name }, kind, state.uiLang, ctx());
    return Object.assign({}, r, { text: format(r.text, params) });
  }

  return {
    /** @returns {"nl"|"fr"|"en"} */
    get lang() {
      return state.uiLang;
    },
    /** "user" | "municipality" | "browser" | "explicit" */
    get langSource() {
      return state.uiLangSource;
    },
    get regionDefault() {
      return regionDefaultLang(state.muntyMeta);
    },
    get muntyMeta() {
      return state.muntyMeta;
    },

    /** Position resolved to a new municipality: re-derive the default. */
    setMunicipality(muntyMeta) {
      state.muntyMeta = muntyMeta || null;
      recompute();
      return state.uiLang;
    },

    /** User picked a language, or "auto" to hand it back to the ground. */
    setUiLang(lang) {
      explicit = null;
      storeUiLang(lang);
      recompute();
      return state.uiLang;
    },

    /** Options for the switcher. NL, FR, EN plus auto. DE is never offered. */
    switcherOptions() {
      const opts_ = UI_LANGS.map((l) => ({
        value: l,
        label: group("ui", "lang." + l, "ui").text,
        selected: state.uiLangSource === "user" && state.uiLang === l,
      }));
      opts_.push({
        value: "auto",
        label: group("ui", "lang.auto", "ui").text,
        selected: state.uiLangSource !== "user",
      });
      return opts_;
    },

    /** Chrome string. Never blank. @returns {string} */
    t(key, params) {
      return group("ui", key, "ui", params).text;
    },
    /** Chrome string with its resolver result, for marker decisions. */
    tFull(key, params) {
      return group("ui", key, "ui", params);
    },

    /**
     * The chrome lookup a BAND module gets, marker included.
     *
     * Two rules the bands rely on, both load-bearing:
     *
     *   - a TOTAL miss returns the bare KEY, because every band treats
     *     `value === key` as "i18n knows nothing, use my own default", and
     *     "[key]" or "" would be rendered as if it were copy
     *   - a hit that the ACTIVE language does not carry (resolver step 3 or 4)
     *     comes back MARKED. markerPolicy("ui") is "inline", so an English
     *     sentence inside a Dutch interface is flagged rather than passed off
     *     as a translation. PLAN acceptance test 4, second clause.
     *
     * @param {string} key @param {Object} [params] @returns {string}
     */
    tBand(key, params) {
      const r = group("ui", key, "ui", params);
      const text = r && typeof r.text === "string" ? r.text : "";
      if (!text || text === "[" + key + "]") return key;
      return r.translated === false && markerPolicy("ui") === "inline"
        ? markUntranslated(text)
        : text;
    },

    /**
     * The chrome lookup the SHELL's own markup gets.
     *
     * Same rule, except a total miss falls back to the English already
     * authored into index.html rather than printing a key at the user. That
     * authored English is itself untranslated once the interface is not
     * English, so it is marked too, and `current` is un-marked first so a
     * repaint, and a switch back to English, are both idempotent.
     *
     * @param {string} key @param {string} current @returns {string}
     */
    tChrome(key, current) {
      const r = group("ui", key, "ui");
      const text = r && typeof r.text === "string" ? r.text : "";
      if (text && text !== "[" + key + "]") {
        return r.translated === false && markerPolicy("ui") === "inline"
          ? markUntranslated(text)
          : text;
      }
      const plain = typeof current === "string" && current.endsWith(UNTRANSLATED_MARK)
        ? current.slice(0, -UNTRANSLATED_MARK.length)
        : current;
      return state.uiLang === "en" ? plain : markUntranslated(plain);
    },
    /** Category label. @returns {string} */
    cat(key) {
      return group("cat", key, "cat").text;
    },
    catFull(key) {
      return group("cat", key, "cat");
    },

    /** Resolve any entity against the current UI language. */
    label(entity, kind) {
      return resolveLabel(entity, kind, state.uiLang, ctx());
    },

    /** Municipality name, override-aware. */
    municipality(nis, rec) {
      return resolveLabel(entityFromMunicipality(nis, rec), "munty", state.uiLang, ctx());
    },

    /** Both official names where there are two. */
    officialLabels(entity) {
      return officialLabels(entity, state.muntyMeta);
    },

    markerPolicy,

    /**
     * True when a panel of labels needs the single endonym note rather than
     * per-string markers. Feed it the resolver results you are about to draw.
     * @param {Array<{translated: boolean}>} results @param {string} kind
     */
    needsEndonymNote(results, kind) {
      if (markerPolicy(kind) !== "note") return false;
      return (results || []).some((r) => r && r.translated === false);
    },
  };
}
