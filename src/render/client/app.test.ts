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
    if (selector === ".panel" && this.panelId) return { id: this.panelId } as unknown as FakeElement;
    return null;
  }
  // For the parts of a panel: its scrolling body and its folds.
  panelId = "";
  scrollTop = 0;
  open = false;
  className = "";
}

interface Status {
  live: boolean;
  nextTickAt: number | null;
  renderedAt: number;
  startedAt: number;
  job: { name: string; startedAt: number } | null;
  lastJob: { name: string; ok: boolean; error?: string; finishedAt: number } | null;
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
  };
  const draft = new FakeElement("draft-1", "Draft review");
  draft.dataset.enrich = "pr-review";
  draft.dataset.key = "o/r#1@aaa111";

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
    status: opts.status === undefined ? LIVE : opts.status,
    postStatus: 200,
    requests: [] as { url: string; method: string; headers: Record<string, string>; body: unknown }[],
  };
  const intervals: { fn: () => unknown; ms: number }[] = [];
  let reloads = 0;

  const context = {
    Element: FakeElement,
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
    tick,
    body,
    fold,
    session,
    toggle: elements["theme-toggle"]!,
    liveToggle: elements["live-toggle"]!,
    refreshNow: elements["refresh-now"]!,
    liveStatus: elements["live-status"]!,
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
  assert.deepEqual(p.intervals.map((i) => i.ms), [3000]);
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
