/* BeHERE — the DOM stub the browser-side tests share.
 *
 * There is no npm in this repo and never will be, so there is no jsdom. This is
 * a DOM small enough to read in one sitting and real enough to run web/app/*.js
 * unmodified: nodes, attributes, dataset, classList, a bubbling event
 * dispatcher, a small selector engine, an <img> that resolves or fails on
 * command, and hand-driven animation frames.
 *
 * TWO LAYERS, because two tests need different amounts of it:
 *
 *   installDom()   what scripts/test_map.mjs needs. map.js is HANDED its
 *                  container, so this layer only owes it createElement,
 *                  createElementNS and documentElement.
 *
 *   shellDom()     installDom plus everything the SHELL touches: a real <body>
 *                  parsed out of web/index.html, getElementById, a document
 *                  that listens, localStorage, geolocation, fetch off the disk,
 *                  DOMParser for icons.js and the handful of Node methods the
 *                  five band modules use. scripts/test_integration.mjs boots
 *                  web/app/main.js against this.
 *
 * It lives in one file so the unit test and the integration test cannot drift
 * into two different opinions about what a DOM is.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WEB = path.join(HERE, "..", "web");

function installDom(opts = {}) {
  const W = opts.w || 390, H = opts.h || 844;
  const requested = [];        // every tile URL map.js ever asked for

  class Style {
    constructor() { this._p = new Map(); }
    setProperty(k, v) { this._p.set(k, v); }
    getPropertyValue(k) { return this._p.get(k) || ""; }
  }

  let nextId = 1;
  class Node {
    constructor(tag, ns) {
      this.tagName = String(tag).toUpperCase();
      this.localName = String(tag);
      this.namespaceURI = ns || null;
      this.childNodes = [];
      this.parentNode = null;
      this.attributes = new Map();
      this.style = new Style();
      this.dataset = {};
      this._class = "";
      this._text = "";
      this._listeners = new Map();
      this._uid = nextId++;
      this.hidden = false;
    }
    get className() { return this._class; }
    set className(v) { this._class = String(v); }
    get classList() {
      const self = this;
      return {
        add(c) { if (!self._class.split(/\s+/).includes(c)) self._class = (self._class + " " + c).trim(); },
        remove(c) { self._class = self._class.split(/\s+/).filter((x) => x && x !== c).join(" "); },
        contains(c) { return self._class.split(/\s+/).includes(c); },
      };
    }
    get id() { return this.attributes.get("id") || ""; }
    set id(v) { this.attributes.set("id", v); }
    setAttribute(k, v) {
      this.attributes.set(k, String(v));
      if (k === "class") this._class = String(v);
      if (k.startsWith("data-")) {
        const camel = k.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase());
        this.dataset[camel] = String(v);
      }
    }
    getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
    removeAttribute(k) {
      this.attributes.delete(k);
      if (k.startsWith("data-")) {
        const camel = k.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase());
        delete this.dataset[camel];
      }
    }
    hasAttribute(k) { return this.attributes.has(k); }
    get firstChild() { return this.childNodes[0] || null; }
    get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
    appendChild(n) {
      if (n.parentNode) n.parentNode.removeChild(n);
      n.parentNode = this;
      this.childNodes.push(n);
      return n;
    }
    insertBefore(n, ref) {
      if (n.parentNode) n.parentNode.removeChild(n);
      n.parentNode = this;
      const i = ref ? this.childNodes.indexOf(ref) : -1;
      if (i < 0) this.childNodes.push(n); else this.childNodes.splice(i, 0, n);
      return n;
    }
    removeChild(n) {
      const i = this.childNodes.indexOf(n);
      if (i >= 0) this.childNodes.splice(i, 1);
      n.parentNode = null;
      return n;
    }
    get textContent() { return this._text; }
    set textContent(v) { this._text = String(v); }
    addEventListener(t, fn, o) {
      let s = this._listeners.get(t);
      if (!s) { s = []; this._listeners.set(t, s); }
      s.push({ fn, once: !!(o && o.once) });
    }
    removeEventListener(t, fn) {
      const s = this._listeners.get(t);
      if (s) this._listeners.set(t, s.filter((e) => e.fn !== fn));
    }
    dispatch(type, ev) {
      const e = Object.assign({ type, target: this, preventDefault() {} }, ev);
      // Real bubbling: the whole ancestor chain, target-first, with
      // currentTarget rewritten at each level, which is what delegated
      // listeners on an ancestor rely on.
      let n = this;
      while (n) {
        const s = n._listeners.get(type) || [];
        for (const entry of s.slice()) {
          entry.fn(Object.assign({}, e, { currentTarget: n }));
          if (entry.once) n.removeEventListener(type, entry.fn);
        }
        if (ev && ev.noBubble) break;
        n = n.parentNode;
      }
    }
    closest(sel) {
      let n = this;
      while (n) { if (matches(n, sel)) return n; n = n.parentNode; }
      return null;
    }
    querySelector(sel) {
      for (const c of this.childNodes) {
        if (matches(c, sel)) return c;
        const d = c.querySelector(sel);
        if (d) return d;
      }
      return null;
    }
    querySelectorAll(sel) {
      const out = [];
      for (const c of this.childNodes) {
        if (matches(c, sel)) out.push(c);
        out.push(...c.querySelectorAll(sel));
      }
      return out;
    }
    getBoundingClientRect() {
      if (this._rect) return this._rect;
      return { x: 0, y: 0, left: 0, top: 0, width: W, height: H, right: W, bottom: H };
    }
    setPointerCapture() {}
    releasePointerCapture() {}
  }

  class ImgNode extends Node {
    constructor() {
      super("img");
      this._src = "";
      this.complete = false;
      this.naturalWidth = 0;
    }
    get src() { return this._src; }
    set src(v) {
      this._src = String(v);
      if (v) requested.push(String(v));
    }
  }

  function matches(n, sel) {
    if (!n || !sel) return false;
    if (sel[0] === "#") return n.id === sel.slice(1);
    if (sel[0] === ".") return n._class.split(/\s+/).includes(sel.slice(1));
    return n.localName === sel;
  }

  const doc = {
    createElement(tag) { return tag === "img" ? new ImgNode() : new Node(tag); },
    createElementNS(ns, tag) { return new Node(tag, ns); },
    documentElement: new Node("html"),
  };

  // Frame and timer plumbing that the test can drive by hand.
  let rafId = 1;
  const rafs = new Map();
  const g = globalThis;
  // Save whatever was installed before, so a nested harness can hand the
  // globals back and the outer map keeps scheduling into its own frame queue.
  const saved = {};
  for (const k of ["document", "requestAnimationFrame", "cancelAnimationFrame",
                   "matchMedia", "navigator", "window", "ResizeObserver"]) {
    saved[k] = g[k];
  }
  g.document = doc;
  g.requestAnimationFrame = (fn) => { const id = rafId++; rafs.set(id, fn); return id; };
  g.cancelAnimationFrame = (id) => { rafs.delete(id); };
  g.matchMedia = (q) => ({ matches: !!(opts.media && opts.media[q]), media: q,
                           addEventListener() {}, removeEventListener() {} });
  const nav = { connection: opts.saveData ? { saveData: true } : undefined, onLine: true };
  try { g.navigator = nav; }
  catch (e) { Object.defineProperty(g, "navigator", { value: nav, configurable: true, writable: true }); }
  g.window = { addEventListener() {}, removeEventListener() {} };
  if (opts.noResizeObserver !== true) {
    g.ResizeObserver = class { constructor(fn) { this.fn = fn; } observe() {} disconnect() {} };
  } else {
    delete g.ResizeObserver;
  }
  if (!g.performance) { try { g.performance = { now: () => Date.now() }; } catch (e) {} }

  return {
    doc,
    Node,
    requested,
    makeContainer() {
      const c = new Node("div");
      c._rect = { x: 0, y: 0, left: 0, top: 0, width: W, height: H, right: W, bottom: H };
      return c;
    },
    /** Run every pending animation frame, repeatedly, until quiet. */
    flush(max = 20) {
      let n = 0;
      while (rafs.size && n < max) {
        const batch = Array.from(rafs.entries());
        rafs.clear();
        for (const [, fn] of batch) fn(performance.now());
        n++;
      }
      return n;
    },
    pendingFrames() { return rafs.size; },
    restore() {
      for (const k of Object.keys(saved)) {
        try { g[k] = saved[k]; }
        catch (e) { Object.defineProperty(g, k, { value: saved[k], configurable: true, writable: true }); }
      }
    },
  };
}

export { installDom };


/* ======================================================================== */
/* shellDom: installDom, plus what web/app/main.js and the five bands need.  */
/* ======================================================================== */

/* index.html is hand-written, well-formed, carries no <script> body, no CDATA
   and no exotic entities, so a tag/text tokeniser is enough. */
const VOID_TAGS = new Set(["meta", "link", "br", "hr", "img", "input", "source",
                           "area", "base", "col", "embed", "param", "track", "wbr"]);

/** One simple selector: tag, #id, .class and [attr] / [attr="v"], compounded. */
function simpleMatch(n, sel) {
  if (!n || !n.localName) return false;
  if (sel === "*") return true;
  const re = /([#.]?[\w-]+)|(\[[^\]]+\])/g;
  let m;
  while ((m = re.exec(sel))) {
    const tok = m[0];
    if (tok[0] === "#") { if (n.getAttribute("id") !== tok.slice(1)) return false; }
    else if (tok[0] === ".") {
      if (!String(n.className).split(/\s+/).includes(tok.slice(1))) return false;
    } else if (tok[0] === "[") {
      const a = /\[([\w-]+)(?:([~^$*|]?=)"?'?([^\]"']*)"?'?)?\]/.exec(tok);
      if (!a) return false;
      const have = n.getAttribute(a[1]);
      if (a[2] === undefined) { if (have === null) return false; }
      else if (have !== a[3]) return false;
    } else if (tok !== n.localName) return false;
  }
  return true;
}

/** A selector list with descendant combinators. No child or sibling
 *  combinators: nothing in web/app/ uses one. */
function selMatch(n, sel) {
  for (const group of String(sel).split(",")) {
    const parts = group.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    if (!simpleMatch(n, parts[parts.length - 1])) continue;
    let node = n.parentNode, i = parts.length - 2, all = true;
    while (i >= 0) {
      let found = false;
      while (node) {
        if (simpleMatch(node, parts[i])) { found = true; node = node.parentNode; break; }
        node = node.parentNode;
      }
      if (!found) { all = false; break; }
      i--;
    }
    if (all) return true;
  }
  return false;
}

/**
 * Boot a DOM carrying the real web/index.html body, with the browser APIs the
 * shell needs.
 *
 * @param {Object} [opts] passed through to installDom
 * @returns {Object} the installDom handle, plus {doc, Node, body, fetched,
 *                   geoWatchers, errors, store, parseHtml}
 */
export function shellDom(opts = {}) {
  const h = installDom(opts);
  const doc = h.doc;
  const Node = Object.getPrototypeOf(h.makeContainer()).constructor;
  const proto = Object.getPrototypeOf(h.makeContainer());

  /* --- the Node methods map.js never needed and the bands do -------------- */
  proto.querySelector = function (sel) {
    for (const c of this.childNodes) {
      if (selMatch(c, sel)) return c;
      const d = c.querySelector(sel);
      if (d) return d;
    }
    return null;
  };
  proto.querySelectorAll = function (sel) {
    const out = [];
    const walk = (n) => { for (const c of n.childNodes) { if (selMatch(c, sel)) out.push(c); walk(c); } };
    walk(this);
    return out;
  };
  proto.matches = function (sel) { return selMatch(this, sel); };
  proto.closest = function (sel) {
    let n = this;
    while (n) { if (selMatch(n, sel)) return n; n = n.parentNode; }
    return null;
  };
  proto.contains = function (other) {
    let n = other;
    while (n) { if (n === this) return true; n = n.parentNode; }
    return false;
  };
  proto.cloneNode = function (deep) {
    const c = new Node(this.localName, this.namespaceURI);
    for (const [k, v] of this.attributes) c.setAttribute(k, v);
    c._class = this._class; c._text = this._text; c.hidden = this.hidden;
    if (deep) for (const k of this.childNodes) c.appendChild(k.cloneNode(true));
    return c;
  };
  proto.replaceChild = function (nw, old) {
    const i = this.childNodes.indexOf(old);
    if (i < 0) return old;
    if (nw.parentNode) nw.parentNode.removeChild(nw);
    nw.parentNode = this; this.childNodes[i] = nw; old.parentNode = null;
    return old;
  };
  proto.replaceChildren = function (...kids) {
    for (const c of this.childNodes.slice()) this.removeChild(c);
    for (const k of kids) this.appendChild(k);
  };
  proto.remove = function () { if (this.parentNode) this.parentNode.removeChild(this); };
  proto.append = function (...kids) { for (const k of kids) this.appendChild(k); };
  proto.focus = function () { doc.activeElement = this; };
  proto.scrollIntoView = function () {};
  proto.dispatchEvent = function (e) { this.dispatch(e.type, { detail: e.detail }); return true; };
  proto.getBoundingClientRect = function () {
    return this._rect ||
      { x: 0, y: 0, left: 0, top: 0, width: 390, height: 120, right: 390, bottom: 120 };
  };
  Object.defineProperty(proto, "children", {
    get() { return this.childNodes.filter((c) => c.localName && c.localName !== "#text"); },
    configurable: true,
  });
  Object.defineProperty(proto, "value", {
    get() { return this._value !== undefined ? this._value : (this.getAttribute("value") || ""); },
    set(v) { this._value = String(v); },
    configurable: true,
  });

  /* --- the parser -------------------------------------------------------- */
  function parseHtml(src, into) {
    src = src.replace(/<!--[\s\S]*?-->/g, "");
    const stack = [into];
    const re = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
    let m;
    while ((m = re.exec(src))) {
      const [, close, tag, attrs, selfclose, text] = m;
      const top = stack[stack.length - 1];
      if (text !== undefined) {
        const t = text.replace(/\s+/g, " ");
        if (t.trim() && top !== into) top._text = (top._text + t).trim();
        continue;
      }
      const name = tag.toLowerCase();
      if (close) {
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i].localName === name) { stack.length = i; break; }
        }
        continue;
      }
      const el = new Node(name);
      const are = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      let a;
      while ((a = are.exec(attrs || ""))) {
        const key = a[1];
        const val = a[2] !== undefined ? a[2]
          : a[3] !== undefined ? a[3]
            : a[4] !== undefined ? a[4] : "";
        if (key === "hidden") el.hidden = true; else el.setAttribute(key, val);
      }
      top.appendChild(el);
      if (!VOID_TAGS.has(name) && !selfclose) stack.push(el);
    }
  }

  /* --- the document ------------------------------------------------------ */
  const body = new Node("body");
  body._rect = { x: 0, y: 0, left: 0, top: 0, width: 390, height: 844, right: 390, bottom: 844 };
  doc.documentElement.appendChild(body);
  doc.body = body;
  doc.createTextNode = (t) => { const n = new Node("#text"); n._text = String(t); return n; };
  doc.createDocumentFragment = () => new Node("#fragment");
  doc.getElementById = (id) => body.querySelector("#" + id);
  doc.querySelector = (s) => (s === "body" ? body : body.querySelector(s));
  doc.querySelectorAll = (s) => body.querySelectorAll(s);
  doc.addEventListener = (t, fn) => body.addEventListener(t, fn);
  doc.removeEventListener = (t, fn) => body.removeEventListener(t, fn);
  doc.dispatchEvent = (e) => { body.dispatch(e.type, { detail: e.detail }); return true; };

  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  parseHtml(html.slice(html.indexOf("<body>") + 6, html.lastIndexOf("</body>")), body);

  /* --- the rest of the platform ------------------------------------------ */
  const g = globalThis;
  const store = new Map();
  g.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  g.CustomEvent = class {
    constructor(t, o) { this.type = t; this.detail = o && o.detail; this.bubbles = !!(o && o.bubbles); }
  };
  g.MutationObserver = class { constructor(fn) { this.fn = fn; } observe() {} disconnect() {} };
  g.DOMParser = class {
    parseFromString(src) {
      const root = new Node("svg");
      parseHtml(src.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, ""), root);
      return { documentElement: root, getElementsByTagName: (t) => root.querySelectorAll(t) };
    }
  };
  g.AbortController = g.AbortController || class { constructor() { this.signal = {}; } abort() {} };

  const geoWatchers = [];
  const nav = {
    onLine: true, language: "en", languages: ["en"],
    userAgent: "behere-integration-smoke", maxTouchPoints: 0,
    geolocation: {
      watchPosition(okFn, errFn) { geoWatchers.push({ okFn, errFn }); return geoWatchers.length; },
      clearWatch() {},
    },
    permissions: { query: async () => ({ state: "prompt" }) },
    serviceWorker: undefined,
  };
  try { g.navigator = nav; }
  catch (e) { Object.defineProperty(g, "navigator", { value: nav, configurable: true, writable: true }); }
  g.window = {
    addEventListener() {}, removeEventListener() {},
    matchMedia: (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }),
  };
  g.matchMedia = g.window.matchMedia;

  /* Every read is served off the disk under web/, so the smoke exercises the
     REAL baked shards and the real join spine. A remote host 404s, which is
     what an offline device sees and what the bands must degrade against. */
  const fetched = [];
  g.fetch = async (url) => {
    const u = String(url);
    fetched.push(u);
    let file;
    if (u.startsWith("file://")) file = decodeURIComponent(u.slice(7).split("?")[0]);
    else if (/^https?:\/\//.test(u)) file = null;
    else file = path.join(WEB, u.replace(/^\.\//, "").split("?")[0]);
    if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return { ok: false, status: 404, url: u, headers: { get: () => null },
               async json() { throw new Error("404"); }, async text() { return ""; } };
    }
    const buf = fs.readFileSync(file);
    return {
      ok: true, status: 200, url: u, headers: { get: () => null },
      async json() { return JSON.parse(buf.toString("utf8")); },
      async text() { return buf.toString("utf8"); },
      async arrayBuffer() { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); },
    };
  };

  return Object.assign(h, { doc, Node, body, store, fetched, geoWatchers, parseHtml });
}
