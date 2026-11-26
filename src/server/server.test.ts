import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { beforeEach, test } from "node:test";
import { contextWith, fakeExec, fakeSource, fakeTimers, settle, sourceWith } from "../../test/helpers.ts";
import type { Context, EnrichItem, Enricher } from "../core/types.ts";
import { readDone } from "../core/done.ts";
import { createApp } from "./server.ts";

type App = ReturnType<typeof createApp>;

let ctx: Context;
let app: App;
let runs: EnrichItem[][];
let exec: ReturnType<typeof fakeExec>;
let timers: ReturnType<typeof fakeTimers>;

beforeEach(() => {
  exec = fakeExec({});
  ctx = contextWith({ sources: ["fake"] }, { exec });
  runs = [];
  timers = fakeTimers();
  const enricher: Enricher<unknown> = {
    id: "fake-enricher",
    items: () => [{ key: "a", hash: "hash-a", input: 1 }],
    run: async (items) => {
      runs.push(items);
      return { a: "out-a" };
    },
  };
  const slow: Enricher<unknown> = {
    id: "slow-enricher",
    items: () => [{ key: "a", hash: "slow-a", input: 1 }],
    run: () => new Promise(() => {}), // never finishes during a test
  };
  const source = { ...sourceWith(ctx, enricher), enrichers: [enricher, slow] };
  app = createApp(ctx, [source], "tok", timers);
});

const req = (method: string, path: string, over: { headers?: Record<string, string>; body?: string } = {}) => ({
  method,
  path,
  headers: { host: "127.0.0.1:4815", ...(method === "POST" ? { "x-divination-token": "tok" } : {}), ...over.headers },
  body: over.body ?? "",
});
const json = async (r: ReturnType<typeof req>) => {
  const res = await app.handle(r);
  return { status: res.status, body: JSON.parse(res.body) };
};

test("the page is served with the token filled in", async () => {
  const res = await app.handle(req("GET", "/"));
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"]!, /^text\/html/);
  assert.ok(res.body.includes('content="tok"'));
  assert.ok(!res.body.includes("__DIVINATION_TOKEN__"));
  assert.ok(existsSync(ctx.paths.site)); // rendered on first request
});

test("the page is never cached and may load nothing from elsewhere", async () => {
  const res = await app.handle(req("GET", "/"));
  assert.equal(res.headers["cache-control"], "no-store");
  assert.match(res.headers["content-security-policy"]!, /default-src 'none'/);
  assert.match(res.headers["content-security-policy"]!, /connect-src 'self'/);
});

test("requests from another host name are refused", async () => {
  assert.equal((await app.handle(req("GET", "/", { headers: { host: "evil.example" } }))).status, 403);
  assert.equal((await app.handle(req("GET", "/", { headers: { host: "127.0.0.1:9999" } }))).status, 403);
  assert.equal((await app.handle({ method: "GET", path: "/", headers: {}, body: "" })).status, 403);
  assert.equal((await app.handle(req("GET", "/api/status", { headers: { host: "localhost:4815" } }))).status, 200);
});

test("posts without the token are refused and do nothing", async () => {
  const body = '{"enricher":"fake-enricher","key":"a"}';
  assert.equal((await app.handle(req("POST", "/api/enrich", { headers: { "x-divination-token": "wrong" }, body }))).status, 403);
  const noToken = { method: "POST", path: "/api/enrich", headers: { host: "127.0.0.1:4815" }, body };
  assert.equal((await app.handle(noToken)).status, 403);
  assert.equal((await app.handle(req("POST", "/api/live", { headers: { "x-divination-token": "" }, body: '{"on":false}' }))).status, 403);
  await settle();
  assert.equal(runs.length, 0);
  assert.equal(app.live.state().live, true);
});

test("status reports the timer, the page and the jobs", async () => {
  const { status, body } = await json(req("GET", "/api/status"));
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body).sort(), ["job", "lastJob", "live", "nextTickAt", "renderedAt", "sources", "startedAt"]);
  assert.deepEqual(body.sources.map((x: { id: string; title: string; state: string }) => [x.id, x.title, x.state]), [["fake", "Fake", "ok"]]);
  assert.equal(body.startedAt, ctx.now());
  assert.deepEqual([body.live, body.nextTickAt, body.job, body.lastJob], [true, null, null, null]);
});

test("pause and start through the API", async () => {
  assert.equal((await json(req("POST", "/api/live", { body: '{"on":false}' }))).body.live, false);
  const started = await json(req("POST", "/api/live", { body: '{"on":true}' }));
  assert.equal(started.body.live, true);
  assert.equal(typeof started.body.nextTickAt, "number");
  assert.equal((await app.handle(req("POST", "/api/live", { body: '{"on":"yes"}' }))).status, 400);
});

test("refresh now runs a tick as a job and re-renders the page", async () => {
  const before = (await json(req("GET", "/api/status"))).body.renderedAt;
  assert.equal((await app.handle(req("POST", "/api/tick"))).status, 202);
  await settle();
  const after = (await json(req("GET", "/api/status"))).body;
  assert.deepEqual([after.job, after.lastJob.name, after.lastJob.ok], [null, "tick", true]);
  assert.ok(after.renderedAt > before);
});

test("an enrich press runs once, then the page is re-rendered", async () => {
  assert.equal((await app.handle(req("POST", "/api/enrich", { body: '{"enricher":"fake-enricher","key":"a"}' }))).status, 202);
  await settle();
  assert.deepEqual(runs.map((r) => r.map((i) => i.key)), [["a"]]);
  const status = (await json(req("GET", "/api/status"))).body;
  assert.deepEqual([status.job, status.lastJob.name, status.lastJob.ok], [null, "enrich:fake-enricher:a", true]);
  assert.ok(status.renderedAt > 0);
});

test("a second press while one is running is refused", async () => {
  assert.equal((await app.handle(req("POST", "/api/enrich", { body: '{"enricher":"slow-enricher","key":"a"}' }))).status, 202);
  assert.equal((await app.handle(req("POST", "/api/tick"))).status, 409);
  assert.equal((await app.handle(req("POST", "/api/enrich", { body: '{"enricher":"fake-enricher","key":"a"}' }))).status, 409);
  await settle();
  assert.equal(runs.length, 0);
  assert.equal((await json(req("GET", "/api/status"))).body.job.name, "enrich:slow-enricher:a");
});

test("a failing press is reported, not thrown", async () => {
  assert.equal((await app.handle(req("POST", "/api/enrich", { body: '{"enricher":"nope","key":"a"}' }))).status, 202);
  await settle();
  assert.match((await json(req("GET", "/api/status"))).body.lastJob.error, /unknown enricher nope/);
});

test("bad bodies, unknown paths and wrong methods", async () => {
  assert.equal((await app.handle(req("POST", "/api/live", { body: "not json" }))).status, 400);
  assert.equal((await app.handle(req("POST", "/api/live", { body: "x".repeat(10_001) }))).status, 400);
  assert.equal((await app.handle(req("POST", "/api/enrich", { body: '{"enricher":"fake-enricher"}' }))).status, 400);
  assert.equal((await app.handle(req("POST", "/api/enrich", { body: '{"enricher":7,"key":"a"}' }))).status, 400);
  assert.equal((await app.handle(req("GET", "/nope"))).status, 404);
  assert.equal((await app.handle(req("GET", "/api/tick"))).status, 405);
  assert.equal((await app.handle(req("DELETE", "/api/status"))).status, 405);
});

test("nothing the server does by itself calls the LLM", async () => {
  await app.handle(req("GET", "/"));
  await app.handle(req("POST", "/api/tick"));
  await app.handle(req("POST", "/api/live", { body: '{"on":true}' }));
  await settle();
  timers.fire();
  await settle();
  assert.equal(runs.length, 0);
  assert.ok(!exec.calls.some((call) => call[0] === "claude"));
});

// Marking lines as done

test("marking a line done remembers it, redraws the page, and can be undone", async () => {
  const before = (await json(req("GET", "/api/status"))).body.renderedAt;
  await new Promise((resolve) => setTimeout(resolve, 15));
  const marked = await json(req("POST", "/api/done", { body: JSON.stringify({ key: "pr:o/r#1@abc", done: true }) }));
  assert.equal(marked.status, 200);
  assert.ok(marked.body.renderedAt > before); // open pages reload themselves
  assert.deepEqual(Object.keys(readDone(ctx)), ["pr:o/r#1@abc"]);

  const undone = await json(req("POST", "/api/done", { body: JSON.stringify({ key: "pr:o/r#1@abc", done: false }) }));
  assert.equal(undone.status, 200);
  assert.deepEqual(readDone(ctx), {});
});

test("a done mark needs the token, a key and a yes or no", async () => {
  const body = JSON.stringify({ key: "k", done: true });
  assert.equal((await app.handle(req("POST", "/api/done", { body, headers: { "x-divination-token": "wrong" } }))).status, 403);
  assert.equal((await app.handle(req("GET", "/api/done"))).status, 405);
  for (const bad of [{ done: true }, { key: "", done: true }, { key: "k" }, { key: "k", done: "yes" }, { key: "x".repeat(401), done: true }]) {
    assert.equal((await app.handle(req("POST", "/api/done", { body: JSON.stringify(bad) }))).status, 400, JSON.stringify(bad));
  }
  assert.deepEqual(readDone(ctx), {});
});

// Activity: what a refresh or a Claude call is doing, and what it did

test("a refresh shows each source's progress in status and leaves a story in the activity log", async () => {
  assert.equal((await json(req("POST", "/api/tick"))).status, 202);
  await settle();
  const { body } = await json(req("GET", "/api/status"));
  assert.equal(body.sources[0].state, "ok");
  assert.equal(typeof body.sources[0].ms, "number");

  const log = await json(req("GET", "/api/activity"));
  assert.equal(log.status, 200);
  const texts = log.body.lines.map((l: { text: string }) => l.text);
  assert.equal(texts[0], "Refresh started (Refresh now)");
  assert.ok(texts.includes("Fake: reading…"));
  assert.ok(texts.some((t: string) => /^Fake: ok in /.test(t)));
  assert.ok(texts.some((t: string) => /^Refresh finished in /.test(t)));
  assert.ok(log.body.lines.every((l: { at: number; level: string }) => typeof l.at === "number" && ["info", "error"].includes(l.level)));
});

test("a press that asks again reruns an item that was already done, and anything but true or false is refused", async () => {
  await app.handle(req("POST", "/api/enrich", { body: '{"enricher":"fake-enricher","key":"a"}' }));
  await settle();
  const before = runs.length;
  assert.equal((await app.handle(req("POST", "/api/enrich", { body: '{"enricher":"fake-enricher","key":"a"}' }))).status, 202);
  await settle();
  assert.equal(runs.length, before); // done already: nothing is sent

  assert.equal((await app.handle(req("POST", "/api/enrich", { body: '{"enricher":"fake-enricher","key":"a","again":true}' }))).status, 202);
  await settle();
  assert.equal(runs.length, before + 1);

  assert.equal((await app.handle(req("POST", "/api/enrich", { body: '{"enricher":"fake-enricher","key":"a","again":"yes"}' }))).status, 400);
});

test("asking for enrichment is in the activity log, and the log needs the right host but no token", async () => {
  await json(req("POST", "/api/enrich", { body: JSON.stringify({ enricher: "fake-enricher", key: "a" }) }));
  await settle();
  const log = await json(req("GET", "/api/activity"));
  assert.ok(log.body.lines.some((l: { text: string }) => l.text === "Asked for fake-enricher on a (1 item)"));
  assert.equal((await app.handle(req("GET", "/api/activity", { headers: { host: "evil.example" } }))).status, 403);
  assert.equal((await app.handle(req("POST", "/api/activity"))).status, 405);
});

// Review fix 1: what the page says about freshness must be true when it is opened

test("the page is drawn afresh for each visit, without touching the page file", async () => {
  mkdirSync(dirname(ctx.paths.site), { recursive: true });
  writeFileSync(ctx.paths.site, "<html>A PAGE DRAWN DAYS AGO</html>");
  const res = await app.handle(req("GET", "/"));
  assert.equal(res.status, 200);
  assert.ok(!res.body.includes("A PAGE DRAWN DAYS AGO"));
  assert.ok(res.body.includes('id="needs-you"'));
  assert.ok(res.body.includes('content="tok"'));
  // Rewriting the file here would make every other open tab reload, which would redraw it again.
  assert.equal(readFileSync(ctx.paths.site, "utf8"), "<html>A PAGE DRAWN DAYS AGO</html>");
});

// Review fix 3: the page cannot be put in a frame, and only its own script may run

test("the page refuses to be framed and allows only the one script it carries", async () => {
  const res = await app.handle(req("GET", "/"));
  const policy = res.headers["content-security-policy"]!;
  assert.match(policy, /frame-ancestors 'none'/);
  assert.equal(res.headers["x-frame-options"], "DENY");

  assert.ok(!/script-src[^;]*'unsafe-inline'/.test(policy));
  const scripts = [...res.body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  assert.equal(scripts.length, 1);
  const hash = createHash("sha256").update(scripts[0]!).digest("base64");
  assert.ok(policy.includes(`script-src 'sha256-${hash}'`), policy);
});

// Streaming: the page follows the activity log as it is written

const sse = (chunks: string[]) =>
  chunks
    .join("")
    .split("\n\n")
    .filter((block) => block !== "")
    .map((block) => {
      const field = (name: string) => block.split("\n").find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);
      return { event: field("event"), id: field("id"), data: JSON.parse(field("data") ?? "null") };
    });

test("the activity stream sends what has happened so far, then each new line as it happens", async () => {
  await json(req("POST", "/api/enrich", { body: JSON.stringify({ enricher: "fake-enricher", key: "a" }) }));
  await settle();

  const res = await app.handle(req("GET", "/api/activity/stream"));
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.body, "");

  const written: string[] = [];
  const stop = res.stream!((chunk) => written.push(chunk));
  const backlog = sse(written);
  assert.equal(backlog[0]!.event, "line");
  assert.equal(backlog[0]!.data.text, "Asked for fake-enricher on a (1 item)");
  assert.equal(backlog[0]!.id, String(backlog[0]!.data.id));

  const before = written.length;
  await json(req("POST", "/api/tick"));
  await settle();
  const fresh = sse(written.slice(before));
  assert.equal(fresh[0]!.data.text, "Refresh started (Refresh now)");
  assert.ok(fresh.some((e) => /^Refresh finished in /.test(e.data.text)));

  stop();
  const after = written.length;
  await json(req("POST", "/api/tick"));
  await settle();
  assert.equal(written.length, after);
});

test("a page that reconnects is sent only what it has not seen", async () => {
  await json(req("POST", "/api/tick"));
  await settle();
  const all: string[] = [];
  (await app.handle(req("GET", "/api/activity/stream"))).stream!((chunk) => all.push(chunk))();
  const seen = sse(all);
  assert.ok(seen.length >= 3);

  const rest: string[] = [];
  (await app.handle(req("GET", "/api/activity/stream", { headers: { "last-event-id": seen[1]!.id! } }))).stream!((chunk) => rest.push(chunk))();
  assert.deepEqual(sse(rest), seen.slice(2));
});

test("text Claude is still writing reaches the stream piece by piece", async () => {
  const chatty: Enricher<unknown> = {
    id: "chatty",
    items: () => [{ key: "a", hash: "chatty-a", input: 1 }],
    run: async (_items, c) => {
      c.log("llm-text", { text: "Hel", start: true });
      c.log("llm-text", { text: "lo" });
      return { a: "out" };
    },
  };
  const talking = createApp(ctx, [sourceWith(ctx, chatty)], "tok", timers);
  const written: string[] = [];
  (await talking.handle(req("GET", "/api/activity/stream"))).stream!((chunk) => written.push(chunk));
  await talking.handle(req("POST", "/api/enrich", { body: JSON.stringify({ enricher: "chatty", key: "a" }) }));
  await settle();

  const got = sse(written);
  const line = got.find((e) => e.event === "line" && e.data.text === "Claude: Hel")!;
  assert.ok(line);
  assert.deepEqual(got.find((e) => e.event === "more"), { event: "more", id: undefined, data: { id: line.data.id, text: "lo" } });
});

test("the activity stream needs the right host, and is read, not posted to", async () => {
  assert.equal((await app.handle(req("GET", "/api/activity/stream", { headers: { host: "evil.example" } }))).status, 403);
  assert.equal((await app.handle(req("POST", "/api/activity/stream"))).status, 405);
});

// Refresh now can ask Claude to do the hand-fed reads

function feeding(local: object, feed: () => Promise<unknown>) {
  const c = contextWith({ sources: ["fake"], fake: { transport: "inbox" }, ...local }, { exec });
  let asked = 0;
  const source = fakeSource({
    feed: () => {
      asked++;
      return feed();
    },
    fromInbox: (dropped) => dropped,
  });
  return { app: createApp(c, [source], "tok", timers), asked: () => asked };
}

test("Refresh now asks Claude for a hand-fed source after its plain refresh; the timer never does", async () => {
  const f = feeding({ claudeReads: { onRefresh: true, throttleMinutes: 0 } }, async () => ({ n: 1 }));
  assert.equal((await f.app.handle(req("POST", "/api/tick"))).status, 202);
  await settle();
  assert.equal(f.asked(), 1);
  const log = JSON.parse((await f.app.handle(req("GET", "/api/activity"))).body).lines.map((l: { text: string }) => l.text);
  assert.ok(log.findIndex((t: string) => /^Refresh finished/.test(t)) < log.indexOf("Fake: asking Claude to read it…"));
  assert.equal(JSON.parse((await f.app.handle(req("GET", "/api/status"))).body).lastJob.ok, true);

  await f.app.handle(req("POST", "/api/live", { body: '{"on":true}' }));
  timers.fire();
  await settle();
  assert.equal(f.asked(), 1); // with no throttle at all, so this is the timer's own rule
});

test("with the setting off, Refresh now never asks Claude", async () => {
  const f = feeding({}, async () => ({ n: 1 }));
  await f.app.handle(req("POST", "/api/tick"));
  await settle();
  assert.equal(f.asked(), 0);
});

test("a Claude read that fails is what the refresh reports, though the plain refresh went through", async () => {
  const f = feeding({ claudeReads: { onRefresh: true } }, async () => {
    throw new Error("claude failed: Failed to authenticate");
  });
  await f.app.handle(req("POST", "/api/tick"));
  await settle();
  const status = JSON.parse((await f.app.handle(req("GET", "/api/status"))).body);
  assert.deepEqual([status.lastJob.ok, status.lastJob.error], [false, "Fake: claude failed: Failed to authenticate"]);
  assert.equal(status.sources[0].state, "failed");
  assert.equal(status.sources[0].error, "claude failed: Failed to authenticate");
});
