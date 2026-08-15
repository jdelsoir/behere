/* Offline page behaviour.
 *
 * Classic script (the CSP is script-src 'self', and this page must work with
 * zero network, so nothing here is a module import).
 *
 * PLAN section 6 requires the offline fallback to serve the LAST-KNOWN
 * DEPARTURES with an explicit "as of" timestamp. main.js writes that snapshot
 * to localStorage on every successful live fetch; this reads it back. The
 * timestamp is never hidden and never rounded away: an old number presented as
 * current would be worse than no number.
 */
(function () {
  "use strict";

  var KEY = "behere.departures";

  document.getElementById("retry").addEventListener("click", function () {
    location.reload();
  });

  var raw = null;
  try { raw = localStorage.getItem(KEY); } catch (e) { raw = null; }
  if (!raw) return;

  var snap;
  try { snap = JSON.parse(raw); } catch (e) { return; }
  if (!snap || !Array.isArray(snap.items) || !snap.items.length) return;

  var list = document.getElementById("dep-list");
  var asof = document.getElementById("dep-asof");
  var empty = document.getElementById("dep-empty");

  for (var i = 0; i < snap.items.length; i++) {
    var d = snap.items[i] || {};
    var li = document.createElement("li");

    var name = document.createElement("span");
    name.className = "name";
    name.textContent = [d.stop, d.headsign || d.direction]
      .filter(Boolean).join(" → ") || String(d.name || "");

    var meta = document.createElement("span");
    meta.className = "meta";
    // go.js stores an ISO instant. Printing it raw would put
    // "2026-08-15T14:07:00.000Z" on screen next to a stop name, so it is
    // rendered as a clock time in the reader's own locale.
    meta.textContent = formatClock(d.time || d.when || "");
    if (d.cancelled) meta.setAttribute("data-cancelled", "true");

    li.appendChild(name);
    li.appendChild(meta);
    list.appendChild(li);
  }

  asof.textContent = "As of " + formatWhen(snap.as_of) +
    (snap.place ? ", " + snap.place : "") +
    ". These are the last times this device saw, not live times.";

  empty.hidden = true;
  asof.hidden = false;
  list.hidden = false;

  function formatClock(v) {
    if (!v) return "";
    var d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }

  function formatWhen(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    var mins = Math.round((Date.now() - d.getTime()) / 60000);
    var stamp = d.toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit"
    });
    if (mins < 1) return stamp + " (just now)";
    if (mins < 60) return stamp + " (" + mins + " min ago)";
    var hrs = Math.round(mins / 60);
    if (hrs < 48) return stamp + " (" + hrs + " h ago)";
    return stamp + " (" + Math.round(hrs / 24) + " days ago)";
  }
}());
