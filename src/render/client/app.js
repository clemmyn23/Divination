// Runs in the page. Inlined into <head> by src/render/page.ts; never loaded from a URL.
// It runs before the body exists, so anything that needs a button waits for the page.
//
// The only requests it makes are to the local server that served the page. It asks for an
// LLM call in exactly one place: when a button marked data-enrich is pressed.

(() => {
  // ---- Theme: the browser's business only ----

  const THEMES = ["auto", "light", "dark"];
  const LABELS = { auto: "◐ Auto", light: "☀ Light", dark: "☾ Dark" };
  const THEME_KEY = "divination-theme";
  const root = document.documentElement;

  function savedTheme() {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      return THEMES.includes(saved) ? saved : "auto";
    } catch {
      return "auto";
    }
  }

  // "auto" leaves the choice to the system; "light" and "dark" force it.
  function applyTheme(theme) {
    if (theme === "auto") delete root.dataset.theme;
    else root.dataset.theme = theme;
    const toggle = document.getElementById("theme-toggle");
    if (toggle) toggle.textContent = LABELS[theme];
  }

  let theme = savedTheme();
  applyTheme(theme); // sets the theme before anything is drawn

  // ---- The local server: live updates, refresh, and the sparkle buttons ----

  const POLL_MS = 3000;
  const el = (id) => document.getElementById(id);
  const enrichButtons = () => document.querySelectorAll("button[data-enrich]");

  let online = false;
  let seenRenderedAt = null; // the page file's timestamp when this page was loaded
  let seenStartedAt = null; // when the server that this page first heard from started
  let lastFinishedAt = null; // when the last job we know of finished
  let pending = null; // { button, label, since }: a sparkle button waiting on its job

  function setStatus(text) {
    const status = el("live-status");
    if (status) status.textContent = text;
  }

  function clock(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  }

  function restorePending() {
    if (!pending) return;
    pending.button.textContent = pending.label;
    pending.button.disabled = false;
    pending = null;
  }

  // Draw what the server says.
  function show(status) {
    online = true;

    // A newer page exists, or the server restarted and this page's token is no longer good.
    const changed =
      (seenRenderedAt !== null && status.renderedAt !== seenRenderedAt) ||
      (seenStartedAt !== null && status.startedAt !== seenStartedAt);
    seenRenderedAt = status.renderedAt;
    seenStartedAt = status.startedAt;
    if (changed) {
      location.reload();
      return;
    }

    const busy = status.job !== null;
    const finishedAt = status.lastJob ? status.lastJob.finishedAt : null;

    // The pressed button's job is over and the page did not change: give the button back.
    if (pending && !busy && finishedAt !== pending.since) restorePending();
    lastFinishedAt = finishedAt;

    const toggle = el("live-toggle");
    if (toggle) {
      toggle.disabled = false;
      toggle.textContent = status.live ? "Pause" : "Start";
    }
    const refresh = el("refresh-now");
    if (refresh) refresh.disabled = busy;
    for (const button of enrichButtons()) {
      if (!pending || button !== pending.button) button.disabled = busy;
    }

    if (busy) setStatus(status.job.name.startsWith("enrich") ? "asking Claude…" : "updating…");
    else if (status.lastJob && !status.lastJob.ok) setStatus(`failed: ${status.lastJob.error}`);
    else if (!status.live) setStatus("paused");
    else setStatus(status.nextTickAt ? `next update ${clock(status.nextTickAt)}` : "live");
  }

  // The page was opened as a file, or the server has stopped.
  function showOffline() {
    online = false;
    restorePending();
    for (const id of ["live-toggle", "refresh-now"]) {
      const button = el(id);
      if (button) button.disabled = true;
    }
    for (const button of enrichButtons()) button.disabled = true;
    setStatus("server not running");
  }

  async function poll() {
    try {
      const res = await fetch("/api/status");
      if (!res.ok) throw new Error(String(res.status));
      show(await res.json());
    } catch {
      showOffline();
    }
  }

  // Every action goes out with the token the server put in this page.
  async function post(path, body) {
    const token = document.querySelector('meta[name="divination-token"]')?.content ?? "";
    return fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-divination-token": token },
      body: JSON.stringify(body ?? {}),
    });
  }

  async function act(path, body) {
    try {
      const res = await post(path, body);
      if (res.status === 409) {
        setStatus("busy, try again in a moment");
        return false;
      }
      if (!res.ok) {
        setStatus(`the server said no (${res.status})`);
        return false;
      }
      show(await res.json());
      return true;
    } catch {
      showOffline();
      return false;
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    applyTheme(theme); // labels the button once it exists
    poll();
    setInterval(poll, POLL_MS);
  });

  document.addEventListener("click", async (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    if (target.closest("#theme-toggle")) {
      theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
      try {
        localStorage.setItem(THEME_KEY, theme);
      } catch {
        // Storage can be blocked; the choice then lasts until the page reloads.
      }
      applyTheme(theme);
      return;
    }

    const copy = target.closest("button[data-copy]");
    if (copy) {
      const label = copy.textContent;
      try {
        await navigator.clipboard.writeText(copy.dataset.copy ?? "");
        copy.textContent = "Copied";
      } catch {
        copy.textContent = "Copy failed";
      }
      setTimeout(() => {
        copy.textContent = label;
      }, 1500);
      return;
    }

    if (!online) return; // everything below needs the server

    const liveToggle = target.closest("#live-toggle");
    if (liveToggle) {
      await act("/api/live", { on: liveToggle.textContent === "Start" });
      return;
    }

    if (target.closest("#refresh-now")) {
      await act("/api/tick");
      return;
    }

    // The one place an LLM call is ever asked for.
    const enrich = target.closest("button[data-enrich]");
    if (enrich && !pending) {
      pending = { button: enrich, label: enrich.textContent, since: lastFinishedAt };
      enrich.textContent = "Asking Claude…";
      enrich.disabled = true;
      const started = await act("/api/enrich", { enricher: enrich.dataset.enrich, key: enrich.dataset.key });
      if (!started) restorePending();
    }
  });
})();
