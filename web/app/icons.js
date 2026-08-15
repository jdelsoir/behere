/**
 * BeHERE icons: inline SVG, no library, no sprite sheet, no external file.
 *
 * The Organic design system says "use Lucide icons at stroke-width 2.75". It
 * does not say ship Lucide. Six glyphs are what this UI actually draws, so the
 * six path definitions live here as text and nothing is fetched: no CDN, no
 * bundler, no icon font, and no second network round trip before the map can
 * say where you are.
 *
 * PROVENANCE, per icon, so any of these can be diffed against upstream:
 *
 *   map-pin        design/prototype/BeHERE Map.dc.html line 70, VERBATIM.
 *                  This is the pre-2024 Lucide map-pin with the inner circle at
 *                  r=2.5 rather than r=3. Upstream Lucide has since replaced the
 *                  outline with a longer bezier. The prototype's is what was
 *                  designed against and what ships; the difference is visible at
 *                  14 px, so this is deliberate, not stale.
 *   x              design/prototype/BeHERE Map.dc.html line 122, VERBATIM.
 *                  One merged path where upstream Lucide uses two; identical
 *                  rendering, four fewer bytes.
 *   chevron-right  lucide-icons/lucide icons/chevron-right.svg, verbatim.
 *   locate-fixed   lucide-icons/lucide icons/locate-fixed.svg, verbatim.
 *   layers         lucide-icons/lucide icons/layers.svg, verbatim.
 *   wifi-off       lucide-icons/lucide icons/wifi-off.svg, verbatim.
 *
 * LICENCE. The geometry is Lucide's. Both of Lucide's licences require their
 * notice to travel with any copy, so both are reproduced here rather than
 * linked; `chevron-right` and `x` are on Lucide's own Feather-derived list and
 * carry the MIT notice as well as the ISC one.
 *
 *   ISC License. Copyright (c) 2026 Lucide Icons and Contributors.
 *   The MIT License (MIT). Copyright (c) 2013-present Cole Bemis.
 *
 *   Permission to use, copy, modify, and/or distribute this software for any
 *   purpose with or without fee is hereby granted, provided that the above
 *   copyright notice and this permission notice appear in all copies. THE
 *   SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
 *   REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
 *   AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL,
 *   DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER
 *   RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF
 *   CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
 *   CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a
 *   copy of this software and associated documentation files (the "Software"),
 *   to deal in the Software without restriction, including without limitation
 *   the rights to use, copy, modify, merge, publish, distribute, sublicense,
 *   and/or sell copies of the Software, and to permit persons to whom the
 *   Software is furnished to do so, subject to the following conditions: the
 *   above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED
 *   "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
 *   NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
 *   PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
 *   HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
 *   ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
 *   CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * COLOUR is always `currentColor`. Never set a stroke attribute at the call
 * site: put `color:` on the parent in CSS and let the icon inherit. That is what
 * keeps the brand mark's cream glyph correct in both themes without a second
 * rule, and it is why no hex ever appears in this file.
 *
 * ACCESSIBILITY. Every icon in this app sits beside a text label or inside a
 * control that already has an `aria-label`, so the default is
 * `aria-hidden="true"` and `focusable="false"`. The second matters because IE
 * and old Edge put SVG in the tab order, and UI_SPEC section 3.6 requires the
 * map chrome to contribute exactly the tab stops it lists. Pass `label` only
 * when an icon is genuinely the whole meaning of a control.
 *
 * NO innerHTML. web/app/around.js states the rule for the whole app; this module
 * keeps it. The markup below is parsed once per icon by DOMParser and every
 * render is a cloneNode of that result, so the strings are data, never assigned
 * into the live document as HTML.
 *
 * Plain ES module, loaded directly by the browser. No build step.
 */

/**
 * Icon name to SVG inner markup, on a 24x24 viewBox.
 *
 * Well-formed XML: every element is closed, because these are parsed as
 * image/svg+xml rather than swept into an HTML parser. An unclosed tag here
 * fails loudly at first render instead of silently dropping a glyph.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const ICONS = Object.freeze({
  // Brand mark, top-left pill (UI_SPEC 3.4). 14 px on a 24 px accent circle.
  "map-pin":
    '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/>' +
    '<circle cx="12" cy="10" r="2.5"/>',

  // Panel close, `.btn.btn-secondary.btn-icon.panel-close` (UI_SPEC 2.3). 16 px.
  x: '<path d="M18 6 6 18M6 6l12 12"/>',

  // The `<details>` disclosure marker in the menu sheet. Rotate 90deg on open,
  // replacing the CSS border triangle app.css draws today.
  "chevron-right": '<path d="m9 18 6-6-6-6"/>',

  // `button#locate` (UI_SPEC 3.4), both in its "Find where I am" and its
  // "Back to where I am" state. Always paired with a visible text label.
  "locate-fixed":
    '<line x1="2" x2="5" y1="12" y2="12"/>' +
    '<line x1="19" x2="22" y1="12" y2="12"/>' +
    '<line x1="12" x2="12" y1="2" y2="5"/>' +
    '<line x1="12" x2="12" y1="19" y2="22"/>' +
    '<circle cx="12" cy="12" r="7"/>' +
    '<circle cx="12" cy="12" r="3"/>',

  // The collapsed layer chip below 560 px (UI_SPEC 2.4, priority 5), where the
  // three toggles fold into one `{n} layers` button.
  layers:
    '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/>' +
    '<path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/>' +
    '<path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/>',

  // `p#offline-bar` (UI_SPEC 3.5). The bar is a warn fill, and a fill alone is
  // a colour-only signal; the glyph is the non-colour half of the same message.
  "wifi-off":
    '<path d="M12 20h.01"/>' +
    '<path d="M8.5 16.429a5 5 0 0 1 7 0"/>' +
    '<path d="M5 12.859a10 10 0 0 1 5.17-2.69"/>' +
    '<path d="M19 12.859a10 10 0 0 0-2.007-1.523"/>' +
    '<path d="M2 8.82a15 15 0 0 1 4.177-2.643"/>' +
    '<path d="M22 8.82a15 15 0 0 0-11.288-3.764"/>' +
    '<path d="m2 2 20 20"/>',
});

const SVG_NS = "http://www.w3.org/2000/svg";

/** Organic's weight. Everything in this app is drawn at 2.75, per the guide. */
export const STROKE_WIDTH = "2.75";

/** Parsed geometry, one DOMParser call per icon for the life of the page. */
const shapes = new Map();

/**
 * The children of one icon, parsed once and cached.
 * @param {string} name
 * @returns {ChildNode[]}
 */
function geometry(name) {
  let kids = shapes.get(name);
  if (kids) return kids;

  const markup = ICONS[name];
  if (typeof markup !== "string") {
    throw new Error("icons.js: no icon named " + JSON.stringify(name));
  }
  const doc = new DOMParser().parseFromString(
    '<svg xmlns="' + SVG_NS + '">' + markup + "</svg>",
    "image/svg+xml",
  );
  // DOMParser reports XML errors as a document, not a throw. A malformed icon
  // must fail at the first render, not paint an empty box forever.
  if (doc.getElementsByTagName("parsererror").length) {
    throw new Error("icons.js: icon " + name + " is not well-formed XML");
  }
  kids = Array.prototype.slice.call(doc.documentElement.childNodes);
  shapes.set(name, kids);
  return kids;
}

/**
 * Render one icon as a live SVG element.
 *
 * @param {string} name    a key of ICONS
 * @param {number} [size]  edge length in CSS pixels (default 16)
 * @param {{label?: string, className?: string, strokeWidth?: number|string}} [opts]
 *        `label` gives the icon an accessible name and role="img"; omit it when
 *        the icon is decorative beside real text, which is the usual case.
 * @returns {SVGSVGElement}
 */
export function icon(name, size = 16, opts = {}) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", String(opts.strokeWidth ?? STROKE_WIDTH));
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  // Keeps the glyph out of the tab order in every engine (UI_SPEC 3.6).
  svg.setAttribute("focusable", "false");

  if (opts.label) {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", opts.label);
  } else {
    svg.setAttribute("aria-hidden", "true");
  }
  if (opts.className) svg.setAttribute("class", opts.className);

  for (const kid of geometry(name)) svg.appendChild(kid.cloneNode(true));
  return svg;
}

/**
 * Replace an element's contents with one icon. Convenience for the common
 * "put the glyph inside this button" call, without reaching for innerHTML.
 *
 * @param {Element} host
 * @param {string} name
 * @param {number} [size]
 * @param {object} [opts]
 * @returns {SVGSVGElement}
 */
export function setIcon(host, name, size = 16, opts = {}) {
  while (host.firstChild) host.removeChild(host.firstChild);
  const svg = icon(name, size, opts);
  host.appendChild(svg);
  return svg;
}
