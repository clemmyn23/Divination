import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { test } from "node:test";
import { NOW, contextWith, fakeSource, ok } from "../../../../test/helpers.ts";
import { writeJson } from "../../../core/store.ts";
import type { Context, Source } from "../../../core/types.ts";
import type { GithubData, MyPull } from "../types.ts";
import { type FixProgress, fixJob } from "./job.ts";
import type { FixResult } from "./run.ts";

const DAY = 86_400_000;

function pr(number: number, over: Partial<MyPull> = {}): MyPull {
  return {
    key: `o/r#${number}`,
    repo: "o/r",
    number,
    title: `My change ${number}`,
    url: `https://git.example.com/o/r/pull/${number}`,
    headSha: `sha${number}`,
    createdAt: NOW - 3 * DAY,
    updatedAt: NOW - DAY,
    draft: false,
    additions: 10,
    deletions: 2,
    ci: "fail",
    review: "none",
    conflicts: false,
    unanswered: 0,
    waits: { on: "fix", reasons: ["CI failing"] },
    fix: { can: true, spent: false },
    ...over,
  };
}

/** A context with collected GitHub data, a GitHub source that counts its collects, and a fix that only records. */
function job(mine: MyPull[], outcomes: Record<string, FixResult["outcome"]> = {}) {
  const ctx: Context = contextWith({ sources: ["github"] });
  const data: GithubData = { login: "me", prs: [], mine };
  writeJson(ctx.paths.data("github"), ok(data));
  const events: string[] = [];
  const source: Source<GithubData> = fakeSource({
    id: "github",
    collect: async () => {
      events.push("collect");
      return data;
    },
  });
  const fix = async (_ctx: Context, key: string): Promise<FixResult> => {
    events.push(`fix ${key}`);
    return { key, outcome: outcomes[key] ?? "pushed", text: `text for ${key}` };
  };
  return { ctx, sources: [source], events, fix };
}

test("one key fixes that PR, then collects GitHub and redraws", async () => {
  const j = job([pr(8), pr(9)]);
  const totals = await fixJob(j.ctx, j.sources, "o/r#8", { fix: j.fix });
  assert.deepEqual(j.events, ["fix o/r#8", "collect"]);
  assert.deepEqual(totals, { pushed: 1, gaveUp: 0, failed: 0, refused: 0, skipped: 0 });
  assert.ok(existsSync(j.ctx.paths.site) && statSync(j.ctx.paths.site).size > 0);
});

test("all fixes each open fixable PR in the panel's order, collecting after each", async () => {
  const needsMe = pr(7, { waits: { on: "me", reasons: ["changes requested", "CI failing"] } });
  const j = job([pr(8), pr(9), needsMe, pr(10, { fix: { can: false, spent: false } }), pr(11, { updatedAt: NOW - 60 * DAY })]);
  const progress: FixProgress[] = [];
  const totals = await fixJob(j.ctx, j.sources, "all", { fix: j.fix, onProgress: (p) => progress.push(p) });
  assert.deepEqual(j.events, ["fix o/r#7", "collect", "fix o/r#8", "collect", "fix o/r#9", "collect"]);
  assert.deepEqual(progress, [
    { key: "o/r#7", index: 1, total: 3 },
    { key: "o/r#8", index: 2, total: 3 },
    { key: "o/r#9", index: 3, total: 3 },
  ]);
  assert.deepEqual(totals, { pushed: 3, gaveUp: 0, failed: 0, refused: 0, skipped: 0 });
});

test("a PR that fails does not stop the rest, and the totals say what happened", async () => {
  const j = job([pr(8), pr(9), pr(10), pr(11)], { "o/r#9": "failed", "o/r#10": "gave-up", "o/r#11": "refused" });
  const logged: [string, unknown][] = [];
  const ctx = { ...j.ctx, log: (event: string, fields?: object) => logged.push([event, fields]) };
  const totals = await fixJob(ctx, j.sources, "all", { fix: j.fix });
  assert.deepEqual(totals, { pushed: 1, gaveUp: 1, failed: 1, refused: 1, skipped: 0 });
  assert.equal(j.events.filter((e) => e.startsWith("fix")).length, 4);
  assert.deepEqual(logged.find(([event]) => event === "fix-all"), ["fix-all", totals]);
});

test("a stop request lets the PR in hand finish and skips the rest", async () => {
  const j = job([pr(8), pr(9), pr(10)]);
  let stop = false;
  const fix = async (ctx: Context, key: string) => {
    stop = true; // asked for while the first PR is in hand
    return j.fix(ctx, key);
  };
  const totals = await fixJob(j.ctx, j.sources, "all", { fix, shouldStop: () => stop });
  assert.deepEqual(j.events, ["fix o/r#8", "collect"]);
  assert.deepEqual(totals, { pushed: 1, gaveUp: 0, failed: 0, refused: 0, skipped: 2 });
});

test("with nothing to fix, or a key that is not one of my PRs, it says so and fixes nothing", async () => {
  const none = job([pr(8, { fix: { can: false, spent: false } })]);
  await assert.rejects(fixJob(none.ctx, none.sources, "all", { fix: none.fix }), { message: "nothing to fix" });
  const j = job([pr(8)]);
  await assert.rejects(fixJob(j.ctx, j.sources, "acme/monolith#999", { fix: j.fix }), { message: "acme/monolith#999 is not one of your open PRs" });
  await assert.rejects(fixJob(j.ctx, [], "o/r#8", { fix: j.fix }), /github source is not switched on/);
  assert.deepEqual([...none.events, ...j.events], []);
});

test("a single fix that was not pushed ends the job with its reason, after the page is brought up to date", async () => {
  const j = job([pr(8)], { "o/r#8": "refused" });
  await assert.rejects(fixJob(j.ctx, j.sources, "o/r#8", { fix: j.fix }), { message: "text for o/r#8" });
  assert.deepEqual(j.events, ["fix o/r#8", "collect"]);
  const gaveUp = job([pr(8)], { "o/r#8": "gave-up" });
  await assert.rejects(fixJob(gaveUp.ctx, gaveUp.sources, "o/r#8", { fix: gaveUp.fix }), { message: "text for o/r#8" });
});
