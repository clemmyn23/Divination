import type { Config } from "../../core/types.ts";
import type { Bucket, PullRequest, Rank } from "./types.ts";

type Rules = Config["github"]["rank"];

const DAY = 86_400_000;
const BUCKET_ORDER: Bucket[] = ["review_now", "quick_win", "flagged", "blocked", "skip", "excluded"];

/** A config pattern as a case-insensitive expression, or undefined if it does not compile. */
function pattern(source: string): RegExp | undefined {
  try {
    return new RegExp(source, "i");
  } catch {
    return undefined;
  }
}

/**
 * Score a PR and put it in a bucket, by rules alone.
 *
 * The score says how much the PR deserves attention: risky paths, size, rotation duty,
 * age and green CI each add to it. The bucket says what to do with it, and the first
 * matching rule below wins. The reason that decided the bucket leads the list.
 */
export function rankPull(pr: Omit<PullRequest, "rank">, rules: Rules, me: string, now: number): Rank {
  const lines = pr.additions + pr.deletions;
  const risky = rules.riskPaths.filter((rule) => {
    const re = pattern(rule.pattern);
    return re !== undefined && pr.paths.some((path) => re.test(path));
  });

  let score = 0;
  const reasons: string[] = [];
  for (const rule of risky) {
    score += rule.weight;
    reasons.push(`touches ${rule.label}`);
  }
  if (lines >= rules.largeLines) {
    score += 2;
    reasons.push("large change");
  }
  if (pr.request === "rotation") {
    score += 2;
    reasons.push("rotation");
  }
  if (now - pr.createdAt > 3 * DAY) {
    score += 1;
    reasons.push(`${Math.floor((now - pr.createdAt) / DAY)} days old`);
  }
  if (pr.ci === "pass") {
    score += 1;
    reasons.push("CI passing");
  }

  const docs = pattern(rules.docsPattern);
  const docsOnly = docs !== undefined && pr.paths.length > 0 && pr.paths.every((path) => docs.test(path));

  let bucket: Bucket;
  let decidedBy: string | undefined;
  if (pr.draft) [bucket, decidedBy] = ["excluded", "draft"];
  else if (pr.author === me) [bucket, decidedBy] = ["excluded", "yours"];
  else if (pr.reviewedByMeAtHead) [bucket, decidedBy] = ["excluded", "already reviewed"];
  else if (pr.signal?.kind === "skip") [bucket, decidedBy] = ["skip", pr.signal.reason];
  else if (pr.signal?.kind === "flag") [bucket, decidedBy] = ["flagged", pr.signal.reason];
  else if (pr.ci === "fail") [bucket, decidedBy] = ["blocked", "CI failing"];
  else if (docsOnly) [bucket, decidedBy] = ["skip", "docs only"];
  else if (risky.length === 0 && lines <= rules.quickWinMaxLines) [bucket, decidedBy] = ["quick_win", "quick win"];
  else bucket = "review_now";

  return { score, bucket, reasons: decidedBy === undefined ? reasons : [decidedBy, ...reasons] };
}

/** Bucket order, then the highest score, then the oldest. The input is left alone. */
export function sortPulls(prs: PullRequest[]): PullRequest[] {
  return [...prs].sort(
    (a, b) =>
      BUCKET_ORDER.indexOf(a.rank.bucket) - BUCKET_ORDER.indexOf(b.rank.bucket) ||
      b.rank.score - a.rank.score ||
      a.createdAt - b.createdAt,
  );
}
