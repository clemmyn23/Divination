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
  for (const flag of ["--output-format", "--verbose", "--include-partial-messages", "--strict-mcp-config", "--no-session-persistence", "--json-schema"]) {
    assert.ok(args.includes(flag), flag);
  }
  assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
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

test("a Claude call is logged at start and end with its model, tools, time, cost and answer, and never its input", async () => {
  const stdout = JSON.stringify({ type: "result", is_error: false, structured_output: { doubled: 4 }, duration_ms: 4200, total_cost_usd: 0.0312, num_turns: 3 });
  const exec = fakeExec({ "claude -p": { stdout } });
  const logged: [string, Record<string, unknown>][] = [];
  const ctx = contextWith({}, { exec, log: (event, fields) => logged.push([event, { ...(fields as object) }]) });
  await runClaude(ctx, { ...req, input: "private thread text", allowedTools: ["Bash(gh pr view:*)"] });

  assert.deepEqual(logged[0], ["llm-start", { model: "haiku", prompt: "prompt.md", tools: ["Bash(gh pr view:*)"] }]);
  const [event, end] = logged[1]!;
  assert.equal(event, "llm");
  assert.deepEqual({ ...end, ms: 0 }, { ok: true, ms: 0, model: "haiku", costUsd: 0.0312, turns: 3, output: '{\n  "doubled": 4\n}' });
  assert.equal(typeof end.ms, "number");
  assert.ok(!JSON.stringify(logged).includes("private thread text"));
});

test("a failed Claude call is logged with its error, and a very long answer is cut", async () => {
  const logged: [string, Record<string, unknown>][] = [];
  const failing = contextWith({}, { exec: fakeExec({ "claude -p": { stdout: fixture("claude-auth-failure.json"), code: 1 } }), log: (event, fields) => logged.push([event, { ...(fields as object) }]) });
  await assert.rejects(runClaude(failing, req));
  const end = logged.find(([event]) => event === "llm")![1];
  assert.equal(end.ok, false);
  assert.match(String(end.error), /^claude failed: /);
  assert.equal(end.turns, 1);

  const long: [string, Record<string, unknown>][] = [];
  const stdout = JSON.stringify({ is_error: false, structured_output: { text: "x".repeat(9000) } });
  await runClaude(contextWith({}, { exec: fakeExec({ "claude -p": { stdout } }), log: (event, fields) => long.push([event, { ...(fields as object) }]) }), req);
  const output = String(long.find(([event]) => event === "llm")![1].output);
  assert.equal(output.length, 4000);
  assert.ok(output.endsWith("…"));
});

test("a Claude run is given only the built-in tools its prompt names, and none when it names none", async () => {
  const stdout = JSON.stringify({ is_error: false, structured_output: { ok: true } });
  const none = fakeExec({ "claude -p": { stdout } });
  await runClaude(contextWith({}, { exec: none }), req);
  const bare = none.calls[0]!;
  assert.equal(bare[bare.indexOf("--tools") + 1], "");

  const some = fakeExec({ "claude -p": { stdout } });
  await runClaude(contextWith({}, { exec: some }), { ...req, allowedTools: ["Bash(gh pr diff:*)", "Bash(gh pr view:*)", "Read"] });
  const args = some.calls[0]!;
  assert.equal(args[args.indexOf("--tools") + 1], "Bash,Read");
  assert.ok(args.indexOf("--tools") < args.indexOf("--allowedTools")); // --allowedTools takes everything after it
});

// Streaming: the CLI writes one JSON event per line while it works, and the result last

const events = (...list: object[]) => list.map((e) => JSON.stringify(e)).join("\n") + "\n";
const INIT = { type: "system", subtype: "init", model: "claude-haiku-4-5" };
const RESULT = { type: "result", subtype: "success", is_error: false, structured_output: { doubled: 4 }, total_cost_usd: 0.01, num_turns: 2 };
const delta = (text: string) => ({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
const said = (...content: object[]) => ({ type: "assistant", message: { role: "assistant", content } });

function watched(table: Parameters<typeof fakeExec>[0][string]) {
  const logged: [string, Record<string, unknown>][] = [];
  const ctx = contextWith({}, { exec: fakeExec({ "claude -p": table }), log: (event, fields) => logged.push([event, { ...(fields as object) }]) });
  return { ctx, logged, during: () => logged.filter(([event]) => event === "llm-text" || event === "llm-tool") };
}

test("the answer is the result line at the end of the stream", async () => {
  const stdout = events(INIT, said({ type: "text", text: "Working on it." }), RESULT);
  assert.deepEqual(await runClaude(withClaude(stdout).ctx, req), { doubled: 4 });
});

test("what Claude writes and the tools it uses are reported as they arrive", async () => {
  const stdout = events(
    INIT,
    delta("Reading "),
    delta("the diff."),
    said({ type: "text", text: "Reading the diff." }),
    said({ type: "tool_use", id: "t1", name: "Bash", input: { command: "gh pr diff 12" } }),
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "diff --git a/x b/x" }] } },
    delta("Done."),
    said({ type: "text", text: "Done." }),
    RESULT,
  );
  // Cut in awkward places: a chunk can end in the middle of a line.
  const chunks = [stdout.slice(0, 70), stdout.slice(70, 71), stdout.slice(71, 400), stdout.slice(400)];
  const { ctx, during } = watched({ chunks });
  assert.deepEqual(await runClaude(ctx, req), { doubled: 4 });
  assert.deepEqual(during(), [
    ["llm-text", { text: "Reading ", start: true }],
    ["llm-text", { text: "the diff." }],
    ["llm-tool", { name: "Bash", detail: "gh pr diff 12" }],
    ["llm-text", { text: "Done.", start: true }],
  ]);
});

test("when no partial chunks come, each whole message is reported once", async () => {
  const { ctx, during } = watched({ stdout: events(INIT, said({ type: "text", text: "Hello." }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.md" } }), RESULT) });
  await runClaude(ctx, req);
  assert.deepEqual(during(), [
    ["llm-text", { text: "Hello.", start: true }],
    ["llm-tool", { name: "Read", detail: '{"file_path":"a.md"}' }],
  ]);
});

test("a tool's input is cut short in the log, and what a tool returned is never logged", async () => {
  const stdout = events(
    said({ type: "tool_use", id: "t1", name: "Read", input: { file_path: "x".repeat(500) } }),
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "secret file body" }] } },
    RESULT,
  );
  const { ctx, logged, during } = watched({ stdout });
  await runClaude(ctx, req);
  const detail = String(during()[0]![1].detail);
  assert.equal(detail.length, 200);
  assert.ok(detail.endsWith("…"));
  assert.ok(!JSON.stringify(logged).includes("secret file body"));
});

test("a logged-out stream fails in the CLI's own words, and the error is not shown as something Claude wrote", async () => {
  // The first three lines are cut down from the real output of a CLI whose login had lapsed (exit code 1).
  const { ctx, logged, during } = watched({ stdout: fixture("claude-stream-auth-failure.jsonl"), code: 1 });
  await assert.rejects(runClaude(ctx, req), /Failed to authenticate/);
  assert.deepEqual(during(), []);
  assert.equal(logged.find(([event]) => event === "llm")![1].turns, 1);
});
