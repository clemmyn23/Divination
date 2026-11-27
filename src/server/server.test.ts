import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { beforeEach, test } from "node:test";
import { contextWith, fakeExec, fakeSource, fakeTimers, settle, sourceWith } from "../../test/helpers.ts";
import type { Context, EnrichItem, Enricher } from "../core/types.ts";
import { readDone } from "../core/done.ts";
import { HttpError } from "../core/http.ts";
import { type PostRequest, type PostResult, Refusal } from "../sources/github/review/post.ts";
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
  assert.deepEqual(Object.keys(body).sort(), ["feeds", "fix", "job", "lastJob", "live", "nextTickAt", "renderedAt", "sources", "startedAt"]);
  assert.deepEqual(body.sources.map((x: { id: string; title: string; state: string }) => [x.id, x.title, x.state]), [["fake", "Fake", "ok"]]);
  assert.equal(body.startedAt, ctx.now());
  assert.deepEqual([body.live, body.nextTickAt, body.job, body.lastJob, body.fix], [true, null, null, null, null]);
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

test("Refresh now asks Claude for a hand-fed source after its plain refresh; the timer does not, with no interval set", async () => {
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

// The timer can have Claude read a source too, when it was given an interval

test("with an interval set, the timer has Claude read that source after its plain refresh, and not again before it is due", async () => {
  const f = feeding({ claudeReads: { everyMinutes: { fake: 30 } } }, async () => ({ n: 1 }));
  await f.app.handle(req("POST", "/api/live", { body: '{"on":true}' })); // going live ticks at once
  await settle();
  assert.equal(f.asked(), 1);
  const log = JSON.parse((await f.app.handle(req("GET", "/api/activity"))).body).lines.map((l: { text: string }) => l.text);
  assert.ok(log.findIndex((t: string) => /^Refresh finished/.test(t)) < log.indexOf("Fake: asking Claude to read it…"));
  assert.equal(JSON.parse((await f.app.handle(req("GET", "/api/status"))).body).lastJob.ok, true);

  timers.fire(); // the next tick, with no time gone by
  await settle();
  assert.equal(f.asked(), 1);
});

test("outside working hours the timer collects nothing, and does not ask Claude either", async () => {
  const f = feeding({ claudeReads: { everyMinutes: { fake: 30 } }, tick: { days: [] } }, async () => ({ n: 1 }));
  await f.app.handle(req("POST", "/api/live", { body: '{"on":true}' }));
  await settle();
  assert.equal(f.asked(), 0);
});

test("a timed Claude read that fails is what the tick reports", async () => {
  const f = feeding({ claudeReads: { everyMinutes: { fake: 30 } } }, async () => {
    throw new Error("claude failed: Failed to authenticate");
  });
  await f.app.handle(req("POST", "/api/live", { body: '{"on":true}' }));
  await settle();
  const status = JSON.parse((await f.app.handle(req("GET", "/api/status"))).body);
  assert.deepEqual([status.lastJob.ok, status.lastJob.error], [false, "Fake: claude failed: Failed to authenticate"]);
});

// One source read now, and choosing what Refresh now reads

test("a source's Read now has Claude read that source at once, whatever Refresh now is set to", async () => {
  const f = feeding({}, async () => ({ n: 1 })); // claudeReads.onRefresh is off
  assert.equal((await f.app.handle(req("POST", "/api/feed", { body: '{"source":"fake"}' }))).status, 202);
  await settle();
  assert.equal(f.asked(), 1);
  const status = JSON.parse((await f.app.handle(req("GET", "/api/status"))).body);
  assert.deepEqual([status.lastJob.name, status.lastJob.ok], ["feed:fake", true]);
});

test("Read now is refused for a source Claude cannot read, for nonsense, and without the token", async () => {
  const f = feeding({ fake: { transport: "api" } }, async () => ({ n: 1 }));
  assert.equal((await f.app.handle(req("POST", "/api/feed", { body: '{"source":"fake"}' }))).status, 400);
  assert.equal((await f.app.handle(req("POST", "/api/feed", { body: '{"source":"nope"}' }))).status, 400);
  assert.equal((await f.app.handle(req("POST", "/api/feed", { body: '{"source":7}' }))).status, 400);
  assert.equal((await f.app.handle(req("POST", "/api/feed", { body: '{"source":"fake"}', headers: { "x-divination-token": "wrong" } }))).status, 403);
  assert.equal(f.asked(), 0);
});

test("Read now waits its turn: it is refused while another job runs", async () => {
  let release = () => {};
  const f = feeding({}, () => new Promise((resolve) => (release = () => resolve({ n: 1 }))));
  assert.equal((await f.app.handle(req("POST", "/api/feed", { body: '{"source":"fake"}' }))).status, 202);
  await settle();
  assert.equal((await f.app.handle(req("POST", "/api/feed", { body: '{"source":"fake"}' }))).status, 409);
  release();
  await settle();
});

test("the status lists the sources Claude can read, with what Refresh now and the timer do for each", async () => {
  const f = feeding({ claudeReads: { onRefresh: true, everyMinutes: { fake: 30 } } }, async () => ({ n: 1 }));
  const status = JSON.parse((await f.app.handle(req("GET", "/api/status"))).body);
  assert.deepEqual(status.feeds, [{ id: "fake", title: "Fake", onRefresh: true, everyMinutes: 30 }]);
  // A source that is fetched, not read by Claude, is not one of them.
  const fetched = feeding({ fake: { transport: "api" } }, async () => ({ n: 1 }));
  assert.deepEqual(JSON.parse((await fetched.app.handle(req("GET", "/api/status"))).body).feeds, []);
});

test("I can switch a source off for Refresh now from the page, and back on", async () => {
  const f = feeding({ claudeReads: { onRefresh: true, throttleMinutes: 0 } }, async () => ({ n: 1 }));
  const off = await f.app.handle(req("POST", "/api/reads", { body: '{"source":"fake","on":false}' }));
  assert.equal(off.status, 200);
  assert.equal(JSON.parse(off.body).feeds[0].onRefresh, false);
  await f.app.handle(req("POST", "/api/tick"));
  await settle();
  assert.equal(f.asked(), 0);

  await f.app.handle(req("POST", "/api/reads", { body: '{"source":"fake","on":true}' }));
  await f.app.handle(req("POST", "/api/tick"));
  await settle();
  assert.equal(f.asked(), 1);

  assert.equal((await f.app.handle(req("POST", "/api/reads", { body: '{"source":"fake","on":"yes"}' }))).status, 400);
  assert.equal((await f.app.handle(req("POST", "/api/reads", { body: '{"source":"nope","on":true}' }))).status, 400);
  assert.equal((await f.app.handle(req("GET", "/api/reads"))).status, 405);
});

// ---- Fixing a PR ----

/** An app whose GitHub source has two fixable PRs, with a fix that waits to be let go. */
function fixApp(local: object = {}) {
  const c = contextWith({ sources: ["github"], ...local }, { exec: fakeExec({}) });
  const pr = (number: number) => ({
    key: `o/r#${number}`, repo: "o/r", number, title: `My change ${number}`, url: `https://git.example.com/o/r/pull/${number}`, headSha: `sha${number}`,
    createdAt: c.now() - 1000, updatedAt: c.now() - 1000, draft: false, additions: 1, deletions: 1, ci: "fail", review: "none", conflicts: false, unanswered: 0,
    waits: { on: "fix", reasons: ["CI failing"] }, fix: { can: true, spent: false },
  });
  const data = { login: "me", prs: [], mine: [pr(8), pr(9)] };
  mkdirSync(dirname(c.paths.data("github")), { recursive: true });
  writeFileSync(c.paths.data("github"), JSON.stringify({ source: "github", ok: true, collectedAt: c.now(), attemptedAt: c.now(), data }));
  const fixed: string[] = [];
  const release: (() => void)[] = [];
  const fix = (_ctx: Context, key: string) =>
    new Promise<{ key: string; outcome: "pushed"; text: string }>((resolve) => {
      fixed.push(key);
      release.push(() => resolve({ key, outcome: "pushed", text: "done" }));
    });
  const fixing = createApp(c, [fakeSource({ id: "github", collect: async () => data })], "tok", fakeTimers(), { fix });
  const post = async (path: string, body = "") => {
    const res = await fixing.handle(req("POST", path, { body }));
    return { status: res.status, body: JSON.parse(res.body) };
  };
  const letGo = async () => {
    release.shift()!();
    await settle();
  };
  return { ctx: c, app: fixing, fixed, post, letGo, status: () => fixing.status() };
}

test("a fix press starts a job named for its PR, and a second press while it runs is refused", async () => {
  const f = fixApp();
  assert.equal((await f.post("/api/fix", '{"key":"o/r#8"}')).status, 202);
  await settle();
  assert.equal(f.status().job!.name, "fix:o/r#8");
  assert.deepEqual(f.status().fix, { key: "o/r#8", index: 1, total: 1, stopping: false });
  assert.equal((await f.post("/api/fix", '{"key":"o/r#9"}')).status, 409);
  await f.letGo();
  assert.deepEqual(f.fixed, ["o/r#8"]);
  assert.equal(f.status().job, null);
  assert.equal(f.status().fix, null);
  assert.deepEqual([f.status().lastJob!.name, f.status().lastJob!.ok], ["fix:o/r#8", true]);
});

test("the fix key must be a PR key or all", async () => {
  const f = fixApp();
  for (const body of ["{}", '{"key":7}', '{"key":"all; rm"}', '{"key":"o/r"}', `{"key":"o/r#${"1".repeat(400)}"}`]) {
    assert.equal((await f.post("/api/fix", body)).status, 400, body);
  }
  assert.deepEqual(f.fixed, []);
});

test("a fix needs the page's token and the right host", async () => {
  const f = fixApp();
  const body = '{"key":"o/r#8"}';
  assert.equal((await f.app.handle(req("POST", "/api/fix", { headers: { "x-divination-token": "wrong" }, body }))).status, 403);
  assert.equal((await f.app.handle(req("POST", "/api/fix", { headers: { host: "evil.example.com" }, body }))).status, 403);
  assert.equal((await f.app.handle(req("GET", "/api/fix"))).status, 405);
  assert.equal((await f.app.handle(req("POST", "/api/fix/stop", { headers: { "x-divination-token": "wrong" } }))).status, 403);
  assert.deepEqual(f.fixed, []);
});

test("status says which PR a Fix all is on, and it can be stopped after the PR in hand", async () => {
  const f = fixApp();
  assert.equal((await f.post("/api/fix", '{"key":"all"}')).status, 202);
  await settle();
  assert.deepEqual(f.status().fix, { key: "o/r#8", index: 1, total: 2, stopping: false });

  const stopped = await f.post("/api/fix/stop"); // answered while the job runs, not refused as busy
  assert.equal(stopped.status, 200);
  assert.deepEqual(stopped.body.fix, { key: "o/r#8", index: 1, total: 2, stopping: true });

  await f.letGo();
  assert.deepEqual(f.fixed, ["o/r#8"]); // the second was skipped
  assert.equal(f.status().job, null);
  assert.equal(f.status().fix, null);

  // The next Fix all is not stopped by the last one's request.
  await f.post("/api/fix", '{"key":"all"}');
  await settle();
  await f.letGo();
  await f.letGo();
  assert.deepEqual(f.fixed, ["o/r#8", "o/r#8", "o/r#9"]);
});

test("stop with nothing to stop is refused", async () => {
  const f = fixApp();
  assert.equal((await f.post("/api/fix/stop")).status, 409);
  await f.post("/api/fix", '{"key":"o/r#8"}'); // a single fix is never cut short
  await settle();
  assert.equal((await f.post("/api/fix/stop")).status, 409);
  await f.letGo();
});

test("worktrees left by a killed run are swept when the server starts", async () => {
  const c = contextWith({ sources: ["fake"], github: { fix: { clones: { "o/r": "/work/monolith" } } } }, { exec });
  const stray = `${c.paths.out}/fix/work/o-r-3`;
  mkdirSync(stray, { recursive: true });
  createApp(c, [fakeSource()], "tok", fakeTimers());
  await settle();
  assert.ok(!existsSync(stray));
  assert.ok(exec.calls.some((call) => call.join(" ") === "git -C /work/monolith worktree prune")); // the clone forgets it

  // With nothing left behind, starting the server runs no git at all.
  const quiet = fakeExec({});
  createApp(contextWith({ sources: ["fake"] }, { exec: quiet }), [fakeSource()], "tok", fakeTimers());
  await settle();
  assert.deepEqual(quiet.calls, []);
});

// ---- Posting a review ----

/** An app whose posting is a stand-in that records what it was asked and answers as told. */
function reviewApp(answer: () => Promise<PostResult> = async () => ({ comments: 2, inBody: 1, url: "https://git.example.com/o/r/pull/1#pullrequestreview-9" })) {
  const asked: PostRequest[] = [];
  const logged: string[] = [];
  const fields: Record<string, object | undefined> = {}; // what each event was last logged with
  const c = contextWith(
    { sources: ["fake"] },
    {
      exec: fakeExec({}),
      log: (event, given) => {
        logged.push(event);
        fields[event] = given;
      },
    },
  );
  const slow: Enricher<unknown> = { id: "slow-enricher", items: () => [{ key: "a", hash: "slow-a", input: 1 }], run: () => new Promise(() => {}) };
  const posting = createApp(c, [sourceWith(c, slow)], "tok", fakeTimers(), {
    post: async (_ctx, request) => {
      asked.push(request);
      return answer();
    },
  });
  const send = async (body: string, headers?: Record<string, string>) => {
    const res = await posting.handle(req("POST", "/api/review/post", { body, ...(headers ? { headers } : {}) }));
    return { status: res.status, body: JSON.parse(res.body) };
  };
  return { ctx: c, app: posting, asked, send, logged, fields };
}

const REVIEW = { key: "o/r#1@aaa111", draft: "0123456789abcdef", event: "APPROVE", message: "lgtm", notes: [{ index: 0, text: "Rename `x`." }] };

test("a press of Post posts that review and answers with what was posted", async () => {
  const r = reviewApp();
  const res = await r.send(JSON.stringify(REVIEW));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { comments: 2, inBody: 1, url: "https://git.example.com/o/r/pull/1#pullrequestreview-9" });
  assert.deepEqual(r.asked, [REVIEW]);
  assert.ok(existsSync(r.ctx.paths.site)); // redrawn, so open pages show that it was posted
});

test("a review is not posted without the page's token, or from another host", async () => {
  const r = reviewApp();
  assert.equal((await r.send(JSON.stringify(REVIEW), { "x-divination-token": "wrong" })).status, 403);
  assert.equal((await r.send(JSON.stringify(REVIEW), { host: "evil.example" })).status, 403);
  assert.equal((await r.app.handle(req("GET", "/api/review/post"))).status, 405);
  assert.deepEqual(r.asked, []);
});

test("a malformed review request is refused and nothing is posted", async () => {
  const r = reviewApp();
  for (const body of ['{"key":"o/r#1","draft":"0123456789abcdef","event":"APPROVE"}',
    '{"key":"o/r#1@aaa111","event":"APPROVE"}',
    '{"key":"o/r#1@aaa111","draft":"0123456789abcdef","event":"MERGE"}',
    '{"key":"o/r#1@aaa111","draft":"0123456789abcdef","event":"COMMENT","notes":[{"index":"0","text":"x"}]}',
    "{}",]) {
    const res = await r.send(body);
    assert.equal(res.status, 400, body);
    assert.equal(typeof res.body.error, "string");
  }
  assert.deepEqual(r.asked, []);
});

test("a refused post says why; a post GitHub rejected says what GitHub said", async () => {
  const refused = reviewApp(async () => {
    throw new Refusal("the PR has new commits since this draft was written; rerun the review");
  });
  assert.deepEqual(await refused.send(JSON.stringify(REVIEW)), { status: 409, body: { error: "the PR has new commits since this draft was written; rerun the review" } });

  const rejected = reviewApp(async () => {
    throw new Error("HTTP 422 from https://git.example.com/api/v3/repos/o/r/pulls/1/reviews: Unprocessable Entity");
  });
  const res = await rejected.send(JSON.stringify(REVIEW));
  assert.equal(res.status, 502);
  assert.match(res.body.error, /HTTP 422/);
  assert.ok(rejected.logged.includes("review-post-failed"));
});

test("a long review fits: this route takes a larger body than the others", async () => {
  const r = reviewApp();
  const long = { ...REVIEW, notes: Array.from({ length: 5 }, (_, index) => ({ index, text: "x".repeat(9000) })) };
  assert.equal((await r.send(JSON.stringify(long))).status, 200);
  assert.equal((await r.send(JSON.stringify({ ...REVIEW, pad: "x".repeat(200_001) }))).status, 400);
  assert.equal((await r.app.handle(req("POST", "/api/live", { body: `{"on":true,"pad":"${"x".repeat(10_001)}"}` }))).status, 400);
});

test("a review can be posted while a refresh or a Claude call is running", async () => {
  const r = reviewApp();
  await r.app.handle(req("POST", "/api/enrich", { body: '{"enricher":"slow-enricher","key":"a"}' }));
  await settle();
  assert.notEqual(r.app.status().job, null);
  assert.equal((await r.send(JSON.stringify(REVIEW))).status, 200);
});

test("what GitHub answered is shown to me but not written to the log: only its status is", async () => {
  const rejected = reviewApp(async () => {
    throw new HttpError(422, "https://git.example.com/api/v3/repos/o/r/pulls/1/reviews", '{"message":"the words of my review, echoed back"}');
  });
  const res = await rejected.send(JSON.stringify(REVIEW));
  assert.equal(res.status, 502);
  assert.match(res.body.error, /echoed back/);
  assert.deepEqual(rejected.fields["review-post-failed"], { key: "o/r#1", error: "GitHub answered 422" });
});

test("once the review is on the PR, a page that cannot be redrawn does not make the post look failed", async () => {
  const r = reviewApp();
  mkdirSync(r.ctx.paths.site, { recursive: true }); // a folder where the page file goes: it cannot be written
  const res = await r.send(JSON.stringify(REVIEW));
  assert.equal(res.status, 200);
  assert.equal(res.body.comments, 2);
});

test("a review on its way to GitHub counts as work in hand, so a restart waits for it", async () => {
  let letGo = () => {};
  const r = reviewApp(() => new Promise((resolve) => (letGo = () => resolve({ comments: 0, inBody: 0 }))));
  assert.equal(r.app.busy(), false);
  const sending = r.send(JSON.stringify(REVIEW));
  await settle();
  assert.equal(r.app.busy(), true);
  assert.equal(r.app.status().job, null); // it is not a job: a refresh can still start
  letGo();
  await sending;
  assert.equal(r.app.busy(), false);

  await r.app.handle(req("POST", "/api/enrich", { body: '{"enricher":"slow-enricher","key":"a"}' }));
  await settle();
  assert.equal(r.app.busy(), true); // a running job is work in hand too
});
