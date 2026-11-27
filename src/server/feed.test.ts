import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { NOW, contextWith, fakeSource } from "../../test/helpers.ts";
import { readEnvelope } from "../core/pipeline.ts";
import { readJson, writeJson } from "../core/store.ts";
import type { Context, Source } from "../core/types.ts";
import { claudeFed, createFeeder, readsOnRefresh, setReadsOnRefresh } from "./feed.ts";

const MINUTE = 60_000;

function setup(local: object = {}) {
  let now = NOW;
  const logged: [string, Record<string, unknown>][] = [];
  const ctx = contextWith(
    { fake: { transport: "inbox" }, other: { transport: "inbox" }, claudeReads: { onRefresh: true }, ...local },
    { now: () => now, log: (event, fields) => logged.push([event, { ...(fields as object) }]) },
  );
  return { ctx, logged, events: () => logged.map(([event]) => event), wait: (ms: number) => (now += ms) };
}

/** A source whose Claude read answers `{ n }` and counts how often it was asked. */
function fed(over: Partial<Source<any>> = {}) {
  const calls: Context[] = [];
  const source = fakeSource({
    feed: async (ctx) => {
      calls.push(ctx);
      return { n: calls.length };
    },
    fromInbox: (dropped) => {
      const n = (dropped as { n?: unknown }).n;
      if (typeof n !== "number") throw new Error("fake inbox: n must be a number");
      return { doubled: n * 2 };
    },
    panels: (data: { doubled: number }) => [{ id: "fake", title: "Fake", tint: "mint", html: `<p>doubled ${data.doubled}</p>` }],
    ...over,
  });
  return { source, calls };
}

test("with the setting off, Claude is never asked", async () => {
  const { ctx, events } = setup({ claudeReads: { onRefresh: false } });
  const { source, calls } = fed();
  assert.deepEqual(await createFeeder()(ctx, [source]), []);
  assert.equal(calls.length, 0);
  assert.deepEqual(events(), []);
});

test("only a source that is fed through its inbox, and knows how to ask, is asked", async () => {
  const { ctx } = setup({ fake: { transport: "api" } });
  const fetched = fed(); // not on the inbox transport
  const silent = fakeSource({ id: "other" }); // on it, but with no way to ask
  assert.deepEqual(await createFeeder()(ctx, [fetched.source, silent]), []);
  assert.equal(fetched.calls.length, 0);
});

test("what Claude read is checked, written to the inbox, collected and drawn", async () => {
  const { ctx, logged } = setup();
  const { source } = fed();
  assert.deepEqual(await createFeeder()(ctx, [source]), []);

  assert.deepEqual(readJson(ctx.paths.inbox("fake"), null), { n: 1 });
  const envelope = readEnvelope(source, ctx);
  assert.equal(envelope.ok, true);
  assert.deepEqual(envelope.data, { doubled: 2 });
  assert.ok(readFileSync(ctx.paths.site, "utf8").includes("doubled 2"));

  assert.deepEqual(logged[0], ["feed-start", { source: "fake" }]);
  const [event, end] = logged[1]!;
  assert.equal(event, "feed");
  assert.deepEqual({ ...end, ms: 0 }, { source: "fake", ok: true, ms: 0 });
  assert.deepEqual(logged.slice(2).map(([e]) => e), ["collect-start", "collect"]);
});

test("an answer in the wrong shape is reported and leaves the last good inbox file alone", async () => {
  const { ctx, logged } = setup();
  writeJson(ctx.paths.inbox("fake"), { n: 7 });
  const { source } = fed({ feed: async () => ({ n: "many" }) });
  assert.deepEqual(await createFeeder()(ctx, [source]), ["Fake: fake inbox: n must be a number"]);
  assert.deepEqual(readJson(ctx.paths.inbox("fake"), null), { n: 7 });
  assert.deepEqual(logged.at(-1)![1].error, "fake inbox: n must be a number");
  assert.equal(logged.at(-1)![1].ok, false);
  assert.equal(existsSync(ctx.paths.site), false); // nothing changed, so nothing was redrawn
});

test("a read that fails is reported by its source's title and does not stop the next one", async () => {
  const { ctx } = setup();
  const broken = fed({
    feed: async () => {
      throw new Error("claude failed: Failed to authenticate");
    },
  });
  const fine = fed({ id: "other", title: "Other" });
  assert.deepEqual(await createFeeder()(ctx, [broken.source, fine.source]), ["Fake: claude failed: Failed to authenticate"]);
  assert.equal(fine.calls.length, 1);
  assert.deepEqual(readJson(ctx.paths.inbox("other"), null), { n: 1 });
});

test("pressing again within the throttle does not ask Claude again; once it has passed, it does", async () => {
  const { ctx, logged, wait } = setup({ claudeReads: { onRefresh: true, throttleMinutes: 2 } });
  const { source, calls } = fed();
  const feed = createFeeder();

  await feed(ctx, [source]);
  wait(30_000);
  assert.deepEqual(await feed(ctx, [source]), []); // not a failure: the refresh itself still happened
  assert.equal(calls.length, 1);
  assert.deepEqual(logged.at(-1), ["feed-skip", { source: "fake", waitMs: 90_000, throttleMinutes: 2 }]);

  wait(89_000);
  await feed(ctx, [source]);
  assert.equal(calls.length, 1);

  wait(1_000); // two minutes since the first read finished
  await feed(ctx, [source]);
  assert.equal(calls.length, 2);
});

test("a failed read is throttled too, and each source keeps its own time", async () => {
  const { ctx, wait } = setup({ claudeReads: { onRefresh: true, throttleMinutes: 2 } });
  let asked = 0;
  const broken = fed({
    feed: async () => {
      asked++;
      throw new Error("boom");
    },
  });
  const other = fed({ id: "other", title: "Other" });
  const feed = createFeeder();

  await feed(ctx, [broken.source]);
  wait(MINUTE);
  assert.deepEqual(await feed(ctx, [broken.source, other.source]), []); // the first is waiting; the second has never been asked
  assert.equal(asked, 1);
  assert.equal(other.calls.length, 1);
});

test("a throttle of 0 asks every time", async () => {
  const { ctx } = setup({ claudeReads: { onRefresh: true, throttleMinutes: 0 } });
  const { source, calls } = fed();
  const feed = createFeeder();
  await feed(ctx, [source]);
  await feed(ctx, [source]);
  assert.equal(calls.length, 2);
});

test("sources that fail for the same reason are reported together, once", async () => {
  const { ctx } = setup();
  const boom = async () => {
    throw new Error("claude failed: Failed to authenticate");
  };
  const failures = await createFeeder()(ctx, [fed({ feed: boom }).source, fed({ id: "other", title: "Other", feed: boom }).source]);
  assert.deepEqual(failures, ["Fake, Other: claude failed: Failed to authenticate"]);
});

// ---- On the timer ----

/** As `setup`, but on the real clock, so that an inbox file's own time lines up with `now`. */
function timed(local: object = {}) {
  let now = Date.now();
  const logged: [string, Record<string, unknown>][] = [];
  const ctx = contextWith(
    { fake: { transport: "inbox" }, other: { transport: "inbox" }, claudeReads: { everyMinutes: { fake: 30 } }, ...local },
    { now: () => now, log: (event, fields) => logged.push([event, { ...(fields as object) }]) },
  );
  return { ctx, logged, events: () => logged.map(([event]) => event), wait: (ms: number) => (now += ms) };
}
const TIMER = { on: "timer" } as const;

test("on the timer Claude reads only a source that was given an interval, whatever Refresh now is set to", async () => {
  const { ctx } = timed();
  const mine = fed();
  const other = fed({ id: "other", title: "Other" });
  const feed = createFeeder();
  assert.deepEqual(await feed(ctx, [mine.source, other.source], TIMER), []);
  assert.deepEqual([mine.calls.length, other.calls.length], [1, 0]);
  assert.deepEqual(readJson(ctx.paths.inbox("fake"), null), { n: 1 });
  // Refresh now is still off: the interval is the timer's alone.
  await feed(ctx, [mine.source, other.source]);
  assert.deepEqual([mine.calls.length, other.calls.length], [1, 0]);
});

test("an interval of 0, or none at all, keeps a source off the timer", async () => {
  const none = timed({ claudeReads: { onRefresh: true } });
  const a = fed();
  await createFeeder()(none.ctx, [a.source], TIMER);
  assert.equal(a.calls.length, 0);

  const zero = timed({ claudeReads: { everyMinutes: { fake: 0 } } });
  const b = fed();
  await createFeeder()(zero.ctx, [b.source], TIMER);
  assert.equal(b.calls.length, 0);
});

test("a timed read waits out its interval, and a tick that is not due says nothing", async () => {
  const { ctx, events, wait } = timed();
  const { source, calls } = fed();
  const feed = createFeeder();

  await feed(ctx, [source], TIMER);
  const quiet = events().length;
  wait(15 * MINUTE);
  assert.deepEqual(await feed(ctx, [source], TIMER), []);
  assert.equal(calls.length, 1);
  assert.equal(events().length, quiet); // no line in the log for every tick that passes

  wait(15 * MINUTE);
  await feed(ctx, [source], TIMER);
  assert.equal(calls.length, 2);
});

test("the interval is rounded to the timer's ticks, so a tick that lands a little early still reads", async () => {
  const { ctx, wait } = timed(); // every 30 minutes, on a 15 minute tick
  const { source, calls } = fed();
  const feed = createFeeder();
  await feed(ctx, [source], TIMER);
  wait(29 * MINUTE + 50_000); // the read itself took a while, so the second tick comes up short
  await feed(ctx, [source], TIMER);
  assert.equal(calls.length, 2);
});

test("a sweep run by hand or by Refresh now counts: the timer waits its interval from the inbox file's time", async () => {
  const { ctx, wait } = timed();
  const { source, calls } = fed();
  writeJson(ctx.paths.inbox("fake"), { n: 7 }); // dropped just now, by something else

  const afterRestart = createFeeder(); // nothing remembered
  await afterRestart(ctx, [source], TIMER);
  assert.equal(calls.length, 0);
  wait(31 * MINUTE);
  await afterRestart(ctx, [source], TIMER);
  assert.equal(calls.length, 1);

  // And a read started by Refresh now holds the timer off in the same way.
  const pressed = timed({ claudeReads: { onRefresh: true, everyMinutes: { fake: 30 } } });
  const again = fed();
  const feed = createFeeder();
  await feed(pressed.ctx, [again.source]);
  pressed.wait(10 * MINUTE);
  await feed(pressed.ctx, [again.source], TIMER);
  assert.equal(again.calls.length, 1);
});

test("a timed read that fails is reported, and is not tried again until its interval has passed", async () => {
  const { ctx, wait } = timed();
  let asked = 0;
  const source = fakeSource({
    feed: async () => {
      asked++;
      throw new Error("claude failed: no connector");
    },
  });
  const feed = createFeeder();
  assert.deepEqual(await feed(ctx, [source], TIMER), ["Fake: claude failed: no connector"]);
  wait(15 * MINUTE);
  assert.deepEqual(await feed(ctx, [source], TIMER), []);
  assert.equal(asked, 1);
  wait(15 * MINUTE);
  await feed(ctx, [source], TIMER);
  assert.equal(asked, 2);
});

// ---- One source, now, and my own choice of what Refresh now reads ----

test("a forced read asks Claude for that one source now, whatever the settings and however recently it was read", async () => {
  const { ctx } = setup({ claudeReads: { onRefresh: false, throttleMinutes: 2 } });
  const mine = fed();
  const other = fed({ id: "other", title: "Other" });
  const feed = createFeeder();
  assert.deepEqual(await feed(ctx, [mine.source, other.source], { on: "force", source: "fake" }), []);
  assert.deepEqual(await feed(ctx, [mine.source, other.source], { on: "force", source: "fake" }), []); // no throttle
  assert.deepEqual([mine.calls.length, other.calls.length], [2, 0]);
  assert.deepEqual(readJson(ctx.paths.inbox("fake"), null), { n: 2 });
});

test("what Refresh now reads is my choice per source where I have made one, and the setting otherwise", async () => {
  const { ctx } = setup({ claudeReads: { onRefresh: true, throttleMinutes: 0 } });
  const mine = fed();
  const other = fed({ id: "other", title: "Other" });
  const feed = createFeeder();

  assert.deepEqual([readsOnRefresh(ctx, "fake"), readsOnRefresh(ctx, "other")], [true, true]);
  setReadsOnRefresh(ctx, "other", false);
  assert.deepEqual([readsOnRefresh(ctx, "fake"), readsOnRefresh(ctx, "other")], [true, false]);
  await feed(ctx, [mine.source, other.source]);
  assert.deepEqual([mine.calls.length, other.calls.length], [1, 0]);

  // With the setting off, a source I switched on is still read.
  const off = setup({ claudeReads: { onRefresh: false } });
  const picked = fed();
  setReadsOnRefresh(off.ctx, "fake", true);
  await createFeeder()(off.ctx, [picked.source]);
  assert.equal(picked.calls.length, 1);
});

test("my choice is kept beside the live switch, and neither overwrites the other", async () => {
  const { ctx } = setup();
  const state = join(ctx.paths.out, "state.json");
  writeJson(state, { live: false });
  setReadsOnRefresh(ctx, "fake", false);
  assert.deepEqual(readJson(state, null), { live: false, reads: { fake: false } });
});

test("the sources Claude can read are the ones fed through their inbox that know how to ask", () => {
  const { ctx } = setup({ fake: { transport: "api" } });
  const fetched = fed(); // not on the inbox transport
  const silent = fakeSource({ id: "other" }); // on it, but with no way to ask
  const asks = fed({ id: "other", title: "Other" });
  assert.deepEqual(claudeFed(ctx, [fetched.source, silent]).map((s) => s.id), []);
  assert.deepEqual(claudeFed(ctx, [fetched.source, asks.source]).map((s) => s.id), ["other"]);
});
