import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Check, Context } from "../core/types.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const TIMED_OUT = 124;
/** The most of an answer that is kept in the log. */
const LOG_MAX = 4000;

export interface ClaudeRequest {
  /** A file holding the prompt text. */
  promptFile: string;
  /** Sent on stdin. This is the data the prompt works on. */
  input: string;
  model: string;
  /** JSON Schema the answer must match. */
  schema: object;
  /** Added after the prompt file's text: what is particular to this run. */
  note?: string;
  /** Tools the run may use without asking, for example `Bash(gh pr diff:*)`. None by default. */
  allowedTools?: string[];
  /**
   * Let the run reach the account's connectors (MCP servers), for a read that goes through
   * one. Without this no MCP server is loaded at all. It may still use only `allowedTools`.
   */
  connectors?: boolean;
  env?: Record<string, string>;
  timeoutMs?: number;
}

/** The most of a tool's input that is kept in the log. */
const TOOL_DETAIL_MAX = 200;

/** The last line the CLI writes: how the run went and what it answered. */
interface CliOutput {
  type?: string;
  /** How the run ended: `success`, or a reason such as `error_max_budget_usd`. */
  subtype?: unknown;
  is_error?: boolean;
  result?: unknown;
  structured_output?: unknown;
  total_cost_usd?: number;
  num_turns?: number;
  /** Tool calls the run tried and was refused. */
  permission_denials?: { tool_name?: unknown }[];
  /** Tokens over the whole run. Most of what is read usually comes from the cache. */
  usage?: { input_tokens?: unknown; cache_creation_input_tokens?: unknown; cache_read_input_tokens?: unknown; output_tokens?: unknown };
}

/** One line of the CLI's `stream-json` output. Only the parts read here are named. */
interface CliEvent {
  type?: string;
  subtype?: string;
  /** On the first line (`system`, `init`): everything the run started with. */
  tools?: unknown;
  mcp_servers?: unknown;
  skills?: unknown;
  plugins?: unknown;
  /** Set on a message the CLI wrote itself to report an API error. */
  is_api_error_message?: boolean;
  message?: { content?: { type?: string; text?: string; name?: string; input?: unknown }[] };
  event?: { type?: string; delta?: { type?: string; text?: string } };
}

const cut = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** A tool call in a few words: the command for Bash, otherwise its input as JSON, cut short. */
function toolDetail(name: string, input: unknown): string {
  const command = (input as { command?: unknown } | null)?.command;
  return cut(name === "Bash" && typeof command === "string" ? command : (JSON.stringify(input) ?? ""), TOOL_DETAIL_MAX);
}

/**
 * Reports what a run is doing while it is still going, from the events the CLI writes
 * one per line: `llm-text` for each piece of text Claude writes (`start` marks the first
 * piece of a new passage) and `llm-tool` for each tool it uses. What a tool returned is
 * never reported: that is the gathered data itself.
 */
function watchStream(log: Context["log"]): (chunk: string) => void {
  let buffer = "";
  let midText = false; // some of the current message's text has already been reported, piece by piece

  const count = (list: unknown) => (Array.isArray(list) ? list.length : 0);
  /** The names in a list whose entries are names or objects with one. */
  const names = (list: unknown) =>
    (Array.isArray(list) ? list : [])
      .map((entry) => (typeof entry === "string" ? entry : (entry as { name?: unknown } | null)?.name))
      .filter((name): name is string => typeof name === "string");

  const onEvent = (event: CliEvent) => {
    if (event.type === "system") {
      // Counts only, and the servers by name: a plugin's entry carries paths on this machine.
      if (event.subtype === "init") {
        log("llm-loaded", { tools: count(event.tools), servers: names(event.mcp_servers), skills: count(event.skills), plugins: count(event.plugins) });
      }
      return;
    }
    if (event.type === "stream_event") {
      const delta = event.event?.delta;
      if (event.event?.type === "content_block_delta" && delta?.type === "text_delta" && delta.text) {
        log("llm-text", midText ? { text: delta.text } : { text: delta.text, start: true });
        midText = true;
      }
      return;
    }
    if (event.type !== "assistant" || event.is_api_error_message) return;
    for (const block of event.message?.content ?? []) {
      // Text that already arrived in pieces is not repeated when the whole message follows.
      if (block.type === "text" && block.text && !midText) log("llm-text", { text: block.text, start: true });
      if (block.type === "tool_use" && block.name) log("llm-tool", { name: block.name, detail: toolDetail(block.name, block.input) });
    }
    midText = false;
  };

  return (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // a chunk can end in the middle of a line
    for (const line of lines) {
      const event = parseJson(line);
      if (typeof event === "object" && event !== null) onEvent(event as CliEvent);
    }
  };
}

/** The run's result: the last `result` line of a stream, or the output as one JSON value. */
function resultOf(stdout: string): CliOutput | undefined {
  const isObject = (v: unknown): v is CliOutput => typeof v === "object" && v !== null && !Array.isArray(v);
  const whole = parseJson(stdout);
  if (isObject(whole)) return whole;
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const event = parseJson(lines[i]!);
    if (isObject(event) && event.type === "result") return event;
  }
  return undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Why a run failed, in the most useful words there are: the CLI's own, else that it ran
 * into the spending limit, else its reason code, else what it wrote as an error.
 */
function whyItFailed(out: CliOutput | undefined, res: { code: number; stderr: string }, budgetUsd: number): string {
  if (typeof out?.result === "string" && out.result !== "") return out.result;
  // A run that reaches the limit is stopped with no answer and no words of its own.
  const spent = typeof out?.total_cost_usd === "number" ? out.total_cost_usd : 0;
  if (out?.subtype === "error_max_budget_usd" || (out !== undefined && spent >= budgetUsd)) {
    return `stopped at the $${budgetUsd.toFixed(2)} spending limit for one call (enrich.maxBudgetUsd)`;
  }
  if (typeof out?.subtype === "string" && out.subtype !== "" && out.subtype !== "success") return out.subtype;
  return res.stderr.trim().slice(0, 200) || (res.code !== 0 ? `exit code ${res.code}` : "its output had no result");
}

/** JSON from a model's text answer, which may be wrapped in a code fence. */
function jsonFromText(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return parseJson((fenced ? fenced[1]! : text).trim());
}

/**
 * Ask the Claude CLI one question and return its structured answer.
 *
 * This is the only place the tool starts an LLM. It is reached from `enrichOnDemand` (a
 * sparkle button or the `enrich` command) and from a source's `feed` (Refresh now, when
 * `claudeReads.onRefresh` is on). The run keeps no session, is capped by
 * `enrich.maxBudgetUsd`, may use only the tools named in `allowedTools`, and loads no
 * MCP servers unless `connectors` is set. What it
 * writes and the tools it uses are reported through `ctx.log` while it runs.
 */
export async function runClaude(ctx: Context, req: ClaudeRequest): Promise<unknown> {
  const args = [
    "-p",
    readFileSync(req.promptFile, "utf8") + (req.note ? `\n\n${req.note}` : ""),
    // One JSON event per line while it works, text in pieces as it is written, the result last.
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    req.model,
    "--json-schema",
    JSON.stringify(req.schema),
    ...(req.connectors ? [] : ["--strict-mcp-config"]),
    "--no-session-persistence",
    "--max-budget-usd",
    String(ctx.config.enrich.maxBudgetUsd),
  ];
  // Only the built-in tools the prompt names exist for the run ("" means none at all), so
  // text in a PR or a thread cannot talk it into reading local files.
  const builtIn = [...new Set((req.allowedTools ?? []).map((tool) => tool.split("(")[0]!).filter((name) => !name.startsWith("mcp__")))];
  args.push("--tools", builtIn.join(","));
  // Last on purpose: this flag takes every argument that follows it.
  if (req.allowedTools && req.allowedTools.length > 0) args.push("--allowedTools", ...req.allowedTools);

  // Logged for the page's activity view: what was asked of which model, how long it took,
  // what it cost and what came back. The input is never logged.
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  ctx.log("llm-start", { model: req.model, prompt: basename(req.promptFile), tools: req.allowedTools ?? [] });

  let out: CliOutput | undefined;
  const usage = () => ({
    ...(typeof out?.total_cost_usd === "number" ? { costUsd: out.total_cost_usd } : {}),
    ...(typeof out?.num_turns === "number" ? { turns: out.num_turns } : {}),
    ...(tokens() ? { tokens: tokens() } : {}),
    ...(denied().length > 0 ? { denied: denied() } : {}),
  });
  /** What the run read and wrote, in tokens, when the CLI says. */
  const tokens = () => {
    const u = out?.usage;
    if (typeof u !== "object" || u === null) return undefined;
    const n = (v: unknown) => (typeof v === "number" ? v : 0);
    return { in: n(u.input_tokens), cacheWrite: n(u.cache_creation_input_tokens), cacheRead: n(u.cache_read_input_tokens), out: n(u.output_tokens) };
  };
  /** Each tool the run was refused, once. A name here that the prompt needs means `allowedTools` is wrong. */
  const denied = () => [
    ...new Set((Array.isArray(out?.permission_denials) ? out.permission_denials : []).map((d) => d?.tool_name).filter((name): name is string => typeof name === "string")),
  ];

  try {
    const res = await ctx.exec("claude", args, {
      input: req.input,
      env: req.env,
      timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      onStdout: watchStream(ctx.log),
    });

    if (res.code === TIMED_OUT) throw new Error("claude failed: timed out");

    out = resultOf(res.stdout);
    if (res.code !== 0 || out === undefined || out.is_error === true) {
      throw new Error(`claude failed: ${whyItFailed(out, res, ctx.config.enrich.maxBudgetUsd)}`);
    }

    let answer: unknown;
    if (typeof out.structured_output === "object" && out.structured_output !== null) answer = out.structured_output;
    else {
      answer = typeof out.result === "string" ? jsonFromText(out.result) : undefined;
      if (answer === undefined) throw new Error("claude failed: the answer was not JSON");
    }

    const text = JSON.stringify(answer, null, 2);
    ctx.log("llm", { ok: true, ms: elapsed(), model: req.model, ...usage(), output: cut(text, LOG_MAX) });
    return answer;
  } catch (e) {
    ctx.log("llm", { ok: false, ms: elapsed(), model: req.model, ...usage(), error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

/**
 * For `doctor`: is the Claude CLI there and signed in? This asks the CLI about itself and
 * calls no model.
 */
export async function claudeCheck(ctx: Context): Promise<Check> {
  const res = await ctx.exec("claude", ["auth", "status"], { timeoutMs: 15_000 });
  const status = parseJson(res.stdout) as { loggedIn?: unknown } | undefined;
  if (typeof status?.loggedIn !== "boolean") return { name: "claude", ok: false, detail: "the claude CLI could not be run", fix: "install Claude Code, then run claude in a terminal" };
  if (status.loggedIn) return { name: "claude", ok: true, detail: "the claude CLI is signed in" };
  return {
    name: "claude",
    ok: false,
    detail: "the claude CLI is not signed in, so Refresh now cannot ask it to read this",
    fix: "run claude in a terminal, then /login",
  };
}
