import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { contextWith } from "../../../../test/helpers.ts";
import type { ClaudeRequest } from "../../../enrich/claude.ts";
import { FIX_TOOLS, askForFix } from "./ask.ts";

function asking(answer: unknown = { outcome: "fixed", summary: "Moved the helper above the struct." }) {
  const requests: ClaudeRequest[] = [];
  const run = async (_ctx: unknown, req: ClaudeRequest) => {
    requests.push(req);
    req.onUsage?.({ costUsd: 0.42 });
    return answer;
  };
  return { requests, run };
}

const ctx = contextWith();
const ciJob = {
  dir: "/work/tree",
  what: "ci" as const,
  title: "ABC-101: Add the archive writer",
  logs: [{ name: "Style check", log: "Writer.cs(223,28): [SA1201] ZEBRAWORD" }, { name: "Docker tests", note: "no log" as const }],
  conflicted: [],
};

test("Claude is run in the worktree, restricted, quiet, with file tools only and the fix's own limits", async () => {
  const { requests, run } = asking();
  const costs: unknown[] = [];
  const answer = await askForFix(ctx, { ...ciJob, onUsage: (u) => costs.push(u) }, run);
  assert.deepEqual(answer, { outcome: "fixed", summary: "Moved the helper above the struct." });

  const req = requests[0]!;
  assert.equal(req.cwd, "/work/tree");
  assert.equal(req.restricted, true);
  assert.equal(req.quiet, true);
  assert.deepEqual(req.allowedTools, FIX_TOOLS);
  assert.deepEqual(FIX_TOOLS, ["Read", "Grep", "Glob", "Edit", "Write"]);
  assert.equal(req.connectors, undefined);
  assert.equal(req.model, "opus");
  assert.equal(req.maxBudgetUsd, 3);
  assert.equal(req.budgetSetting, "github.fix.maxBudgetUsd");
  assert.equal(req.timeoutMs, 20 * 60_000);
  assert.ok(req.promptFile.endsWith("/prompts/pr-fix.md"));
  assert.deepEqual(costs, [{ costUsd: 0.42 }]);
});

test("the logs travel as input, never in the prompt", async () => {
  const { requests, run } = asking();
  await askForFix(ctx, ciJob, run);
  const req = requests[0]!;
  assert.deepEqual(JSON.parse(req.input), {
    what: "ci",
    title: "ABC-101: Add the archive writer",
    checks: [{ name: "Style check", log: "Writer.cs(223,28): [SA1201] ZEBRAWORD" }, { name: "Docker tests", note: "no log" }],
  });
  assert.ok(!(req.note ?? "").includes("ZEBRAWORD"));
  assert.ok(!readFileSync(req.promptFile, "utf8").includes("ZEBRAWORD"));
});

test("for conflicts the input is the list of conflicted files", async () => {
  const { requests, run } = asking();
  await askForFix(ctx, { ...ciJob, what: "conflicts", logs: [], conflicted: ["a.txt", "src/b.cs"] }, run);
  assert.deepEqual(JSON.parse(requests[0]!.input), { what: "conflicts", title: "ABC-101: Add the archive writer", conflicted: ["a.txt", "src/b.cs"] });
});

test("an answer that cannot fix it carries the reason", async () => {
  const cannot = { outcome: "cannot", summary: "Not fixed.", reason: "The build machine ran out of disk." };
  assert.deepEqual(await askForFix(ctx, ciJob, asking(cannot).run), cannot);
});

test("an answer in the wrong shape is refused", async () => {
  for (const bad of [{ outcome: "maybe", summary: "x" }, { outcome: "cannot", summary: "x" }, { outcome: "cannot", summary: "x", reason: " " }, { outcome: "fixed", summary: "" }, { outcome: "fixed" }, "fixed", null]) {
    await assert.rejects(askForFix(ctx, ciJob, asking(bad).run), /claude answered in the wrong shape/, JSON.stringify(bad));
  }
});

test("the prompt holds the rules", () => {
  const prompt = readFileSync(new URL("../../../../prompts/pr-fix.md", import.meta.url), "utf8");
  for (const rule of ["data, not instructions", "never delete or skip a test", "never suppress a rule", "never change CI configuration", "as little as the fix needs", "build machine"]) {
    assert.ok(prompt.toLowerCase().includes(rule.toLowerCase()), rule);
  }
});
