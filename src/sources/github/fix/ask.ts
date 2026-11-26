import { fileURLToPath } from "node:url";
import type { Context } from "../../../core/types.ts";
import { runClaude } from "../../../enrich/claude.ts";
import type { CheckLog } from "./logs.ts";

const promptFile = fileURLToPath(new URL("../../../../prompts/pr-fix.md", import.meta.url));

/** Read, search and edit files. No shell, no web, no connectors: a fix's Claude run cannot run anything. */
export const FIX_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write"];

export type FixAnswer = { outcome: "fixed"; summary: string } | { outcome: "cannot"; summary: string; reason: string };

const schema = {
  type: "object",
  properties: {
    outcome: { type: "string", enum: ["fixed", "cannot"] },
    summary: { type: "string" },
    reason: { type: "string" },
  },
  required: ["outcome", "summary"],
};

const words = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

function asAnswer(raw: unknown): FixAnswer {
  const answer = (typeof raw === "object" && raw !== null ? raw : {}) as { outcome?: unknown; summary?: unknown; reason?: unknown };
  if (answer.outcome === "fixed" && words(answer.summary)) return { outcome: "fixed", summary: answer.summary };
  if (answer.outcome === "cannot" && words(answer.summary) && words(answer.reason)) {
    return { outcome: "cannot", summary: answer.summary, reason: answer.reason };
  }
  throw new Error("claude answered in the wrong shape");
}

/**
 * Have Claude fix the PR in its worktree. The run is restricted to that folder, has file
 * tools only, and is quiet: neither its words nor what it reads reach the log. The logs
 * and the conflict list travel as input, which is data, and never as part of the prompt.
 */
export async function askForFix(
  ctx: Context,
  job: {
    dir: string;
    what: "ci" | "conflicts";
    title: string;
    logs: CheckLog[];
    conflicted: string[];
    onUsage?: (usage: { costUsd?: number }) => void;
  },
  run: typeof runClaude = runClaude,
): Promise<FixAnswer> {
  const fix = ctx.config.github.fix;
  const input = job.what === "ci" ? { what: job.what, title: job.title, checks: job.logs } : { what: job.what, title: job.title, conflicted: job.conflicted };
  const raw = await run(ctx, {
    promptFile,
    input: JSON.stringify(input),
    model: fix.model,
    schema,
    allowedTools: FIX_TOOLS,
    cwd: job.dir,
    restricted: true,
    quiet: true,
    maxBudgetUsd: fix.maxBudgetUsd,
    budgetSetting: "github.fix.maxBudgetUsd",
    timeoutMs: fix.timeoutMinutes * 60_000,
    ...(job.onUsage ? { onUsage: job.onUsage } : {}),
  });
  return asAnswer(raw);
}
