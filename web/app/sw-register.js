/* Service worker registration.
 *
 * This is a separate file rather than an inline <script> for one reason: the
 * CSP in index.html is script-src 'self' with no 'unsafe-inline', and GitHub
 * Pages cannot send headers, so a nonce is impossible. An inline registration
 * block would simply be blocked. Classic script, deferred, no module needed.
 *
 * Behaviour follows the template: register, watch for an update, and PROMPT
 * before reloading (never auto-skip-waiting: a silent swap can leave a page
 * loaded by the old version talking to the new worker). The reload-loop guard
 * on controllerchange is mandatory.
 */
(function () {
  "use strict";

  if (!("serviceWorker" in navigator)) return;

  window.addEventListener("load", function () {
    // updateViaCache:'none' — Pages forces Cache-Control: max-age=600 on every
    // file and offers no override, so this is the only way to be sure an update
    // check fetches a fresh sw.js.
    var swUrl = new URL("sw.js", document.baseURI).href;

    navigator.serviceWorker.register(swUrl, { updateViaCache: "none" })
      .then(function (reg) {
        reg.addEventListener("updatefound", function () {
          var sw = reg.installing;
          if (!sw) return;
          sw.addEventListener("statechange", function () {
            // controller present => this is an update, not a first install.
            if (sw.state === "installed" && navigator.serviceWorker.controller) {
              offerUpdate(reg);
            }
          });
        });
      })
      .catch(function (err) {
        // A failed registration must never break the app: everything except
        // offline still works without a worker.
        console.warn("BeHERE: service worker registration failed", err);
      });

    var refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (refreshing) return;
      refreshing = true;
      location.reload();
    });
  });

  function offerUpdate(reg) {
    var bar = document.createElement("div");
    bar.className = "notice";
    bar.id = "update-bar";

    var msg = document.createElement("p");
    msg.textContent = "A new version of BeHERE is ready.";

    var go = document.createElement("button");
    go.type = "button";
    go.className = "btn";
    go.textContent = "Reload";
    go.addEventListener("click", function () {
      if (reg.waiting) {
        reg.waiting.postMessage("SKIP_WAITING");
      } else {
        location.reload();
      }
    });

    var later = document.createElement("button");
    later.type = "button";
    later.className = "btn secondary";
    later.textContent = "Later";
    later.addEventListener("click", function () { bar.remove(); });

    bar.appendChild(msg);
    bar.appendChild(go);
    bar.appendChild(later);

    var anchor = document.querySelector("main");
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(bar, anchor);
    } else {
      document.body.appendChild(bar);
    }
  }
}());
