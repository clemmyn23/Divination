import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Context } from "../core/types.ts";

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
  /** Tools the run may use without asking, for example `Bash(gh pr diff:*)`. None by default. */
  allowedTools?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
}

interface CliOutput {
  is_error?: boolean;
  result?: unknown;
  structured_output?: unknown;
  total_cost_usd?: number;
  num_turns?: number;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** JSON from a model's text answer, which may be wrapped in a code fence. */
function jsonFromText(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return parseJson((fenced ? fenced[1]! : text).trim());
}

/**
 * Ask the Claude CLI one question and return its structured answer.
 *
 * This is the only place the tool starts an LLM, and it is only reached from
 * `enrichOnDemand`. The run loads no MCP servers, keeps no session, is capped by
 * `enrich.maxBudgetUsd`, and may use only the tools named in `allowedTools`.
 */
export async function runClaude(ctx: Context, req: ClaudeRequest): Promise<unknown> {
  const args = [
    "-p",
    readFileSync(req.promptFile, "utf8"),
    "--output-format",
    "json",
    "--model",
    req.model,
    "--json-schema",
    JSON.stringify(req.schema),
    "--strict-mcp-config",
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
  });

  try {
    const res = await ctx.exec("claude", args, {
      input: req.input,
      env: req.env,
      timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

    if (res.code === TIMED_OUT) throw new Error("claude failed: timed out");

    const parsed = parseJson(res.stdout);
    out = typeof parsed === "object" && parsed !== null ? (parsed as CliOutput) : undefined;
    if (res.code !== 0 || out === undefined || out.is_error === true) {
      const why =
        typeof out?.result === "string" && out.result !== ""
          ? out.result
          : res.stderr.trim().slice(0, 200) || (res.code !== 0 ? `exit code ${res.code}` : "its output was not JSON");
      throw new Error(`claude failed: ${why}`);
    }

    let answer: unknown;
    if (typeof out.structured_output === "object" && out.structured_output !== null) answer = out.structured_output;
    else {
      answer = typeof out.result === "string" ? jsonFromText(out.result) : undefined;
      if (answer === undefined) throw new Error("claude failed: the answer was not JSON");
    }

    const text = JSON.stringify(answer, null, 2);
    ctx.log("llm", { ok: true, ms: elapsed(), model: req.model, ...usage(), output: text.length <= LOG_MAX ? text : `${text.slice(0, LOG_MAX - 1)}…` });
    return answer;
  } catch (e) {
    ctx.log("llm", { ok: false, ms: elapsed(), model: req.model, ...usage(), error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}
