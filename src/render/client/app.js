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
  const FAST_POLL_MS = 1000;
  const el = (id) => document.getElementById(id);
  const enrichButtons = () => document.querySelectorAll("button[data-enrich]");
  const ticks = () => document.querySelectorAll("button[data-done]");

  // ---- Keeping my place across a reload: each panel's scroll position and its open folds ----

  const VIEW_KEY = "divination-view";
  const panelOf = (element) => element.closest(".panel")?.id;

  function rememberView() {
    try {
      const scroll = {};
      for (const body of document.querySelectorAll(".panel-body")) {
        const id = panelOf(body);
        if (id && body.scrollTop > 0) scroll[id] = body.scrollTop;
      }
      const open = [];
      for (const fold of document.querySelectorAll("details.stale")) {
        const id = panelOf(fold);
        if (id && fold.open) open.push(`${id}:${fold.className}`);
      }
      sessionStorage.setItem(VIEW_KEY, JSON.stringify({ scroll, open }));
    } catch {
      // Storage can be blocked; the page then reloads from the top.
    }
  }

  function restoreView() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(VIEW_KEY) ?? "null");
      if (!saved) return;
      // Folds first: opening one changes how far its panel can scroll.
      for (const fold of document.querySelectorAll("details.stale")) {
        if ((saved.open ?? []).includes(`${panelOf(fold)}:${fold.className}`)) fold.open = true;
      }
      for (const body of document.querySelectorAll(".panel-body")) {
        const top = (saved.scroll ?? {})[panelOf(body)];
        if (typeof top === "number") body.scrollTop = top;
      }
    } catch {
      // Nothing usable was remembered.
    }
  }

  function reload() {
    rememberView();
    location.reload();
  }

  let online = false;
  let seenRenderedAt = null; // the page file's timestamp when this page was loaded
  let seenStartedAt = null; // when the server that this page first heard from started
  let lastFinishedAt = null; // when the last job we know of finished
  let pending = null; // { button, label, since }: a sparkle button waiting on its job
  let working = false; // a refresh or a Claude call is running

  function setStatus(text) {
    const status = el("live-status");
    if (status) status.textContent = text;
  }

  function clock(ms, withSeconds = false) {
    return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", ...(withSeconds ? { second: "2-digit" } : {}), hour12: false });
  }

  function seconds(ms) {
    const s = ms / 1000;
    return `${s >= 10 ? Math.round(s) : Math.round(s * 10) / 10} s`;
  }

  // ---- Activity: a breakdown of each source on hover, and the log behind a click ----

  // One line per source: is it being read, when was it last read, or why did it fail.
  function breakdown(sources) {
    const width = Math.max(0, ...sources.map((s) => s.title.length));
    return sources
      .map((s) => {
        const name = s.title.padEnd(width);
        if (s.state === "running") return `… ${name}  reading…`;
        if (s.state === "failed") return `✗ ${name}  failed: ${s.error ?? "unknown error"}`;
        if (!s.at) return `✓ ${name}  never read`;
        if (s.byHand) return `✓ ${name}  read by hand at ${clock(s.at)}`;
        return `✓ ${name}  updated ${clock(s.at)}${typeof s.ms === "number" ? ` in ${seconds(s.ms)}` : ""}`;
      })
      .join("\n");
  }

  const logIsOpen = () => Boolean(el("activity-log")?.open);

  // Each entry is a time and a line; an error is flagged, and any detail lines keep their place under it.
  async function loadLog() {
    const lines = el("activity-lines");
    if (!lines) return;
    try {
      const res = await fetch("/api/activity");
      if (!res.ok) throw new Error(String(res.status));
      const entries = (await res.json()).lines ?? [];
      lines.textContent =
        entries.length === 0
          ? "Nothing has happened since the server started."
          : entries
              .map((entry) => {
                const [first, ...rest] = entry.text.split("\n");
                const head = `${clock(entry.at, true)} ${entry.level === "error" ? "! " : " "}${first}`;
                return [head, ...rest.map((line) => `${" ".repeat(10)}${line}`)].join("\n");
              })
              .join("\n");
      if (typeof lines.scrollHeight === "number") lines.scrollTop = lines.scrollHeight; // newest is last
    } catch {
      lines.textContent = "The server is not running, so there is no log to show.";
    }
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
      reload();
      return;
    }

    const busy = status.job !== null;
    working = busy;
    const sources = status.sources ?? [];
    const pop = el("activity-pop");
    if (pop) pop.textContent = breakdown(sources);
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
    for (const button of ticks()) button.disabled = false;

    const reading = sources.filter((s) => s.state === "running").map((s) => s.title);
    if (busy) setStatus(status.job.name.startsWith("enrich") ? "asking Claude…" : `updating…${reading.length > 0 ? ` ${reading.join(", ")}` : ""}`);
    else if (status.lastJob && !status.lastJob.ok) setStatus(`failed: ${status.lastJob.error}`);
    else if (!status.live) setStatus("paused");
    else setStatus(status.nextTickAt ? `next update ${clock(status.nextTickAt)}` : "live");
  }

  // The page was opened as a file, or the server has stopped.
  function showOffline() {
    online = false;
    working = false;
    restorePending();
    for (const id of ["live-toggle", "refresh-now"]) {
      const button = el(id);
      if (button) button.disabled = true;
    }
    for (const button of enrichButtons()) button.disabled = true;
    for (const button of ticks()) button.disabled = true;
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
    if (logIsOpen()) await loadLog();
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
    restoreView();
    poll();
    setInterval(poll, POLL_MS);
    // While something is running, or the log is open, look every second so progress is seen as it happens.
    setInterval(() => (working || logIsOpen() ? poll() : undefined), FAST_POLL_MS);
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

    // The status opens the activity log. It works with the server down too, to say so.
    if (target.closest("#live-status")) {
      const dialog = el("activity-log");
      if (dialog && !dialog.open) dialog.showModal();
      await loadLog();
      return;
    }
    if (target.closest("#activity-close")) {
      el("activity-log")?.close();
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

    // Tick a line off, or take the tick back. The server redraws the page, which reloads this one.
    const tick = target.closest("button[data-done]");
    if (tick) {
      tick.disabled = true;
      const marked = await act("/api/done", { key: tick.dataset.done, done: tick.dataset.state !== "done" });
      if (!marked) tick.disabled = false;
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
