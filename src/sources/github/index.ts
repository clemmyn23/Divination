import type { Check, Context, Source } from "../../core/types.ts";
import { createGithub } from "./client.ts";
import { collectGithub } from "./collect.ts";
import { NEEDS_YOU, githubPanels } from "./panel.ts";
import { prReview } from "./review.enricher.ts";
import type { GithubData } from "./types.ts";

function validate(data: unknown): string[] {
  if (typeof data !== "object" || data === null) return ["github data must be an object"];
  const d = data as { login?: unknown; prs?: unknown };
  const problems: string[] = [];
  if (typeof d.login !== "string") problems.push("login must be a string");
  if (!Array.isArray(d.prs)) return [...problems, "prs must be a list"];
  d.prs.forEach((pr: { key?: unknown; headSha?: unknown; rank?: { bucket?: unknown } }, i) => {
    if (typeof pr?.key !== "string") problems.push(`prs[${i}] needs key`);
    if (typeof pr?.headSha !== "string") problems.push(`prs[${i}] needs headSha`);
    if (typeof pr?.rank?.bucket !== "string") problems.push(`prs[${i}] needs rank.bucket`);
  });
  return problems;
}

async function doctor(ctx: Context): Promise<Check[]> {
  const host = ctx.config.github.host;
  if (!host) {
    return [{ name: "host", ok: false, detail: "github.host is not set", fix: 'set "github": { "host": "…" } in config/local.json' }];
  }
  const checks: Check[] = [{ name: "host", ok: true, detail: host }];

  const token = await ctx.exec("gh", ["auth", "token", "--hostname", host]);
  if (token.code !== 0 || !token.stdout.trim()) {
    checks.push({ name: "gh login", ok: false, detail: `gh is not logged in to ${host}`, fix: `gh auth login --hostname ${host}` });
    return checks;
  }
  checks.push({ name: "gh login", ok: true, detail: `gh has a token for ${host}` });

  try {
    const login = await createGithub(ctx).login();
    checks.push({ name: "api", ok: true, detail: `signed in as ${login}` });
  } catch (e) {
    checks.push({ name: "api", ok: false, detail: e instanceof Error ? e.message : String(e) });
  }
  return checks;
}

/** The PR review queue on the configured GitHub host. */
export const github: Source<GithubData> = {
  id: "github",
  title: "Review queue",
  doctor,
  collect: collectGithub,
  validate,
  attention: (data) =>
    data.prs
      .filter((pr) => NEEDS_YOU.includes(pr.rank.bucket))
      .map((pr) => ({ key: pr.key, title: pr.title, reason: pr.rank.reasons.join(", "), url: pr.url })),
  panels: githubPanels,
  enrichers: [prReview],
};
