import { fileURLToPath } from "node:url";
import { hashOf } from "../../enrich/cache.ts";
import { runClaude } from "../../enrich/claude.ts";
import type { Enricher } from "../../core/types.ts";
import { NEEDS_YOU, reviewKey } from "./panel.ts";
import type { GithubData } from "./types.ts";

const promptFile = fileURLToPath(new URL("../../../prompts/pr-review.md", import.meta.url));

const VERDICTS = ["approve", "request_changes", "comment"];
const SEVERITIES = ["blocker", "should-fix", "nit"];

const schema = {
  type: "object",
  required: ["summary", "verdict", "findings"],
  properties: {
    summary: { type: "string" },
    verdict: { type: "string", enum: VERDICTS },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["file", "line", "severity", "comment"],
        properties: {
          file: { type: "string" },
          line: { type: "string" },
          severity: { type: "string", enum: SEVERITIES },
          comment: { type: "string" },
        },
      },
    },
  },
};

/** True when the model's answer has exactly the shape the panel draws. */
function isReview(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { summary?: unknown; verdict?: unknown; findings?: unknown };
  if (typeof v.summary !== "string" || !VERDICTS.includes(v.verdict as string) || !Array.isArray(v.findings)) return false;
  return v.findings.every(
    (f: { file?: unknown; line?: unknown; severity?: unknown; comment?: unknown }) =>
      typeof f === "object" &&
      f !== null &&
      typeof f.file === "string" &&
      typeof f.line === "string" &&
      SEVERITIES.includes(f.severity as string) &&
      typeof f.comment === "string",
  );
}

/**
 * Drafts a review for one PR that needs you. The draft is keyed by the PR's head commit,
 * so it is written once and only offered again when new commits arrive. The run may read
 * the PR with `gh` and nothing else; it cannot post.
 */
export const prReview: Enricher<GithubData> = {
  id: "pr-review",

  items(data) {
    return data.prs
      .filter((pr) => NEEDS_YOU.includes(pr.rank.bucket))
      .map((pr) => {
        const key = reviewKey(pr);
        return { key, hash: hashOf(key), input: { repo: pr.repo, number: pr.number, title: pr.title, request: pr.request } };
      });
  },

  async run(items, ctx) {
    const out: Record<string, unknown> = {};
    for (const item of items) {
      const review = await runClaude(ctx, {
        promptFile,
        input: JSON.stringify(item.input),
        model: ctx.config.github.review.model,
        schema,
        allowedTools: ["Bash(gh pr diff:*)", "Bash(gh pr view:*)"],
        env: { GH_HOST: ctx.config.github.host },
        timeoutMs: 300_000,
      });
      if (!isReview(review)) throw new Error(`the review for ${item.key} came back in the wrong shape`);
      out[item.key] = review;
    }
    return out;
  },
};
