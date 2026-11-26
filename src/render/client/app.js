// Runs in the page. Inlined into <head> by src/render/page.ts; never loaded from a URL.
// It runs before the body exists, so anything that needs a button waits for the page.
//
// The only requests it makes are to the local server that served the page, and the only
// connection it keeps open is to that server's activity stream, while the log is open. It
// asks for an LLM call in exactly two places: when a button marked data-enrich is pressed,
// and when a button marked data-fix is. Two presses lead to a change outside this machine,
// and nothing else here does: a data-fix press (the server pushes a commit to one of my
// own PRs) and a data-review-post press (the server posts the review I ticked to its PR).

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
  const fixButtons = () => document.querySelectorAll("button[data-fix]");
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
      sessionStorage.setItem(VIEW_KEY, JSON.stringify({ scroll, open, ...(logIsOpen() ? { log: true } : {}) }));
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
      if (saved.log) openLog(); // it was open when the page reloaded itself
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
  let fixingAll = false; // a Fix all is running, so its button is the one that stops it

  // ---- A drafted review, opened up: tick the notes that are real, edit them, post them ----

  const REVIEW_KEY = "divination-review";
  const KINDS = { COMMENT: "Comment", APPROVE: "Approve", REQUEST_CHANGES: "Request changes" };
  const reviewDialogs = () => document.querySelectorAll("dialog.review-dialog");
  const sentReviews = new Set(); // dialogs whose review this page has posted
  let posting = false; // a review is on its way to the server
  let reloadWaiting = false; // the page changed while a review was open; reload when it closes

  function reviewIsOpen() {
    for (const dialog of reviewDialogs()) if (dialog.open) return true;
    return false;
  }

  // What a dialog holds right now: each entry's tick and text, the kind chosen, my message.
  function reviewState(dialog) {
    const picks = [];
    for (const input of dialog.querySelectorAll("input[data-pick]")) {
      picks.push({ pick: input.dataset.pick, on: input.checked === true, text: input.closest(".finding")?.querySelector("textarea")?.value ?? "" });
    }
    let event = "COMMENT";
    for (const radio of dialog.querySelectorAll('input[type="radio"]')) if (radio.checked) event = radio.value;
    return { picks, event, message: dialog.querySelector("textarea[data-message]")?.value ?? "" };
  }

  // What Post would send: only what is ticked and still has words in it.
  function reviewRequest(dialog) {
    const state = reviewState(dialog);
    const ticked = state.picks.filter((entry) => entry.on && entry.text.trim() !== "");
    const summary = ticked.find((entry) => entry.pick === "summary");
    const notes = ticked.filter((entry) => entry.pick !== "summary").map((entry) => ({ index: Number(entry.pick), text: entry.text }));
    // The draft's fingerprint goes too: the server refuses if the draft has been rerun since.
    return { key: dialog.dataset.review, draft: dialog.dataset.draft, event: state.event, message: state.message, ...(summary ? { summary: summary.text } : {}), notes };
  }

  // The Post button says what it will send, and is off when there is nothing to send.
  function refreshReview(dialog) {
    const button = dialog.querySelector("button[data-review-post]");
    if (!button) return;
    const request = reviewRequest(dialog);
    const count = request.notes.length;
    button.textContent = `${count === 0 ? "Post" : `Post ${count} ${count === 1 ? "comment" : "comments"}`} · ${KINDS[request.event] ?? KINDS.COMMENT}`;
    // An approval may be bare; a comment or a change request must say something.
    const something = count > 0 || request.message.trim() !== "" || request.summary !== undefined || request.event === "APPROVE";
    button.disabled = !online || posting || sentReviews.has(dialog) || !something;
  }

  // Kept in this tab only, so a reload does not undo my ticks. A posted review's are dropped.
  function saveReviews() {
    try {
      const saved = {};
      for (const dialog of reviewDialogs()) {
        if (!sentReviews.has(dialog)) saved[dialog.dataset.review] = { draft: dialog.dataset.draft, ...reviewState(dialog) };
      }
      sessionStorage.setItem(REVIEW_KEY, JSON.stringify(saved));
    } catch {
      // Storage can be blocked; the ticks then last until the page reloads.
    }
  }

  // Put back what was kept, but only on the very draft it was kept for: a rerun starts clean.
  function restoreReview(dialog, saved) {
    const was = saved !== null && typeof saved === "object" && Object.hasOwn(saved, dialog.dataset.review) ? saved[dialog.dataset.review] : null;
    if (was === null || typeof was !== "object" || was.draft !== dialog.dataset.draft) return;
    const kept = new Map((Array.isArray(was.picks) ? was.picks : []).filter((entry) => entry && typeof entry === "object").map((entry) => [entry.pick, entry]));
    for (const input of dialog.querySelectorAll("input[data-pick]")) {
      const entry = kept.get(input.dataset.pick);
      if (!entry) continue;
      input.checked = entry.on === true;
      const box = input.closest(".finding")?.querySelector("textarea");
      if (box && typeof entry.text === "string") box.value = entry.text;
    }
    if (Object.hasOwn(KINDS, was.event)) {
      for (const radio of dialog.querySelectorAll('input[type="radio"]')) radio.checked = radio.value === was.event;
    }
    const message = dialog.querySelector("textarea[data-message]");
    if (message && typeof was.message === "string") message.value = was.message;
  }

  function restoreReviews() {
    let saved = null;
    try {
      saved = JSON.parse(sessionStorage.getItem(REVIEW_KEY) ?? "null");
    } catch {
      // Nothing usable was kept.
    }
    for (const dialog of reviewDialogs()) {
      try {
        restoreReview(dialog, saved);
      } catch {
        // What was kept for this one is junk; it starts clean.
      }
      refreshReview(dialog);
      // Closed by its button or with Escape: now the page may catch up.
      // Not while a review is on its way, though: a reload then would bring back a page
      // that offers to post it again.
      dialog.addEventListener?.("close", () => {
        if (reloadWaiting && !posting && !reviewIsOpen()) reload();
      });
    }
  }

  function refreshReviews() {
    for (const dialog of reviewDialogs()) refreshReview(dialog);
  }

  // Something in a review was ticked or typed.
  function reviewChanged(event) {
    const target = event.target instanceof Element ? event.target : null;
    const dialog = target?.closest("dialog.review-dialog");
    if (!dialog) return;
    refreshReview(dialog);
    saveReviews();
  }

  function posted(answer) {
    const comments = Number(answer.comments ?? 0);
    const inBody = Number(answer.inBody ?? 0);
    const parts = [
      ...(comments > 0 ? [comments === 1 ? "1 comment on a line" : `${comments} comments on lines`] : []),
      ...(inBody > 0 ? [`${inBody} in the overall comment`] : []),
    ];
    return parts.length > 0 ? `Posted: ${parts.join(", ")}.` : "Posted.";
  }

  // The one place a review is sent from: a press of Post in its dialog.
  async function postReview(dialog) {
    if (posting || sentReviews.has(dialog)) return;
    const status = dialog.querySelector(".review-status");
    const say = (text) => {
      if (status) status.textContent = text;
    };
    const request = reviewRequest(dialog);
    posting = true;
    // Its ticks stop being kept as it is sent, not when it is answered: whatever happens
    // to this page meanwhile, it does not come back offering the same review again.
    sentReviews.add(dialog);
    saveReviews();
    refreshReview(dialog);
    say("Posting…");
    const notSent = (why) => {
      sentReviews.delete(dialog);
      saveReviews(); // kept again, for the next try
      say(why);
    };
    try {
      const res = await post("/api/review/post", request);
      const answer = await res.json().catch(() => ({}));
      if (res.ok) say(posted(answer));
      else if (res.status === 403) notSent("Not posted: this page is out of date. Close the review and open it again; your ticks are kept.");
      else notSent(`Not posted: ${answer.error ?? `the server said no (${res.status})`}`);
    } catch {
      // No answer is not a no: the request may have reached GitHub before the server went.
      notSent("The server did not answer, so the review may or may not have been posted. Check the PR before pressing Post again.");
    }
    posting = false;
    refreshReview(dialog);
    if (reloadWaiting && !reviewIsOpen()) reload(); // it was closed while this was on its way
  }

  async function copyText(button, text) {
    const label = button.textContent;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Copy failed";
    }
    setTimeout(() => {
      button.textContent = label;
    }, 1500);
  }

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
        if (s.state === "running") return `… ${name}  ${s.asking ? "Claude is reading…" : "reading…"}`;
        if (s.state === "failed") return `✗ ${name}  failed: ${s.error ?? "unknown error"}`;
        if (!s.at) return `✓ ${name}  never read`;
        if (s.byHand) return `✓ ${name}  read by hand at ${clock(s.at)}`;
        return `✓ ${name}  updated ${clock(s.at)}${typeof s.ms === "number" ? ` in ${seconds(s.ms)}` : ""}`;
      })
      .join("\n");
  }

  // The log is not fetched: while its dialog is open the server pushes each line as it is
  // logged, and the pieces of a line Claude is still writing.

  const LOG_MAX = 300; // as many entries as the server keeps
  const nextFrame = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
  let stream = null; // the open connection to the server's activity stream
  let entries = []; // what it has sent, oldest first
  let connected = false; // the stream has connected at least once
  let unreachable = false; // it failed before ever connecting: the server is not there
  let drawQueued = false;

  function logIsOpen() {
    return Boolean(el("activity-log")?.open);
  }

  function setLive(text) {
    const live = el("activity-live");
    if (live) live.textContent = text;
  }

  // Each entry is a time and a line; an error is flagged, and any detail lines keep their place under it.
  function drawLog() {
    drawQueued = false;
    const lines = el("activity-lines");
    if (!lines) return;
    // Stay on the newest line, unless I have scrolled up to read something.
    const atBottom = lines.scrollTop + lines.clientHeight >= lines.scrollHeight - 8;
    if (entries.length > 0) {
      lines.textContent = entries
        .map((entry) => {
          const [first, ...rest] = entry.text.split("\n");
          const head = `${clock(entry.at, true)} ${entry.level === "error" ? "! " : " "}${first}`;
          return [head, ...rest.map((line) => `${" ".repeat(10)}${line}`)].join("\n");
        })
        .join("\n");
    } else {
      lines.textContent = unreachable ? "The server is not running, so there is no log to show." : "Nothing has happened since the server started.";
    }
    if (atBottom) lines.scrollTop = lines.scrollHeight;
  }

  // Text can arrive many times a second; draw at most once a frame.
  function queueDraw() {
    if (drawQueued) return;
    drawQueued = true;
    nextFrame(drawLog);
  }

  function stopFollowing() {
    if (stream) stream.close();
    stream = null;
    setLive("");
  }

  // Start over: the server sends everything it has, then each update as it happens.
  function followLog() {
    stopFollowing();
    entries = [];
    connected = false;
    unreachable = typeof EventSource !== "function";
    setLive(unreachable ? "not connected" : "connecting…");
    drawLog();
    if (unreachable) return;

    const source = new EventSource("/api/activity/stream");
    stream = source;
    source.addEventListener("open", () => {
      connected = true;
      unreachable = false;
      setLive("● live");
      queueDraw();
    });
    // The browser reconnects by itself, and tells the server the last line it saw.
    source.addEventListener("error", () => {
      if (connected) {
        setLive("reconnecting…");
        return;
      }
      unreachable = true;
      setLive("not connected");
      queueDraw();
    });
    source.addEventListener("line", (event) => {
      const line = JSON.parse(event.data);
      const index = entries.findIndex((entry) => entry.id === line.id);
      if (index >= 0) entries[index] = line; // sent again after a reconnect: it may have grown
      else if (entries.length === 0 || line.id > entries[entries.length - 1].id) entries.push(line);
      if (entries.length > LOG_MAX) entries.shift();
      queueDraw();
    });
    source.addEventListener("more", (event) => {
      const more = JSON.parse(event.data);
      const entry = entries.find((candidate) => candidate.id === more.id);
      if (!entry) return;
      entry.text += more.text;
      queueDraw();
    });
  }

  function openLog() {
    const dialog = el("activity-log");
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    followLog();
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
      // An open review is not pulled out from under me: the page reloads when it is closed.
      if (reviewIsOpen()) reloadWaiting = true;
      else {
        reload();
        return;
      }
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

    // While a Fix all runs, its own button stops it after the PR in hand; every other Fix button waits.
    fixingAll = busy && status.job.name === "fix:all";
    for (const button of fixButtons()) {
      const all = button.dataset.fix === "all";
      if (all && fixingAll) {
        const stopping = Boolean(status.fix && status.fix.stopping);
        if (pending && pending.button === button) pending = null; // it is a stop button now, not a pressed one
        button.textContent = stopping ? "Stopping after this one…" : "Stop after this one";
        button.disabled = stopping;
        continue;
      }
      if (pending && button === pending.button) continue;
      if (all) button.textContent = "Fix all";
      button.disabled = busy;
    }

    const running = sources.filter((s) => s.state === "running");
    const reading = running.length > 0 ? ` ${running.map((s) => s.title).join(", ")}` : "";
    // Claude is at work for a sparkle button, or for a source it is reading after Refresh now.
    const asking = busy && (status.job.name.startsWith("enrich") || running.some((s) => s.asking));
    const fixing = busy && status.job.name.startsWith("fix:");
    if (fixing) {
      const at = status.fix;
      setStatus(at ? `fixing ${at.key}${at.total > 1 ? `, ${at.index} of ${at.total}` : ""}` : "fixing…");
    } else if (busy) setStatus(asking ? `asking Claude…${reading}` : `updating…${reading}`);
    else if (status.lastJob && !status.lastJob.ok) setStatus(`failed: ${status.lastJob.error}`);
    else if (!status.live) setStatus("paused");
    else setStatus(status.nextTickAt ? `next update ${clock(status.nextTickAt)}` : "live");
    refreshReviews();
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
    for (const button of fixButtons()) button.disabled = true;
    for (const button of ticks()) button.disabled = true;
    refreshReviews();
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
    restoreView();
    restoreReviews();
    poll();
    setInterval(poll, POLL_MS);
    // While something is running, look every second so progress is seen as it happens.
    setInterval(() => (working ? poll() : undefined), FAST_POLL_MS);
    // Closed with Escape rather than the button: stop following all the same.
    el("activity-log")?.addEventListener?.("close", stopFollowing);
  });

  document.addEventListener("input", reviewChanged);
  document.addEventListener("change", reviewChanged);

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
      await copyText(copy, copy.dataset.copy ?? "");
      return;
    }
    // In a review's dialog: the note as it reads now, edits and all.
    const copyNote = target.closest("button[data-copy-text]");
    if (copyNote) {
      await copyText(copyNote, copyNote.closest(".finding")?.querySelector("textarea")?.value ?? "");
      return;
    }

    // A drafted review opens and closes with the server up or down: reading it needs nothing.
    const openReview = target.closest("button[data-review-open]");
    if (openReview) {
      for (const dialog of reviewDialogs()) {
        if (dialog.dataset.review !== openReview.dataset.reviewOpen || dialog.open) continue;
        refreshReview(dialog);
        dialog.showModal();
      }
      return;
    }
    const closeReview = target.closest("button[data-review-close]");
    if (closeReview) {
      closeReview.closest("dialog.review-dialog")?.close();
      return;
    }

    // The status opens the activity log. It works with the server down too, to say so.
    if (target.closest("#live-status")) {
      openLog();
      return;
    }
    if (target.closest("#activity-close")) {
      el("activity-log")?.close();
      stopFollowing();
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

    // Post the review I ticked to its PR, under my name. Nothing else on the page does this.
    const postButton = target.closest("button[data-review-post]");
    if (postButton) {
      const dialog = postButton.closest("dialog.review-dialog");
      if (dialog) await postReview(dialog);
      return;
    }

    // Fix one of my PRs, or all that can be fixed. The server has Claude edit files in a
    // throwaway worktree and pushes the result to that PR's branch.
    const fix = target.closest("button[data-fix]");
    if (fix) {
      if (fix.dataset.fix === "all" && fixingAll) {
        // The same button, while Fix all runs: stop after the PR in hand.
        fix.disabled = true;
        const asked = await act("/api/fix/stop", {});
        if (!asked) fix.disabled = false;
        return;
      }
      if (pending) return;
      pending = { button: fix, label: fix.textContent, since: lastFinishedAt };
      fix.textContent = "Fixing…";
      fix.disabled = true;
      const started = await act("/api/fix", { key: fix.dataset.fix });
      if (!started) restorePending();
      return;
    }

    // An LLM call for a draft or a summary.
    const enrich = target.closest("button[data-enrich]");
    if (enrich && !pending) {
      pending = { button: enrich, label: enrich.textContent, since: lastFinishedAt };
      enrich.textContent = "Asking Claude…";
      enrich.disabled = true;
      // A rerun button (data-again) asks for an item that already has an answer.
      const again = "again" in enrich.dataset ? { again: true } : {};
      const started = await act("/api/enrich", { enricher: enrich.dataset.enrich, key: enrich.dataset.key, ...again });
      if (!started) restorePending();
    }
  });
})();
