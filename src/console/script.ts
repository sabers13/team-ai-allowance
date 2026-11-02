/**
 * Optional enhancement script, served at `/console.js`.
 *
 * Nothing here is required: every form posts and every page navigates without
 * it. The script only (1) applies the theme without a reload, (2) sends a
 * decision or a form post in the background and swaps the changed card, and
 * (3) refreshes the open-request counter every 15 seconds.
 *
 * The server answers a request carrying `X-TAA-Enhance: 1` with JSON:
 *   { ok, message, replace?: { selector, html }, openRequests?, secret? }
 * Any other request gets a normal 303 redirect, which is the no-JS path.
 */

export const CONSOLE_JS = `(function () {
  "use strict";

  var doc = document;

  function showToast(message, kind) {
    var host = doc.getElementById("toasts");
    if (!host) return;
    var toast = doc.createElement("div");
    toast.className = "toast toast--" + (kind || "success");
    toast.setAttribute("role", kind === "error" ? "alert" : "status");
    var text = doc.createElement("p");
    text.className = "toast__text";
    text.textContent = message;
    var close = doc.createElement("button");
    close.type = "button";
    close.className = "toast__close";
    close.setAttribute("aria-label", "Dismiss notification");
    close.textContent = "\\u00d7";
    close.addEventListener("click", function () { toast.remove(); });
    toast.appendChild(text);
    toast.appendChild(close);
    host.appendChild(toast);
    if (kind !== "error") {
      window.setTimeout(function () { toast.remove(); }, 6000);
    }
  }

  function setCount(value) {
    if (typeof value !== "number" || !isFinite(value)) return;
    var counters = doc.querySelectorAll("[data-open-count]");
    var previous = null;
    Array.prototype.forEach.call(counters, function (counter) {
      if (previous === null) previous = counter.textContent;
      counter.textContent = String(value);
      counter.hidden = value === 0;
    });
    var live = doc.getElementById("open-requests-live");
    if (live && previous !== null && previous !== String(value)) {
      live.textContent = value === 0
        ? "No open requests."
        : value + (value === 1 ? " open request." : " open requests.");
    }
  }

  function setWorking(form, button) {
    form.setAttribute("aria-busy", "true");
    var region = form.closest("[data-region]");
    if (region) region.setAttribute("aria-busy", "true");
    if (button) {
      if (!button.dataset.label) button.dataset.label = button.textContent || "Save";
      button.classList.add("button--working");
      button.setAttribute("aria-disabled", "true");
      button.disabled = true;
      button.textContent = "Working\\u2026";
    }
    var loading = doc.createElement("p");
    loading.className = "loading-inline";
    loading.setAttribute("role", "status");
    loading.setAttribute("data-loading", "true");
    var spinner = doc.createElement("span");
    spinner.className = "spinner";
    spinner.setAttribute("aria-hidden", "true");
    loading.appendChild(spinner);
    loading.appendChild(doc.createTextNode("Loading\\u2026"));
    form.appendChild(loading);
  }

  function clearWorking(form, button) {
    form.removeAttribute("aria-busy");
    var region = form.closest("[data-region]");
    if (region) region.removeAttribute("aria-busy");
    var loading = form.querySelector("[data-loading]");
    if (loading) loading.remove();
    if (button) {
      button.classList.remove("button--working");
      button.removeAttribute("aria-disabled");
      button.disabled = false;
      if (button.dataset.label) button.textContent = button.dataset.label;
    }
  }

  function applyPayload(payload) {
    if (payload && payload.replace && payload.replace.selector && typeof payload.replace.html === "string") {
      var nodes = doc.querySelectorAll(payload.replace.selector);
      Array.prototype.forEach.call(nodes, function (node) {
        var template = doc.createElement("template");
        template.innerHTML = payload.replace.html;
        var replacement = template.content.firstElementChild;
        if (replacement) node.replaceWith(replacement);
      });
    }
    if (payload && payload.removeSelector) {
      var removed = doc.querySelectorAll(payload.removeSelector);
      Array.prototype.forEach.call(removed, function (node) { node.remove(); });
    }
    if (payload && typeof payload.openRequests === "number") setCount(payload.openRequests);
    if (payload && payload.secret) {
      var secretHost = doc.getElementById("secret-host");
      if (secretHost) {
        secretHost.innerHTML = "";
        var title = doc.createElement("p");
        title.className = "banner__title";
        title.textContent = "Copy this secret now; it is shown once.";
        var block = doc.createElement("pre");
        block.className = "secret";
        block.textContent = payload.secret;
        secretHost.appendChild(title);
        secretHost.appendChild(block);
        secretHost.hidden = false;
      }
    }
  }

  function enhance(form, submitter) {
    var data = new URLSearchParams();
    new FormData(form).forEach(function (value, key) { data.append(key, value); });
    if (submitter && submitter.name) data.append(submitter.name, submitter.value);
    var button = submitter || form.querySelector("button[type=submit]");
    setWorking(form, button);
    fetch(form.getAttribute("action") || window.location.pathname, {
      method: "POST",
      body: data,
      credentials: "same-origin",
      headers: { "X-TAA-Enhance": "1", Accept: "application/json" }
    }).then(function (response) {
      var type = response.headers.get("content-type") || "";
      if (type.indexOf("application/json") === -1) {
        window.location.reload();
        return null;
      }
      return response.json().then(function (payload) {
        return { ok: response.ok && payload.ok !== false, payload: payload };
      });
    }).then(function (result) {
      if (!result) return;
      clearWorking(form, button);
      if (!result.ok) {
        showToast(result.payload.message || "That did not work. Nothing was changed.", "error");
        var error = form.querySelector(".form-error");
        if (!error) {
          error = doc.createElement("p");
          error.className = "form-error";
          error.setAttribute("role", "alert");
          form.insertBefore(error, form.firstChild);
        }
        error.textContent = result.payload.message || "That did not work. Nothing was changed.";
        return;
      }
      applyPayload(result.payload);
      showToast(result.payload.message || "Saved.", "success");
    }).catch(function () {
      clearWorking(form, button);
      showToast("The control service did not answer. Nothing was changed.", "error");
    });
  }

  doc.addEventListener("submit", function (event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    var submitter = event.submitter || null;

    if (form.matches("[data-theme-form]")) {
      event.preventDefault();
      var theme = submitter && submitter.value ? submitter.value : "system";
      doc.documentElement.setAttribute("data-theme", theme);
      if (theme === "system") {
        doc.cookie = "taa_theme=; Path=/; Max-Age=0; SameSite=Strict";
      } else {
        doc.cookie = "taa_theme=" + encodeURIComponent(theme) + "; Path=/; Max-Age=31536000; SameSite=Strict";
      }
      var details = form.closest("details");
      var label = details ? details.querySelector(".topbar__control-label") : null;
      var pretty = theme.charAt(0).toUpperCase() + theme.slice(1);
      if (label) label.textContent = pretty;
      if (details) {
        var summary = details.querySelector("summary");
        if (summary) summary.setAttribute("aria-label", "Theme: " + pretty);
        details.open = false;
      }
      showToast("Theme: " + theme + ".", "success");
      return;
    }

    if (form.matches("[data-enhance]")) {
      event.preventDefault();
      enhance(form, submitter);
    }
  });

  doc.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    Array.prototype.forEach.call(doc.querySelectorAll("details[open]"), function (details) {
      details.open = false;
      var summary = details.querySelector("summary");
      if (summary) summary.focus();
    });
    var toast = doc.querySelector(".toast");
    if (toast) toast.remove();
  });

  var counters = doc.querySelectorAll("[data-open-count]");
  if (counters.length > 0) {
    var refresh = function () {
      if (doc.hidden) return;
      fetch("/requests/count", { credentials: "same-origin", headers: { Accept: "application/json" } })
        .then(function (response) { return response.ok ? response.json() : null; })
        .then(function (payload) { if (payload && typeof payload.open === "number") setCount(payload.open); })
        .catch(function () {});
    };
    window.setInterval(refresh, 15000);
    doc.addEventListener("visibilitychange", function () { if (!doc.hidden) refresh(); });
  }
})();
`;
