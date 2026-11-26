import assert from "node:assert/strict";
import { test } from "node:test";
import { NOW, captureLog, contextWith, fakeSource, ok } from "../../../test/helpers.ts";
import { writeJson } from "../../core/store.ts";
import type { Context } from "../../core/types.ts";
import type { FixResult } from "../../sources/github/fix/run.ts";
import { fixCommand } from "./fix.ts";

const pr = (number: number) => ({
  key: `o/r#${number}`, repo: "o/r", number, title: `My change ${number}`, url: `https://git.example.com/o/r/pull/${number}`, headSha: `sha${number}`,
  createdAt: NOW - 1000, updatedAt: NOW - 1000, draft: false, additions: 1, deletions: 1, ci: "fail", review: "none", conflicts: false, unanswered: 0,
  waits: { on: "fix", reasons: ["CI failing"] }, fix: { can: true, spent: false },
});

function command(outcomes: Record<string, FixResult["outcome"]> = {}) {
  const ctx = contextWith({ sources: ["github"] });
  const data = { login: "me", prs: [], mine: [pr(8), pr(9)] };
  writeJson(ctx.paths.data("github"), ok(data));
  const fixed: string[] = [];
  const fix = async (c: Context, key: string): Promise<FixResult> => {
    fixed.push(key);
    const outcome = outcomes[key] ?? "pushed";
    c.log("fix-start", { key, what: "ci" });
    c.log("fix-step", { key, step: "asking Claude" });
    c.log("fix-end", { key, outcome, text: `text for ${key}` });
    return { key, outcome, text: `text for ${key}` };
  };
  const source = fakeSource({ id: "github", collect: async () => data });
  return { fixed, cmd: fixCommand(() => ctx, [source], { fix }) };
}

async function running(cmd: ReturnType<typeof fixCommand>, args: string[]) {
  const out = captureLog();
  try {
    return { code: await cmd.run(args), lines: out.lines };
  } finally {
    out.restore();
  }
}

test("with no key it prints usage and fixes nothing", async () => {
  const c = command();
  const { code, lines } = await running(c.cmd, []);
  assert.equal(code, 1);
  assert.deepEqual(lines, ["Usage: divination fix <key | all>   (a key is owner/repo#number, for example: acme/monolith#501)"]);
  assert.deepEqual(c.fixed, []);
});

test("it prints each step as it happens, then what it did", async () => {
  const c = command();
  const { code, lines } = await running(c.cmd, ["o/r#8"]);
  assert.equal(code, 0);
  assert.deepEqual(c.fixed, ["o/r#8"]);
  assert.deepEqual(lines.filter((l) => l.includes("o/r#8")), ["Fixing o/r#8 (CI failing)", "o/r#8: asking Claude", "o/r#8: fix pushed: text for o/r#8"]);
  assert.equal(lines.at(-1), "pushed 1, gave up 0, failed 0");
});

test("all fixes every one that can be, and the totals count what was skipped or not fixed", async () => {
  const c = command({ "o/r#9": "failed" });
  const { code, lines } = await running(c.cmd, ["all"]);
  assert.equal(code, 1); // one failed
  assert.deepEqual(c.fixed, ["o/r#8", "o/r#9"]);
  assert.equal(lines.at(-1), "pushed 1, gave up 0, failed 1");

  const refused = command({ "o/r#8": "refused", "o/r#9": "gave-up" });
  const second = await running(refused.cmd, ["all"]);
  assert.equal(second.code, 1);
  assert.equal(second.lines.at(-1), "pushed 0, gave up 1, failed 0, not fixed 1");
});

test("one PR that was not fixed says why and exits with an error", async () => {
  const c = command({ "o/r#8": "gave-up" });
  const { code, lines } = await running(c.cmd, ["o/r#8"]);
  assert.equal(code, 1);
  assert.equal(lines.at(-1), "not fixed: text for o/r#8");
  const unknown = await running(c.cmd, ["o/r#999"]);
  assert.deepEqual([unknown.code, unknown.lines.at(-1)], [1, "not fixed: o/r#999 is not one of your open PRs"]);
});
