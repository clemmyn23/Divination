import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { contextWith, fakeExec, tempRoot } from "../../test/helpers.ts";
import { runClaude } from "./claude.ts";

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../../test/fixtures/enrich/${name}`, import.meta.url)), "utf8");

const promptFile = join(tempRoot(), "prompt.md");
writeFileSync(promptFile, "Return the number doubled.");
const req = { promptFile, input: '{"n":2}', model: "haiku", schema: { type: "object" } };

function withClaude(stdout: string, code = 0) {
  const exec = fakeExec({ "claude -p": { stdout, code } });
  return { ctx: contextWith({ enrich: { maxBudgetUsd: 0.25 } }, { exec }), exec };
}

test("runClaude builds the command and reads the structured field", async () => {
  const { ctx, exec } = withClaude(fixture("claude-output.json"));
  assert.deepEqual(await runClaude(ctx, req), { doubled: 4 });

  const args = exec.calls[0]!;
  assert.deepEqual(args.slice(0, 3), ["claude", "-p", "Return the number doubled."]);
  for (const flag of ["--output-format", "json", "--strict-mcp-config", "--no-session-persistence", "--json-schema"]) {
    assert.ok(args.includes(flag), flag);
  }
  assert.equal(args[args.indexOf("--model") + 1], "haiku");
  assert.equal(args[args.indexOf("--json-schema") + 1], '{"type":"object"}');
  assert.equal(args[args.indexOf("--max-budget-usd") + 1], "0.25");
  assert.ok(!args.includes("--allowedTools"));
});

test("allowed tools go last, so they cannot swallow another argument", async () => {
  const { ctx, exec } = withClaude(fixture("claude-output.json"));
  await runClaude(ctx, { ...req, allowedTools: ["Bash(gh pr diff:*)", "Bash(gh pr view:*)"] });
  assert.deepEqual(exec.calls[0]!.slice(-3), ["--allowedTools", "Bash(gh pr diff:*)", "Bash(gh pr view:*)"]);
});

test("without a structured field the result text is parsed, code fences and all", async () => {
  const plain = JSON.stringify({ type: "result", is_error: false, result: '```json\n{"doubled": 4}\n```' });
  assert.deepEqual(await runClaude(withClaude(plain).ctx, req), { doubled: 4 });
});

test("runClaude rejects on failure or unparseable output", async () => {
  await assert.rejects(runClaude(withClaude("", 1).ctx, req), /claude failed/);
  await assert.rejects(runClaude(withClaude("not json").ctx, req), /claude failed/);
  const prose = JSON.stringify({ type: "result", is_error: false, result: "Sure! The answer is 4." });
  await assert.rejects(runClaude(withClaude(prose).ctx, req), /claude failed/);
});

test("an expired login is reported in the CLI's own words", async () => {
  // This fixture is the real output from a machine whose CLI login had lapsed (exit code 1).
  await assert.rejects(runClaude(withClaude(fixture("claude-auth-failure.json"), 1).ctx, req), /Failed to authenticate/);
});

test("a timeout says so", async () => {
  await assert.rejects(runClaude(withClaude("", 124).ctx, req), /timed out/);
});
