import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Context } from "../core/types.ts";
import { contextWith, fakeExec, tempRoot } from "../../test/helpers.ts";
import { claudeCheck, runClaude } from "./claude.ts";

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

test("a run stopped at its spending limit says so and names the setting", async () => {
  // The shape seen from real runs: exit code 1, a result line with no text, the cost just past the limit.
  const stopped = JSON.stringify({ type: "result", subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 0.5072767, num_turns: 15 });
  const exec = fakeExec({ "claude -p": { stdout: stopped, code: 1 } });
  const ctx = contextWith({ enrich: { maxBudgetUsd: 0.5 } }, { exec });
  await assert.rejects(runClaude(ctx, req), { message: "claude failed: stopped at the $0.50 spending limit for one call (enrich.maxBudgetUsd)" });

  // Without the CLI naming the reason, a cost at or past the limit and no answer says the same.
  const unnamed = JSON.stringify({ type: "result", is_error: true, total_cost_usd: 0.5, num_turns: 9 });
  const ctx2 = contextWith({ enrich: { maxBudgetUsd: 0.5 } }, { exec: fakeExec({ "claude -p": { stdout: unnamed, code: 1 } }) });
  await assert.rejects(runClaude(ctx2, req), /stopped at the \$0\.50 spending limit/);
});

test("a failure the CLI gives a reason code for, and no words, is reported by that code", async () => {
  const stopped = JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, total_cost_usd: 0.01, num_turns: 40 });
  await assert.rejects(runClaude(withClaude(stopped, 1).ctx, req), { message: "claude failed: error_max_turns" });
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

// Connector runs: the reads Refresh now can start

test("a run that may use connectors is not started with --strict-mcp-config, which shuts connectors out too, and still gets no built-in tools", async () => {
  const exec = fakeExec({ "claude -p": { stdout: events(RESULT) } });
  const tools = ["mcp__claude_ai_Slack__slack_read_channel", "mcp__claude_ai_Slack__slack_read_thread"];
  await runClaude(contextWith({}, { exec }), { ...req, connectors: true, allowedTools: tools });
  const args = exec.calls.find((call) => call[1] === "-p")!;
  assert.ok(!args.includes("--strict-mcp-config"));
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.deepEqual(args.slice(-3), ["--allowedTools", ...tools]);

  const plain = fakeExec({ "claude -p": { stdout: events(RESULT) } });
  await runClaude(contextWith({}, { exec: plain }), req);
  assert.ok(plain.calls[0]!.includes("--strict-mcp-config"));
});

// A connector run would otherwise start with every MCP server the account and machine have,
// hundreds of tool descriptions that each turn pays for again.

const MCP_LIST = [
  "Checking MCP server health…",
  "",
  "claude.ai Ada - Agency Custom Connector: https://example.test/api/mcp/oauth - ! Needs authentication",
  "claude.ai Slack: https://mcp.slack.com/mcp - ✔ Connected",
  "claude.ai Google Calendar: https://calendarmcp.googleapis.com/mcp/v1 - ✔ Connected",
  "code-knowledge-graph: npx -y some-server --flag - ✔ Connected",
  "playwright: npx @playwright/mcp@latest - ✗ Failed to connect",
  "",
].join("\n");
const SLACK_TOOLS = ["mcp__claude_ai_Slack__slack_read_channel", "mcp__claude_ai_Slack__slack_read_thread"];
type Settings = { disableAllHooks?: boolean; deniedMcpServers?: { serverName: string }[] };
const settingsOf = (args: string[]) => JSON.parse(args[args.indexOf("--settings") + 1]!) as Settings;
const shutOut = (args: string[]) => (settingsOf(args).deniedMcpServers ?? []).map((s) => s.serverName);
const listing = (...names: string[]) => ["Checking MCP server health…", "", ...names.map((name) => `${name}: https://example.test/mcp - ✔ Connected`), ""].join("\n");

/**
 * A stand-in for the CLI: `mcp list` answers with whatever `servers` says is left once the
 * given names are shut out, and a run answers RESULT. Every call and its options are kept.
 */
function cli(servers: (shutOut: string[]) => string | undefined) {
  const calls: { args: string[]; env?: Record<string, string> }[] = [];
  const exec: Context["exec"] = async (_cmd, args, opts) => {
    calls.push({ args, env: opts?.env });
    if (args.includes("-p")) return { code: 0, stdout: events(RESULT), stderr: "" };
    const stdout = servers(args.includes("--settings") ? shutOut(args) : []);
    return stdout === undefined ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout, stderr: "" };
  };
  return { exec, calls, runs: () => calls.filter((c) => c.args.includes("-p")), lists: () => calls.filter((c) => !c.args.includes("-p")) };
}

test("a connector run shuts out every MCP server but the one its tools belong to", async () => {
  const c = cli((gone) => (gone.length === 0 ? MCP_LIST : listing("claude.ai Slack")));
  await runClaude(contextWith({}, { exec: c.exec }), { ...req, connectors: true, allowedTools: SLACK_TOOLS });

  assert.deepEqual(c.calls[0]!.args, ["mcp", "list"]);
  const args = c.runs()[0]!.args;
  assert.deepEqual(shutOut(args), ["claude.ai Ada - Agency Custom Connector", "claude.ai Google Calendar", "code-knowledge-graph", "playwright"]);
  assert.ok(!args.includes("--strict-mcp-config"));
  assert.ok(args.indexOf("--settings") < args.indexOf("--allowedTools")); // --allowedTools takes everything after it
});

test("servers that only appear once others are shut out are found by listing again, until none is left", async () => {
  // Shutting out one server can uncover another of the same service that it had been standing in for.
  const c = cli((gone) => {
    if (gone.length === 0) return listing("claude.ai Slack", "figma", "playwright");
    if (!gone.includes("plugin:figma:figma")) return listing("claude.ai Slack", "plugin:figma:figma");
    if (!gone.includes("claude.ai Figma")) return listing("claude.ai Slack", "claude.ai Figma");
    return listing("claude.ai Slack");
  });
  await runClaude(contextWith({}, { exec: c.exec }), { ...req, connectors: true, allowedTools: SLACK_TOOLS });
  assert.deepEqual(shutOut(c.runs()[0]!.args), ["figma", "playwright", "plugin:figma:figma", "claude.ai Figma"]);
  assert.equal(c.lists().length, 4);
});

test("the servers are listed once and remembered for the next connector run", async () => {
  const c = cli((gone) => (gone.length === 0 ? MCP_LIST : listing("claude.ai Slack")));
  const ctx = contextWith({}, { exec: c.exec });
  await runClaude(ctx, { ...req, connectors: true, allowedTools: SLACK_TOOLS });
  const listed = c.lists().length;
  await runClaude(ctx, { ...req, connectors: true, allowedTools: SLACK_TOOLS });
  assert.equal(c.lists().length, listed);
  assert.deepEqual(shutOut(c.runs()[1]!.args), shutOut(c.runs()[0]!.args));

  // A run that needs a different server works its own list out.
  await runClaude(ctx, { ...req, connectors: true, allowedTools: ["mcp__claude_ai_Google_Calendar__list_events"] });
  assert.ok(c.lists().length > listed);
  assert.ok(shutOut(c.runs()[2]!.args).includes("claude.ai Slack"));
});

test("a connector run waits for its connector before the first turn, so its tools are there", async () => {
  const c = cli(() => listing("claude.ai Slack"));
  await runClaude(contextWith({}, { exec: c.exec }), { ...req, connectors: true, allowedTools: SLACK_TOOLS, env: { EXTRA: "1" } });
  assert.deepEqual(c.runs()[0]!.env, { EXTRA: "1", MCP_CONNECTION_NONBLOCKING: "0", MCP_CONNECT_TIMEOUT_MS: "30000" });

  const plain = cli(() => undefined);
  await runClaude(contextWith({}, { exec: plain.exec }), req);
  assert.equal(plain.runs()[0]!.env, undefined);
});

test("a run with no connectors does not list the MCP servers: it loads none anyway", async () => {
  const c = cli(() => MCP_LIST);
  await runClaude(contextWith({}, { exec: c.exec }), req);
  assert.equal(c.lists().length, 0);
  assert.equal(settingsOf(c.runs()[0]!.args).deniedMcpServers, undefined);
  assert.ok(c.runs()[0]!.args.includes("--strict-mcp-config"));
});

test("when the servers cannot be listed, or none matches the run's tools, none is shut out", async () => {
  const unlisted = cli(() => undefined);
  assert.deepEqual(await runClaude(contextWith({}, { exec: unlisted.exec }), { ...req, connectors: true, allowedTools: SLACK_TOOLS }), { doubled: 4 });
  assert.equal(settingsOf(unlisted.runs()[0]!.args).deniedMcpServers, undefined);

  // Shutting out everything would leave the run with no way to do its job.
  const renamed = cli(() => MCP_LIST);
  await runClaude(contextWith({}, { exec: renamed.exec }), { ...req, connectors: true, allowedTools: ["mcp__some_other_name__read"] });
  assert.equal(settingsOf(renamed.runs()[0]!.args).deniedMcpServers, undefined);
});

test("a listing that fails part-way keeps what was already found", async () => {
  const c = cli((gone) => (gone.length === 0 ? MCP_LIST : undefined));
  await runClaude(contextWith({}, { exec: c.exec }), { ...req, connectors: true, allowedTools: SLACK_TOOLS });
  assert.equal(shutOut(c.runs()[0]!.args).length, 4);
});

test("no run loads the machine's skills or runs its hooks: a prompt here needs neither", async () => {
  const exec = fakeExec({ "claude -p": { stdout: events(RESULT) } });
  await runClaude(contextWith({}, { exec }), req);
  const args = exec.calls[0]!;
  assert.ok(args.includes("--disable-slash-commands"));
  assert.equal((settingsOf(args) as { disableAllHooks?: boolean }).disableAllHooks, true);
});

test("a note for this run is added after the prompt file's text", async () => {
  const exec = fakeExec({ "claude -p": { stdout: events(RESULT) } });
  await runClaude(contextWith({}, { exec }), { ...req, note: "## This run\n\nAnswer with JSON." });
  assert.equal(exec.calls[0]![2], "Return the number doubled.\n\n## This run\n\nAnswer with JSON.");
});

test("tools the run was refused are named in the log, so a wrong tool name in config can be found", async () => {
  const stdout = events({ ...RESULT, permission_denials: [{ tool_name: "mcp__claude_ai_Slack__slack_send_message" }, { tool_name: "Bash" }, { tool_name: "Bash" }] });
  const { ctx, logged } = watched({ stdout });
  await runClaude(ctx, req);
  assert.deepEqual(logged.find(([event]) => event === "llm")![1].denied, ["mcp__claude_ai_Slack__slack_send_message", "Bash"]);
});

test("the tokens a run used are logged, on a failure too", async () => {
  const usage = { input_tokens: 1200, cache_creation_input_tokens: 30_000, cache_read_input_tokens: 400_000, output_tokens: 950 };
  const ok = watched({ stdout: events(INIT, { ...RESULT, usage }) });
  await runClaude(ok.ctx, req);
  assert.deepEqual(ok.logged.find(([event]) => event === "llm")![1].tokens, { in: 1200, cacheWrite: 30_000, cacheRead: 400_000, out: 950 });

  const stopped = watched({ stdout: events(INIT, { type: "result", subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 9, usage }), code: 1 });
  await assert.rejects(runClaude(stopped.ctx, req));
  assert.deepEqual(stopped.logged.find(([event]) => event === "llm")![1].tokens, { in: 1200, cacheWrite: 30_000, cacheRead: 400_000, out: 950 });

  const none = watched({ stdout: events(INIT, RESULT) });
  await runClaude(none.ctx, req);
  assert.ok(!("tokens" in none.logged.find(([event]) => event === "llm")![1]));
});

test("what a run loaded before it began is logged as counts, with the MCP servers by name", async () => {
  const init = {
    ...INIT,
    tools: ["mcp__claude_ai_Slack__slack_read_channel", "mcp__claude_ai_Slack__slack_read_thread", "mcp__playwright__browser_click"],
    mcp_servers: [{ name: "claude.ai Slack", status: "connected" }, { name: "playwright", status: "connected" }],
    skills: ["review-queue", "start-coding"],
    plugins: [{ name: "figma", path: "/somewhere/private" }],
  };
  const { ctx, logged } = watched({ stdout: events(init, RESULT) });
  await runClaude(ctx, req);
  assert.deepEqual(logged.find(([event]) => event === "llm-loaded")![1], { tools: 3, servers: ["claude.ai Slack", "playwright"], skills: 2, plugins: 1 });

  // The start-up line of a run that names nothing still counts as nothing loaded.
  const bare = watched({ stdout: events(INIT, RESULT) });
  await runClaude(bare.ctx, req);
  assert.deepEqual(bare.logged.find(([event]) => event === "llm-loaded")![1], { tools: 0, servers: [], skills: 0, plugins: 0 });
});

// Doctor: can Refresh now's Claude reads run at all

test("the doctor's Claude check says whether the CLI is signed in, and how to fix it", async () => {
  const check = (entry: Parameters<typeof fakeExec>[0][string]) => claudeCheck(contextWith({}, { exec: fakeExec({ "claude auth status": entry }) }));

  assert.deepEqual(await check({ stdout: '{"loggedIn": true, "authMethod": "claude.ai"}' }), { name: "claude", ok: true, detail: "the claude CLI is signed in" });
  assert.deepEqual(await check({ stdout: '{"loggedIn": false, "authMethod": "none"}', code: 1 }), {
    name: "claude",
    ok: false,
    detail: "the claude CLI is not signed in, so Refresh now cannot ask it to read this",
    fix: "run claude in a terminal, then /login",
  });
  const missing = await check({ code: 127 });
  assert.deepEqual([missing.ok, missing.detail], [false, "the claude CLI could not be run"]);
});

test("a run can be given a folder, its own budget and restricted mode", async () => {
  const { ctx, exec } = withClaude(fixture("claude-output.json"));
  await runClaude(ctx, { ...req, cwd: "/work/tree", maxBudgetUsd: 3, budgetSetting: "github.fix.maxBudgetUsd", restricted: true, allowedTools: ["Read", "Edit"] });
  const args = exec.calls[0]!;
  assert.equal(exec.opts[0]!.cwd, "/work/tree");
  assert.ok(args.includes("--restricted"));
  assert.equal(args[args.indexOf("--max-budget-usd") + 1], "3");
  assert.deepEqual(args.slice(-3), ["--allowedTools", "Read", "Edit"]); // still last
});

test("without those the run is as before: no folder, the usual budget, not restricted", async () => {
  const { ctx, exec } = withClaude(fixture("claude-output.json"));
  await runClaude(ctx, req);
  assert.ok(!exec.calls[0]!.includes("--restricted"));
  assert.equal(exec.calls[0]![exec.calls[0]!.indexOf("--max-budget-usd") + 1], "0.25");
  assert.equal(exec.opts[0]!.cwd, undefined);
});

test("a run stopped at its own budget names that budget's setting", async () => {
  const stopped = JSON.stringify({ type: "result", subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 3.01, num_turns: 30 });
  const ctx = contextWith({}, { exec: fakeExec({ "claude -p": { stdout: stopped, code: 1 } }) });
  await assert.rejects(runClaude(ctx, { ...req, maxBudgetUsd: 3, budgetSetting: "github.fix.maxBudgetUsd" }), {
    message: "claude failed: stopped at the $3.00 spending limit for one call (github.fix.maxBudgetUsd)",
  });
});

test("a quiet run reports a tool by its file path only, and none of what Claude writes", async () => {
  const stdout = events(
    INIT,
    delta("The log says line 223 "),
    said({ type: "text", text: "The log says line 223 is wrong." }),
    said({ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "src/Writer.cs", old_string: "private secret body", new_string: "other secret body" } }),
    said({ type: "tool_use", id: "t2", name: "Grep", input: { pattern: "secret pattern", path: "src" } }),
    said({ type: "tool_use", id: "t3", name: "Glob", input: { pattern: "**/*.cs" } }),
    RESULT,
  );
  const { ctx, logged, during } = watched({ stdout });
  await runClaude(ctx, { ...req, quiet: true });
  assert.deepEqual(during(), [
    ["llm-tool", { name: "Edit", detail: "src/Writer.cs" }],
    ["llm-tool", { name: "Grep", detail: "src" }],
    ["llm-tool", { name: "Glob", detail: "" }],
  ]);
  const all = JSON.stringify(logged);
  assert.ok(!all.includes("secret") && !all.includes("line 223"));
});

test("the cost is reported when the run ends, whether it worked or not", async () => {
  const seen: { costUsd?: number }[] = [];
  const good = events({ ...RESULT, total_cost_usd: 0.42 });
  await runClaude(withClaude(good).ctx, { ...req, onUsage: (u) => seen.push(u) });
  const bad = JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, total_cost_usd: 0.07 });
  await assert.rejects(runClaude(withClaude(bad, 1).ctx, { ...req, onUsage: (u) => seen.push(u) }));
  assert.deepEqual(seen, [{ costUsd: 0.42 }, { costUsd: 0.07 }]);
});
