// app.js is browser code that is inlined into the page. These tests run it in a
// sandbox with just enough of a page and a server around it to press its buttons.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { settle } from "../../../test/helpers.ts";

const source = readFileSync(fileURLToPath(new URL("./app.js", import.meta.url)), "utf8");

class FakeElement {
  id: string;
  textContent: string;
  disabled = false;
  dataset: Record<string, string> = {};
  constructor(id: string, textContent = "") {
    this.id = id;
    this.textContent = textContent;
  }
  closest(selector: string): FakeElement | null {
    if (selector === `#${this.id}`) return this;
    if (selector === "button[data-copy]" && "copy" in this.dataset) return this;
    if (selector === "button[data-enrich]" && "enrich" in this.dataset) return this;
    if (selector === "button[data-done]" && "done" in this.dataset) return this;
    if (selector === "button[data-fix]" && "fix" in this.dataset) return this;
    if (selector === ".panel" && this.panelId) return { id: this.panelId } as unknown as FakeElement;
    return null;
  }
  // For the parts of a panel: its scrolling body and its folds.
  panelId = "";
  scrollTop = 0;
  open = false;
  className = "";
  // For the log, which scrolls.
  scrollHeight = 0;
  clientHeight = 0;
}

/** Stands in for the browser's EventSource: records where it connected, and delivers what a test emits. */
class FakeStream {
  url: string;
  closed = false;
  handlers: Record<string, ((event: unknown) => void)[]> = {};
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(type: string, fn: (event: unknown) => void) {
    (this.handlers[type] ??= []).push(fn);
  }
  close() {
    this.closed = true;
  }
}

interface Status {
  live: boolean;
  nextTickAt: number | null;
  renderedAt: number;
  startedAt: number;
  sources?: { id: string; title: string; state: string; at: number; ms?: number; error?: string; byHand?: boolean; asking?: boolean }[];
  job: { name: string; startedAt: number } | null;
  lastJob: { name: string; ok: boolean; error?: string; finishedAt: number } | null;
  fix?: { key: string; index: number; total: number; stopping: boolean } | null;
}

const LIVE: Status = { live: true, nextTickAt: Date.parse("2026-11-25T03:15:00Z"), renderedAt: 100, startedAt: 50, job: null, lastJob: null };

interface Options {
  /** What sessionStorage holds when the page loads. */
  session?: string;
  storageBroken?: boolean;
  /** What the server answers. `null` means the server cannot be reached. */
  status?: Status | null;
}

function page(stored: string | null, opts: Options = {}) {
  const listeners: Record<string, ((event: unknown) => unknown)[]> = {};
  const root = new FakeElement("root");
  const elements: Record<string, FakeElement> = {
    "theme-toggle": new FakeElement("theme-toggle", "Theme"),
    "live-toggle": new FakeElement("live-toggle", "Pause"),
    "refresh-now": new FakeElement("refresh-now", "Refresh now"),
    "live-status": new FakeElement("live-status", ""),
    "activity-pop": new FakeElement("activity-pop", ""),
    "activity-log": new FakeElement("activity-log", ""),
    "activity-lines": new FakeElement("activity-lines", ""),
    "activity-live": new FakeElement("activity-live", ""),
    "activity-close": new FakeElement("activity-close", "Close"),
  };
  const dialog = elements["activity-log"]! as FakeElement & { showModal(): void; close(): void };
  dialog.showModal = () => {
    dialog.open = true;
  };
  dialog.close = () => {
    dialog.open = false;
  };
  const draft = new FakeElement("draft-1", "Draft review");
  draft.dataset.enrich = "pr-review";
  draft.dataset.key = "o/r#1@aaa111";

  const fix = new FakeElement("fix-8", "Fix");
  fix.dataset.fix = "o/r#8";
  const fixAll = new FakeElement("fix-all", "Fix all");
  fixAll.dataset.fix = "all";

  const tick = new FakeElement("tick-1", "✓");
  tick.dataset.done = "pr:o/r#1@aaa111";
  tick.dataset.state = "open";
  const body = new FakeElement("body-prs");
  body.panelId = "prs";
  const fold = new FakeElement("fold-prs");
  fold.panelId = "prs";
  fold.className = "stale done";
  const session = new Map<string, string>();
  if (opts.session !== undefined) session.set("divination-view", opts.session);

  const store = new Map<string, string>();
  if (stored !== null) store.set("divination-theme", stored);
  let parsed = false; // the script runs in <head>, before the buttons exist

  const server = {
    activity: [] as { at: number; level: string; text: string }[],
    status: opts.status === undefined ? LIVE : opts.status,
    postStatus: 200,
    requests: [] as { url: string; method: string; headers: Record<string, string>; body: unknown }[],
  };
  const intervals: { fn: () => unknown; ms: number }[] = [];
  let reloads = 0;
  const streams: FakeStream[] = [];

  const context = {
    Element: FakeElement,
    EventSource: class extends FakeStream {
      constructor(url: string) {
        super(url);
        streams.push(this);
      }
    },
    setTimeout: (fn: () => void) => fn(),
    setInterval: (fn: () => unknown, ms: number) => intervals.push({ fn, ms }),
    navigator: { clipboard: { writeText: async () => {} } },
    location: { reload: () => { reloads++; } },
    fetch: async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
      const method = init.method ?? "GET";
      // Copy the headers: objects made inside the sandbox belong to another realm and never compare equal.
      server.requests.push({ url, method, headers: { ...(init.headers ?? {}) }, body: init.body ? JSON.parse(init.body) : undefined });
      if (server.status === null) throw new Error("connection refused");
      if (method === "POST") {
        if (server.postStatus === 409) return { ok: false, status: 409, json: async () => ({ error: "busy" }) };
        if (url === "/api/live") server.status = { ...server.status, live: (JSON.parse(init.body!) as { on: boolean }).on, nextTickAt: null };
        if (url === "/api/done") server.status = { ...server.status, renderedAt: server.status.renderedAt + 1 }; // the server redraws the page
      }
      if (url === "/api/activity") return { ok: true, status: 200, json: async () => ({ lines: server.activity }) };
      return { ok: true, status: 200, json: async () => server.status };
    },
    sessionStorage: {
      getItem: (key: string) => {
        if (opts.storageBroken) throw new Error("blocked");
        return session.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        if (opts.storageBroken) throw new Error("blocked");
        session.set(key, value);
      },
    },
    localStorage: {
      getItem: (key: string) => {
        if (opts.storageBroken) throw new Error("blocked");
        return store.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        if (opts.storageBroken) throw new Error("blocked");
        store.set(key, value);
      },
    },
    document: {
      documentElement: root,
      getElementById: (id: string) => (parsed ? (elements[id] ?? null) : null),
      querySelector: (selector: string) => (parsed && selector === 'meta[name="divination-token"]' ? { content: "tok" } : null),
      querySelectorAll: (selector: string) => {
        if (!parsed) return [];
        if (selector === "button[data-enrich]") return [draft];
        if (selector === "button[data-done]") return [tick];
        if (selector === "button[data-fix]") return [fixAll, fix];
        if (selector === ".panel-body") return [body];
        if (selector === "details.stale") return [fold];
        return [];
      },
      addEventListener: (type: string, fn: (event: unknown) => unknown) => {
        (listeners[type] ??= []).push(fn);
      },
    },
  };
  vm.runInNewContext(source, context);

  return {
    root,
    store,
    server,
    draft,
    fix,
    fixAll,
    tick,
    body,
    fold,
    session,
    toggle: elements["theme-toggle"]!,
    liveToggle: elements["live-toggle"]!,
    refreshNow: elements["refresh-now"]!,
    liveStatus: elements["live-status"]!,
    pop: elements["activity-pop"]!,
    dialog,
    logLines: elements["activity-lines"]!,
    logLive: elements["activity-live"]!,
    streams,
    /** Deliver an event on the newest activity stream, as the server would. */
    emit(type: string, data?: unknown) {
      for (const fn of streams.at(-1)!.handlers[type] ?? []) fn({ data: JSON.stringify(data) });
    },
    closeLog: elements["activity-close"]!,
    themeBeforeParse: root.dataset.theme,
    get reloads() {
      return reloads;
    },
    intervals,
    async finishParsing() {
      parsed = true;
      for (const fn of listeners.DOMContentLoaded ?? []) fn({});
      await settle();
    },
    async click(target: FakeElement) {
      for (const fn of listeners.click ?? []) await fn({ target });
      await settle();
    },
    /** What the page does on its own every few seconds. */
    async poll() {
      for (const { fn } of intervals) await fn();
      await settle();
    },
    posts() {
      return server.requests.filter((r) => r.method === "POST");
    },
  };
}

// Theme

test("a saved theme is applied before the page is drawn, and the button is labelled once it exists", async () => {
  const p = page("dark");
  assert.equal(p.themeBeforeParse, "dark");
  await p.finishParsing();
  assert.equal(p.toggle.textContent, "☾ Dark");
});

test("with nothing saved the page follows the system and says so", async () => {
  const p = page(null);
  assert.equal(p.themeBeforeParse, undefined);
  await p.finishParsing();
  assert.equal(p.toggle.textContent, "◐ Auto");
});

test("pressing the toggle cycles auto, light, dark and remembers the choice", async () => {
  const p = page(null);
  await p.finishParsing();

  await p.click(p.toggle);
  assert.deepEqual([p.root.dataset.theme, p.toggle.textContent, p.store.get("divination-theme")], ["light", "☀ Light", "light"]);

  await p.click(p.toggle);
  assert.deepEqual([p.root.dataset.theme, p.toggle.textContent, p.store.get("divination-theme")], ["dark", "☾ Dark", "dark"]);

  await p.click(p.toggle);
  assert.deepEqual([p.root.dataset.theme, p.toggle.textContent, p.store.get("divination-theme")], [undefined, "◐ Auto", "auto"]);
  assert.equal(p.posts().length, 0); // the theme is the browser's business, not the server's
});

test("a junk saved value falls back to auto", () => {
  assert.equal(page("neon").themeBeforeParse, undefined);
});

test("the toggle still works when the browser blocks storage", async () => {
  const p = page(null, { storageBroken: true });
  await p.finishParsing();
  await p.click(p.toggle);
  assert.equal(p.root.dataset.theme, "light");
});

// Copy

test("copy buttons still copy and say so", async () => {
  const p = page(null);
  await p.finishParsing();
  const button = new FakeElement("copy-1", "Copy comment");
  button.dataset.copy = "Rename `x`.";
  const seen: string[] = [];
  Object.defineProperty(button, "textContent", {
    set(value: string) {
      seen.push(value);
    },
    get() {
      return seen.at(-1) ?? "Copy comment";
    },
  });
  await p.click(button);
  assert.deepEqual(seen, ["Copied", "Copy comment"]);
});

// Live updates

test("while live the button offers Pause and the status says when the next update is", async () => {
  const p = page(null);
  await p.finishParsing();
  assert.equal(p.liveToggle.textContent, "Pause");
  assert.match(p.liveStatus.textContent, /^next update \d\d:\d\d$/);
  assert.deepEqual(p.server.requests.map((r) => [r.method, r.url]), [["GET", "/api/status"]]);
  assert.deepEqual(p.intervals.map((i) => i.ms), [3000, 1000]); // the slow poll, and a fast one for while something is running
});

test("while paused the button offers Start", async () => {
  const p = page(null, { status: { ...LIVE, live: false, nextTickAt: null } });
  await p.finishParsing();
  assert.deepEqual([p.liveToggle.textContent, p.liveStatus.textContent], ["Start", "paused"]);
});

test("pressing Pause tells the server, with the page's token, and the page follows", async () => {
  const p = page(null);
  await p.finishParsing();
  await p.click(p.liveToggle);
  assert.deepEqual(p.posts(), [
    { url: "/api/live", method: "POST", headers: { "content-type": "application/json", "x-divination-token": "tok" }, body: { on: false } },
  ]);
  assert.deepEqual([p.liveToggle.textContent, p.liveStatus.textContent], ["Start", "paused"]);

  await p.click(p.liveToggle);
  assert.deepEqual(p.posts()[1]!.body, { on: true });
  assert.equal(p.liveToggle.textContent, "Pause");
});

test("Refresh now asks for an update", async () => {
  const p = page(null);
  await p.finishParsing();
  await p.click(p.refreshNow);
  assert.deepEqual(p.posts().map((r) => [r.url, r.headers["x-divination-token"]]), [["/api/tick", "tok"]]);
});

test("the status follows the running job", async () => {
  const p = page(null, { status: { ...LIVE, job: { name: "tick", startedAt: 1 } } });
  await p.finishParsing();
  assert.equal(p.liveStatus.textContent, "updating…");
  assert.equal(p.refreshNow.disabled, true);

  p.server.status = { ...LIVE, job: { name: "enrich:pr-review:o/r#1@aaa111", startedAt: 1 } };
  await p.poll();
  assert.equal(p.liveStatus.textContent, "asking Claude…");
  assert.equal(p.draft.disabled, true);
});

test("a failed job shows its error", async () => {
  const lastJob = { name: "enrich:pr-review:x", ok: false, error: "claude failed: Failed to authenticate", finishedAt: 5 };
  const p = page(null, { status: { ...LIVE, lastJob } });
  await p.finishParsing();
  assert.equal(p.liveStatus.textContent, "failed: claude failed: Failed to authenticate");
  assert.equal(p.draft.disabled, false);
});

// Reloading

test("the page reloads itself when a newer page has been rendered, and only then", async () => {
  const p = page(null);
  await p.finishParsing();
  await p.poll();
  assert.equal(p.reloads, 0);

  p.server.status = { ...LIVE, renderedAt: 200 };
  await p.poll();
  assert.equal(p.reloads, 1);
});

test("the page reloads itself when the server has restarted, to pick up its new token", async () => {
  const p = page(null);
  await p.finishParsing();
  await p.poll();
  assert.equal(p.reloads, 0);

  p.server.status = { ...LIVE, startedAt: 60 };
  await p.poll();
  assert.equal(p.reloads, 1);
});

// LLM buttons

test("a sparkle button asks the server for exactly that item and shows it is working", async () => {
  const p = page(null);
  await p.finishParsing();
  await p.click(p.draft);
  assert.deepEqual(p.posts(), [
    {
      url: "/api/enrich",
      method: "POST",
      headers: { "content-type": "application/json", "x-divination-token": "tok" },
      body: { enricher: "pr-review", key: "o/r#1@aaa111" },
    },
  ]);
  assert.equal(p.draft.textContent, "Asking Claude…");
  assert.equal(p.draft.disabled, true);
});

test("a rerun button asks for the same item again", async () => {
  const p = page(null);
  await p.finishParsing();
  p.draft.textContent = "Rerun review";
  p.draft.dataset.again = "";
  await p.click(p.draft);
  assert.deepEqual(p.posts()[0]!.body, { enricher: "pr-review", key: "o/r#1@aaa111", again: true });
  assert.equal(p.draft.textContent, "Asking Claude…");
});

test("nothing asks for enrichment unless a sparkle button is pressed", async () => {
  const p = page(null);
  await p.finishParsing();
  await p.poll();
  await p.poll();
  await p.click(p.refreshNow);
  await p.click(p.liveToggle);
  await p.click(p.toggle);
  assert.ok(!p.server.requests.some((r) => r.url === "/api/enrich"));
});

test("when the server is busy the button says so and can be pressed again", async () => {
  const p = page(null);
  await p.finishParsing();
  p.server.postStatus = 409;
  await p.click(p.draft);
  assert.equal(p.liveStatus.textContent, "busy, try again in a moment");
  assert.deepEqual([p.draft.textContent, p.draft.disabled], ["Draft review", false]);
});

// No server

test("opened as a file, or with the server down, every server button is off and the page says why", async () => {
  const p = page(null, { status: null });
  await p.finishParsing();
  assert.equal(p.liveStatus.textContent, "server not running");
  assert.deepEqual([p.liveToggle.disabled, p.refreshNow.disabled, p.draft.disabled], [true, true, true]);
  assert.equal(p.toggle.disabled, false); // the theme toggle needs no server

  await p.click(p.draft);
  await p.click(p.liveToggle);
  assert.equal(p.posts().length, 0);
});

test("the buttons come back when the server does", async () => {
  const p = page(null, { status: null });
  await p.finishParsing();
  p.server.status = LIVE;
  await p.poll();
  assert.deepEqual([p.liveToggle.disabled, p.refreshNow.disabled, p.draft.disabled], [false, false, false]);
  assert.equal(p.liveToggle.textContent, "Pause");
});

// Marking lines done

test("ticking a line tells the server which line and that it is now done, then the page reloads", async () => {
  const p = page(null);
  await p.finishParsing();
  await p.click(p.tick);
  assert.deepEqual(p.posts(), [
    { url: "/api/done", method: "POST", headers: { "content-type": "application/json", "x-divination-token": "tok" }, body: { key: "pr:o/r#1@aaa111", done: true } },
  ]);
  assert.equal(p.reloads, 1);
});

test("ticking a done line takes the mark back", async () => {
  const p = page(null);
  p.tick.dataset.state = "done";
  await p.finishParsing();
  await p.click(p.tick);
  assert.deepEqual(p.posts()[0]!.body, { key: "pr:o/r#1@aaa111", done: false });
});

test("a tick the server refuses is given back, and ticks are off while the server is down", async () => {
  const p = page(null);
  await p.finishParsing();
  p.server.postStatus = 409;
  await p.click(p.tick);
  assert.equal(p.tick.disabled, false);
  assert.equal(p.reloads, 0);

  const down = page(null, { status: null });
  await down.finishParsing();
  assert.equal(down.tick.disabled, true);
  await down.click(down.tick);
  assert.equal(down.posts().length, 0);
});

test("a reload keeps my place: each panel's scroll position and which folds were open", async () => {
  const p = page(null);
  await p.finishParsing();
  p.body.scrollTop = 240;
  p.fold.open = true;
  await p.click(p.tick); // reloads
  assert.deepEqual(JSON.parse(p.session.get("divination-view")!), { scroll: { prs: 240 }, open: ["prs:stale done"] });

  const next = page(null, { session: p.session.get("divination-view")! });
  await next.finishParsing();
  assert.equal(next.body.scrollTop, 240);
  assert.equal(next.fold.open, true);
});

test("with nothing remembered, or storage blocked or holding junk, the page still loads", async () => {
  const fresh = page(null);
  await fresh.finishParsing();
  assert.deepEqual([fresh.body.scrollTop, fresh.fold.open], [0, false]);

  const junk = page(null, { session: "{not json" });
  await junk.finishParsing();
  assert.equal(junk.liveToggle.textContent, "Pause");

  const blocked = page(null, { storageBroken: true });
  await blocked.finishParsing();
  await blocked.click(blocked.tick);
  assert.equal(blocked.reloads, 1);
});

// Activity: the breakdown on hover and the log behind a click

const at = (iso: string) => Date.parse(iso);
const SOURCES = [
  { id: "calendar", title: "Today", state: "ok", at: at("2026-11-25T04:11:00Z"), byHand: true },
  { id: "github", title: "Review queue", state: "running", at: at("2026-11-25T05:00:00Z") },
  { id: "slack", title: "Slack", state: "failed", at: 0, ms: 40, error: "inbox file missing", byHand: true },
  { id: "extra", title: "Extra", state: "ok", at: at("2026-11-25T05:24:00Z"), ms: 1234 },
];

test("the breakdown lists every source: reading, read and when, read by hand, or failed and why", async () => {
  const p = page(null, { status: { ...LIVE, job: { name: "tick", startedAt: 1 }, sources: SOURCES } });
  await p.finishParsing();
  const lines = p.pop.textContent.split("\n");
  assert.equal(lines.length, 4);
  assert.match(lines[0]!, /^✓ Today +read by hand at \d\d:\d\d$/);
  assert.match(lines[1]!, /^… Review queue +reading…$/);
  assert.match(lines[2]!, /^✗ Slack +failed: inbox file missing$/);
  assert.match(lines[3]!, /^✓ Extra +updated \d\d:\d\d in 1\.2 s$/);
  assert.equal(p.liveStatus.textContent, "updating… Review queue");
});

test("with nothing to break down, the breakdown is empty and the status reads as before", async () => {
  const p = page(null);
  await p.finishParsing();
  assert.equal(p.pop.textContent, "");
  assert.match(p.liveStatus.textContent, /^next update /);
});

const LINE1 = { id: 11, at: at("2026-11-25T05:00:00Z"), level: "info", text: "Refresh started (Refresh now)" };
const LINE2 = { id: 12, at: at("2026-11-25T05:00:42Z"), level: "error", text: "Claude (haiku) failed in 0.1 s\n  claude failed: Failed to authenticate" };

test("clicking the status opens the log, which follows the server's activity stream, newest last", async () => {
  const p = page(null);
  await p.finishParsing();
  assert.equal(p.streams.length, 0); // nothing is followed until the log is open

  await p.click(p.liveStatus);
  assert.equal(p.dialog.open, true);
  assert.deepEqual(p.streams.map((s) => s.url), ["/api/activity/stream"]);
  p.emit("line", LINE1);
  p.emit("line", LINE2);
  const text = p.logLines.textContent.split("\n");
  assert.match(text[0]!, /^\d\d:\d\d:\d\d  Refresh started \(Refresh now\)$/);
  assert.match(text[1]!, /^\d\d:\d\d:\d\d ! Claude \(haiku\) failed in 0\.1 s$/);
  assert.equal(text[2], "            claude failed: Failed to authenticate");
  assert.ok(!p.server.requests.some((r) => r.url === "/api/activity")); // it is pushed, never asked for
});

test("a line Claude is still writing grows in place", async () => {
  const p = page(null);
  await p.finishParsing();
  await p.click(p.liveStatus);
  p.emit("line", { id: 20, at: at("2026-11-25T05:00:00Z"), level: "info", text: "Claude: Read" });
  p.emit("more", { id: 20, text: "ing the " });
  p.emit("more", { id: 20, text: "diff." });
  p.emit("more", { id: 99, text: "for a line this page never had" });
  assert.match(p.logLines.textContent, /^\d\d:\d\d:\d\d  Claude: Reading the diff\.$/);

  // After a dropped connection the server sends the growing line again; it replaces the page's copy.
  p.emit("line", { id: 20, at: at("2026-11-25T05:00:00Z"), level: "info", text: "Claude: Reading the diff. Fine." });
  p.emit("line", LINE1); // an older line sent again is not added twice
  assert.match(p.logLines.textContent, /^\d\d:\d\d:\d\d  Claude: Reading the diff\. Fine\.$/);
});

test("an empty log says so, and the log says whether it is live", async () => {
  const p = page(null);
  await p.finishParsing();
  await p.click(p.liveStatus);
  assert.equal(p.logLines.textContent, "Nothing has happened since the server started.");
  assert.equal(p.logLive.textContent, "connecting…");
  p.emit("open");
  assert.equal(p.logLive.textContent, "● live");
  p.emit("line", LINE1);
  assert.match(p.logLines.textContent, /Refresh started \(Refresh now\)$/);
  p.emit("error");
  assert.equal(p.logLive.textContent, "reconnecting…");
  assert.match(p.logLines.textContent, /Refresh started \(Refresh now\)$/); // what was read stays
});

test("closing the log stops following it; opening it again starts afresh", async () => {
  const p = page(null);
  await p.finishParsing();
  await p.click(p.liveStatus);
  p.emit("line", LINE1);
  await p.click(p.closeLog);
  assert.equal(p.dialog.open, false);
  assert.equal(p.streams[0]!.closed, true);

  await p.click(p.liveStatus);
  assert.equal(p.streams.length, 2);
  assert.equal(p.logLines.textContent, "Nothing has happened since the server started."); // the server sends it all again
  p.emit("line", LINE1);
  assert.equal(p.logLines.textContent.split("\n").length, 1);
});

test("with the server down the status still opens the log, which says it cannot be read", async () => {
  const p = page(null, { status: null });
  await p.finishParsing();
  await p.click(p.liveStatus);
  assert.equal(p.dialog.open, true);
  p.emit("error");
  assert.equal(p.logLines.textContent, "The server is not running, so there is no log to show.");
  assert.equal(p.logLive.textContent, "not connected");
});

test("the log stays on the newest line unless I have scrolled up to read", async () => {
  const p = page(null);
  await p.finishParsing();
  await p.click(p.liveStatus);
  Object.assign(p.logLines, { scrollHeight: 500, clientHeight: 100, scrollTop: 400 }); // at the bottom
  p.emit("line", LINE1);
  assert.equal(p.logLines.scrollTop, 500);

  p.logLines.scrollTop = 120; // scrolled up
  p.emit("line", LINE2);
  assert.equal(p.logLines.scrollTop, 120);
});

test("an open log is open again, and following, after the page reloads itself", async () => {
  const p = page(null);
  await p.finishParsing();
  await p.click(p.liveStatus);
  await p.click(p.tick); // the server redraws the page, which reloads this one
  assert.equal(p.reloads, 1);
  assert.equal(JSON.parse(p.session.get("divination-view")!).log, true);

  const next = page(null, { session: p.session.get("divination-view")! });
  await next.finishParsing();
  assert.equal(next.dialog.open, true);
  assert.deepEqual(next.streams.map((s) => s.url), ["/api/activity/stream"]);
});

test("an open log does not make the page ask the server for anything more often", async () => {
  const p = page(null);
  await p.finishParsing();
  await p.click(p.liveStatus);
  const before = p.server.requests.length;
  for (const { fn, ms } of p.intervals) if (ms === 1000) await fn();
  assert.equal(p.server.requests.length, before);
});

test("while Claude is reading a source, the status and the breakdown say it is Claude", async () => {
  const sources = [
    { id: "github", title: "Review queue", state: "ok", at: at("2026-11-25T05:00:00Z"), ms: 900 },
    { id: "slack", title: "Slack", state: "running", at: at("2026-11-25T04:00:00Z"), byHand: true, asking: true },
  ];
  const p = page(null, { status: { ...LIVE, job: { name: "tick", startedAt: 1 }, sources } });
  await p.finishParsing();
  assert.equal(p.liveStatus.textContent, "asking Claude… Slack");
  assert.match(p.pop.textContent.split("\n")[1]!, /^… Slack +Claude is reading…$/);
});

// Fixing a PR

const FIXING_ALL: Status = { ...LIVE, job: { name: "fix:all", startedAt: 1 }, fix: { key: "o/r#8", index: 2, total: 14, stopping: false } };

test("a Fix button asks the server to fix exactly that PR and shows it is working", async () => {
  const p = page(null);
  await p.finishParsing();
  await p.click(p.fix);
  assert.deepEqual(p.posts(), [
    { url: "/api/fix", method: "POST", headers: { "content-type": "application/json", "x-divination-token": "tok" }, body: { key: "o/r#8" } },
  ]);
  assert.equal(p.fix.textContent, "Fixing…");
  assert.equal(p.fix.disabled, true);
});

test("Fix all asks for all", async () => {
  const p = page(null);
  await p.finishParsing();
  await p.click(p.fixAll);
  assert.deepEqual(p.posts().map((r) => [r.url, r.body]), [["/api/fix", { key: "all" }]]);
});

test("nothing asks for a fix unless a Fix button is pressed", async () => {
  const p = page(null);
  await p.finishParsing();
  await p.poll();
  await p.click(p.refreshNow);
  await p.click(p.liveToggle);
  await p.click(p.toggle);
  await p.click(p.draft);
  await p.click(p.tick);
  assert.ok(!p.server.requests.some((r) => r.url.startsWith("/api/fix")));
});

test("while a fix runs, the status line says which PR and how far", async () => {
  const all = page(null, { status: FIXING_ALL });
  await all.finishParsing();
  assert.equal(all.liveStatus.textContent, "fixing o/r#8, 2 of 14");

  const one = page(null, { status: { ...LIVE, job: { name: "fix:o/r#8", startedAt: 1 }, fix: { key: "o/r#8", index: 1, total: 1, stopping: false } } });
  await one.finishParsing();
  assert.equal(one.liveStatus.textContent, "fixing o/r#8");
  assert.deepEqual([one.fix.disabled, one.fixAll.disabled, one.fixAll.textContent], [true, true, "Fix all"]);
});

test("while Fix all runs its button stops it, and the other Fix buttons wait", async () => {
  const p = page(null, { status: FIXING_ALL });
  await p.finishParsing();
  assert.deepEqual([p.fixAll.textContent, p.fixAll.disabled, p.fix.disabled], ["Stop after this one", false, true]);

  p.server.status = { ...FIXING_ALL, fix: { ...FIXING_ALL.fix!, stopping: true } }; // what the server answers once asked
  await p.click(p.fixAll);
  assert.deepEqual(p.posts().map((r) => [r.url, r.body]), [["/api/fix/stop", {}]]);
  assert.deepEqual([p.fixAll.textContent, p.fixAll.disabled], ["Stopping after this one…", true]);

  // When it is over, the button is itself again.
  p.server.status = { ...LIVE, lastJob: { name: "fix:all", ok: true, finishedAt: 9 } };
  await p.poll();
  assert.deepEqual([p.fixAll.textContent, p.fixAll.disabled, p.fix.disabled], ["Fix all", false, false]);
});

test("when the server is busy a Fix button says so and can be pressed again", async () => {
  const p = page(null);
  await p.finishParsing();
  p.server.postStatus = 409;
  await p.click(p.fix);
  assert.equal(p.liveStatus.textContent, "busy, try again in a moment");
  assert.deepEqual([p.fix.textContent, p.fix.disabled], ["Fix", false]);
});

test("with the server gone the Fix buttons cannot be pressed", async () => {
  const p = page(null, { status: null });
  await p.finishParsing();
  assert.deepEqual([p.fix.disabled, p.fixAll.disabled], [true, true]);
});
