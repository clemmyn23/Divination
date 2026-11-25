import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, test } from "node:test";
import { NOW, captureLog, contextWith, fakeExec, fakeSource, sourceWith } from "../../../test/helpers.ts";
import type { Context, EnrichItem, Source } from "../../core/types.ts";
import { tick, tickCommand } from "./tick.ts";

let ctx: Context;
let collects: number;
let counting: Source<any>;

beforeEach(() => {
  ctx = contextWith({ sources: ["fake"] });
  collects = 0;
  counting = fakeSource({
    collect: async () => {
      collects++;
      return {};
    },
  });
});

function placeLock(c: Context, ageMs: number) {
  mkdirSync(dirname(c.paths.lock), { recursive: true });
  writeFileSync(c.paths.lock, "");
  const at = new Date(c.now() - ageMs);
  utimesSync(c.paths.lock, at, at);
}

test("outside working hours nothing runs", async () => {
  const saturday = contextWith({}, { now: () => Date.parse("2026-11-27T22:00:00Z") }); // Saturday 09:00 in Sydney
  assert.equal(await tick(saturday, [counting]), "outside-hours");
  assert.equal(collects, 0);
  assert.equal(existsSync(saturday.paths.site), false);
});

test("force runs anyway", async () => {
  const saturday = contextWith({}, { now: () => Date.parse("2026-11-27T22:00:00Z") });
  assert.equal(await tick(saturday, [counting], { force: true }), "ran");
  assert.equal(collects, 1);
});

test("a tick collects, renders, logs and clears the lock", async () => {
  assert.equal(await tick(ctx, [counting]), "ran");
  assert.equal(collects, 1);
  assert.ok(existsSync(ctx.paths.site));
  assert.ok(!existsSync(ctx.paths.lock));
  const line = JSON.parse(readFileSync(join(ctx.paths.logs, "ticks.jsonl"), "utf8").trim());
  assert.deepEqual(line.sources, { fake: true });
  assert.equal(line.at, NOW);
  assert.equal(typeof line.ms, "number");
});

test("a failing source is logged as failing and the tick still finishes", async () => {
  const failing = fakeSource({
    collect: async () => {
      throw new Error("host unreachable");
    },
  });
  assert.equal(await tick(ctx, [failing]), "ran");
  const line = JSON.parse(readFileSync(join(ctx.paths.logs, "ticks.jsonl"), "utf8").trim());
  assert.deepEqual(line.sources, { fake: false });
  assert.ok(readFileSync(ctx.paths.site, "utf8").includes("host unreachable"));
});

test("a tick never calls the LLM", async () => {
  const exec = fakeExec({});
  const c = contextWith({ sources: ["fake"] }, { exec });
  const runs: EnrichItem[][] = [];
  const withEnricher = sourceWith(c, {
    id: "fake-enricher",
    items: () => [{ key: "a", hash: "hash-a", input: 1 }],
    run: async (items) => {
      runs.push(items);
      return {};
    },
  });
  assert.equal(await tick(c, [withEnricher]), "ran");
  assert.equal(runs.length, 0);
  assert.ok(!exec.calls.some((call) => call[0] === "claude"));
});

test("a fresh lock blocks", async () => {
  placeLock(ctx, 60_000);
  assert.equal(await tick(ctx, [counting]), "locked");
  assert.equal(collects, 0);
  assert.ok(existsSync(ctx.paths.lock)); // it is someone else's lock; leave it
});

test("stale lock is ignored", async () => {
  placeLock(ctx, 11 * 60_000);
  assert.equal(await tick(ctx, [counting]), "ran");
  assert.ok(!existsSync(ctx.paths.lock));
});

test("the lock is cleared when rendering throws", async () => {
  const broken = fakeSource({
    collect: async () => ({}),
    panels: () => {
      throw new Error("bad panel");
    },
  });
  await assert.rejects(tick(ctx, [broken]), /bad panel/);
  assert.ok(!existsSync(ctx.paths.lock));
});

test("the tick command says what happened", async () => {
  const out = captureLog();
  try {
    assert.equal(await tickCommand(() => ctx, [counting]).run([]), 0);
    const saturday = contextWith({ sources: ["fake"] }, { now: () => Date.parse("2026-11-27T22:00:00Z") });
    assert.equal(await tickCommand(() => saturday, [counting]).run([]), 0);
    assert.equal(await tickCommand(() => saturday, [counting]).run(["--force"]), 0);
  } finally {
    out.restore();
  }
  assert.deepEqual(out.lines, ["ran", "outside-hours", "ran"]);
});
