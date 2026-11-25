import { readFileSync } from "node:fs";
import type { Context } from "../core/types.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const TIMED_OUT = 124;

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
  // Last on purpose: this flag takes every argument that follows it.
  if (req.allowedTools && req.allowedTools.length > 0) args.push("--allowedTools", ...req.allowedTools);

  const res = await ctx.exec("claude", args, {
    input: req.input,
    env: req.env,
    timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  if (res.code === TIMED_OUT) throw new Error("claude failed: timed out");

  const out = parseJson(res.stdout) as CliOutput | undefined;
  if (res.code !== 0 || out === undefined || typeof out !== "object" || out === null || out.is_error === true) {
    const why =
      typeof out?.result === "string" && out.result !== ""
        ? out.result
        : res.stderr.trim().slice(0, 200) || (res.code !== 0 ? `exit code ${res.code}` : "its output was not JSON");
    throw new Error(`claude failed: ${why}`);
  }

  if (typeof out.structured_output === "object" && out.structured_output !== null) return out.structured_output;

  const fromText = typeof out.result === "string" ? jsonFromText(out.result) : undefined;
  if (fromText === undefined) throw new Error("claude failed: the answer was not JSON");
  return fromText;
}
