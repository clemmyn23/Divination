import type { Panel, View } from "../../core/types.ts";
import { doneAccordion, isDone, tick } from "../../render/done.ts";
import { esc, link } from "../../render/html.ts";
import { isOld, staleAccordion } from "../../render/old.ts";
import { ciMark, sizeText } from "./marks.ts";
import { myPrsPanel } from "./mine.panel.ts";
import type { Bucket, GithubData, PullRequest } from "./types.ts";

/** The lozenge on a PR raised by a member of the review crew: such a PR may bypass the crew's review. */
export const CREW = "raised by crew member";

/** The buckets that count as waiting on me. */
export const NEEDS_YOU: Bucket[] = ["review_now", "quick_win", "flagged"];

const GROUPS: { title: string; buckets: Bucket[] }[] = [
  { title: "Needs you", buckets: NEEDS_YOU },
  { title: "Waiting on authors", buckets: ["blocked"] },
  { title: "Covered or low priority", buckets: ["skip", "excluded"] },
];

// Already shown on the meta line by the CI mark and the request tag.
const SHOWN_ELSEWHERE = ["rotation", "CI passing", "CI failing"];

interface Finding {
  file: string;
  line: string;
  severity: string;
  comment: string;
}

interface Review {
  verdict: string;
  summary: string;
  findings: Finding[];
}

function asReview(value: unknown): Review | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Partial<Review>;
  if (typeof v.verdict !== "string" || typeof v.summary !== "string" || !Array.isArray(v.findings)) return undefined;
  return v as Review;
}

/** The key that marks a PR done. It includes the head commit, so new commits bring the PR back. */
export const prDoneKey = (pr: PullRequest) => `pr:${pr.key}@${pr.headSha}`;

export function reviewKey(pr: PullRequest): string {
  return `${pr.key}@${pr.headSha}`;
}

function reviewHtml(review: Review): string {
  const count = review.findings.length;
  const findings = review.findings
    .map(
      (f) => `<div class="finding">
<p class="where">${esc(f.file)}:${esc(f.line)} · ${esc(f.severity)}</p>
<pre>${esc(f.comment)}</pre>
<button data-copy="${esc(f.comment)}">Copy comment</button>
</div>`,
    )
    .join("\n");
  return `<details class="review">
<summary>Draft: ${esc(review.verdict.replaceAll("_", " "))} · ${count} ${count === 1 ? "note" : "notes"}</summary>
<p>${esc(review.summary)}</p>
${findings}
</details>`;
}

function meta(pr: PullRequest): string {
  const why = pr.rank.reasons.filter((r) => !SHOWN_ELSEWHERE.includes(r)).join(", ");
  const parts = [
    esc(pr.key),
    esc(pr.author),
    sizeText(pr.additions, pr.deletions),
    ciMark(pr.ci),
    `<span class="tag">${esc(pr.request)}</span>`,
    ...(pr.byCrew ? [`<span class="tag crew">${CREW}</span>`] : []),
    ...(why ? [esc(why)] : []),
  ];
  return `<p class="meta">${parts.join(" · ")}</p>`;
}

function item(pr: PullRequest, view: View): string {
  const needsYou = NEEDS_YOU.includes(pr.rank.bucket);
  let extra = "";
  if (needsYou) {
    const review = asReview(view.enrich["pr-review"]?.[reviewKey(pr)]);
    extra = review
      ? `\n${reviewHtml(review)}`
      : `\n<button data-enrich="pr-review" data-key="${esc(reviewKey(pr))}">Draft review</button>`;
  }
  const key = prDoneKey(pr);
  return `<li class="item pr${needsYou ? " needs-you" : ""}">${link(pr.title, pr.url)}
${meta(pr)}${extra}${tick(key, isDone(key, view))}</li>`;
}

/**
 * The review queue: PRs grouped by what to do with them, one title and one meta line each.
 * PRs opened longer ago than `hideOlderThanDays` are folded into one accordion at the end,
 * and PRs ticked off by hand into another. My own PRs follow in a panel of their own;
 * both are short, so the two share a column with the queue on top.
 */
export function githubPanels(data: GithubData, view: View): Panel[] {
  const done = data.prs.filter((pr) => isDone(prDoneKey(pr), view));
  const open = data.prs.filter((pr) => !isDone(prDoneKey(pr), view));
  const stale = open.filter((pr) => isOld(pr.createdAt, view));
  const fresh = open.filter((pr) => !isOld(pr.createdAt, view));

  const groups = GROUPS.map(({ title, buckets }) => {
    const prs = fresh.filter((pr) => buckets.includes(pr.rank.bucket));
    if (prs.length === 0) return "";
    return `<h3 class="group">${title} · ${prs.length}</h3>
<ul class="items">
${prs.map((pr) => item(pr, view)).join("\n")}
</ul>`;
  }).filter((html) => html !== "");

  if (stale.length > 0) {
    groups.push(staleAccordion(stale.length, `<ul class="items">\n${stale.map((pr) => item(pr, view)).join("\n")}\n</ul>`));
  }

  if (done.length > 0) {
    groups.push(doneAccordion(done.length, `<ul class="items">\n${done.map((pr) => item(pr, view)).join("\n")}\n</ul>`));
  }

  const html = groups.length > 0 ? groups.join("\n") : '<p class="quiet">No reviews waiting.</p>';
  return [{ id: "prs", title: "Review queue", tint: "blush", size: "short", html }, myPrsPanel(data, view)];
}
