import type { AttentionItem, Check, Context, Source } from "../../core/types.ts";
import { createGithub } from "./client.ts";
import { collectGithub } from "./collect.ts";
import { myDoneKey } from "./mine.panel.ts";
import { CREW, NEEDS_YOU, githubPanels, prDoneKey } from "./panel.ts";
import { prReview } from "./review.enricher.ts";
import type { GithubData, MyPull, PullRequest } from "./types.ts";

/** The lozenge in Needs you on a PR that I raised, which tells it from one waiting on my review. */
const MINE = "your PR";

const BUCKETS = ["review_now", "quick_win", "flagged", "blocked", "skip", "excluded"];
const CI = ["pass", "fail", "pending", "none"];
const WAITS_ON = ["me", "fix", "others", "draft"];

const record = (value: unknown) => (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
const strings = (value: unknown) => Array.isArray(value) && value.every((v) => typeof v === "string");

/** What is wrong with the list of my own PRs. It may be missing: data collected before they were has none. */
function validateMine(mine: unknown): string[] {
  if (mine === undefined) return [];
  if (!Array.isArray(mine)) return ["mine must be a list"];
  const problems: string[] = [];
  mine.forEach((raw: unknown, i) => {
    const pr = record(raw);
    const waits = record(pr.waits);
    for (const field of ["key", "headSha", "title", "url"]) {
      if (typeof pr[field] !== "string") problems.push(`mine[${i}] needs ${field}`);
    }
    for (const field of ["additions", "deletions", "updatedAt"]) {
      if (typeof pr[field] !== "number" || !Number.isFinite(pr[field])) problems.push(`mine[${i}].${field} must be a number`);
    }
    if (!CI.includes(pr.ci as string)) problems.push(`mine[${i}].ci must be one of ${CI.join(", ")}`);
    if (!WAITS_ON.includes(waits.on as string)) problems.push(`mine[${i}] needs waits.on`);
    if (!strings(waits.reasons)) problems.push(`mine[${i}] needs waits.reasons`);
  });
  return problems;
}

/** Every field the panel prints or sorts by is checked, so data in the wrong shape is refused before it is drawn. */
function validate(data: unknown): string[] {
  if (typeof data !== "object" || data === null) return ["github data must be an object"];
  const d = data as { login?: unknown; prs?: unknown; mine?: unknown };
  const problems: string[] = [];
  if (typeof d.login !== "string") problems.push("login must be a string");
  if (!Array.isArray(d.prs)) return [...problems, "prs must be a list"];
  d.prs.forEach((raw: unknown, i) => {
    const pr = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const rank = (typeof pr.rank === "object" && pr.rank !== null ? pr.rank : {}) as Record<string, unknown>;
    for (const field of ["key", "headSha", "title", "url", "author", "request"]) {
      if (typeof pr[field] !== "string") problems.push(`prs[${i}] needs ${field}`);
    }
    for (const field of ["additions", "deletions", "createdAt"]) {
      if (typeof pr[field] !== "number" || !Number.isFinite(pr[field])) problems.push(`prs[${i}].${field} must be a number`);
    }
    if (!CI.includes(pr.ci as string)) problems.push(`prs[${i}].ci must be one of ${CI.join(", ")}`);
    if (!BUCKETS.includes(rank.bucket as string)) problems.push(`prs[${i}] needs rank.bucket`);
    if (!Array.isArray(rank.reasons) || !rank.reasons.every((r) => typeof r === "string")) problems.push(`prs[${i}] needs rank.reasons`);
  });
  return [...problems, ...validateMine(d.mine)];
}

/** A PR waiting on my review, as a line in Needs you. */
function reviewItem(pr: PullRequest): AttentionItem {
  // The request ("rotation") is a lozenge here as it is in the queue, so it is not said again in words.
  const rest = pr.rank.reasons.filter((reason) => reason !== pr.request).join(", ");
  return {
    key: pr.key,
    title: pr.title,
    reason: [...pr.rank.reasons, ...(pr.byCrew ? [CREW] : [])].join(", "),
    // Who raised it comes first, with the crew lozenge beside the name it is about.
    parts: [pr.author, ...(pr.byCrew ? [{ tag: CREW, kind: "crew" as const }] : []), { tag: pr.request }, ...(rest ? [rest] : [])],
    url: pr.url,
    at: pr.createdAt,
    doneKey: prDoneKey(pr),
  };
}

/** A PR of my own that calls for me (ready to merge, or changes requested), as a line in Needs you. */
function myItem(pr: MyPull): AttentionItem {
  const why = pr.waits.reasons.join(", ");
  return {
    key: `mine:${pr.key}`,
    title: pr.title,
    reason: `${MINE}, ${why}`,
    parts: [{ tag: MINE }, why],
    url: pr.url,
    at: pr.updatedAt,
    doneKey: myDoneKey(pr),
  };
}

async function doctor(ctx: Context): Promise<Check[]> {
  const host = ctx.config.github.host;
  if (!host) {
    return [{ name: "host", ok: false, detail: "github.host is not set", fix: "set github.host in config/local.yaml" }];
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
  attention: (data) => [
    ...data.prs.filter((pr) => NEEDS_YOU.includes(pr.rank.bucket)).map(reviewItem),
    ...(data.mine ?? []).filter((pr) => pr.waits.on === "me").map(myItem),
  ],
  panels: githubPanels,
  enrichers: [prReview],
};
