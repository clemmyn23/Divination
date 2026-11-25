import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { NOW, contextWith, fakeTimers } from "../../test/helpers.ts";
import { readJson } from "../core/store.ts";
import { createLive } from "./live.ts";

test("start ticks now and every 15 minutes; pause stops; the choice is saved", () => {
  const ctx = contextWith();
  const timers = fakeTimers();
  let ticks = 0;
  const live = createLive(ctx, async () => {
    ticks++;
  }, timers);

  assert.deepEqual(live.state(), { live: true, nextTickAt: null }); // on by default, nothing scheduled until start()

  live.start();
  live.start();
  assert.equal(ticks, 1);
  assert.deepEqual(timers.intervals, [15 * 60_000]);
  assert.equal(live.state().nextTickAt, NOW + 15 * 60_000);

  live.pause();
  assert.deepEqual(live.state(), { live: false, nextTickAt: null });
  assert.equal(timers.cleared, 1);
  assert.equal(readJson<{ live?: boolean }>(join(ctx.paths.out, "state.json"), {}).live, false);
  assert.equal(createLive(ctx, async () => {}, timers).state().live, false);
});

test("each interval ticks again and moves the next time on", () => {
  let now = NOW;
  const ctx = contextWith({}, { now: () => now });
  const timers = fakeTimers();
  let ticks = 0;
  const live = createLive(ctx, async () => {
    ticks++;
  }, timers);
  live.start();

  now = NOW + 15 * 60_000;
  timers.fire();
  assert.equal(ticks, 2);
  assert.equal(live.state().nextTickAt, NOW + 30 * 60_000);
});

test("start after pause schedules again and saves the choice", () => {
  const ctx = contextWith({ tick: { minutes: 5 } });
  const timers = fakeTimers();
  const live = createLive(ctx, async () => {}, timers);
  live.start();
  live.pause();
  live.start();
  assert.deepEqual(timers.intervals, [5 * 60_000, 5 * 60_000]);
  assert.equal(readJson<{ live?: boolean }>(join(ctx.paths.out, "state.json"), {}).live, true);
});

test("a tick that fails does not stop the timer or escape", async () => {
  const ctx = contextWith();
  const timers = fakeTimers();
  const live = createLive(ctx, async () => {
    throw new Error("tick blew up");
  }, timers);
  live.start();
  timers.fire();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(live.state().live, true);
});
