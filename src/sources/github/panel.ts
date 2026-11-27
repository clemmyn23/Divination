import { when } from "../../core/time.ts";
import type { Panel, View } from "../../core/types.ts";
import { hashOf } from "../../enrich/cache.ts";
import { doneAccordion, isDone, tick } from "../../render/done.ts";
import { fold } from "../../render/fold.ts";
import { esc, link, who } from "../../render/html.ts";
import { isOld, staleAccordion } from "../../render/old.ts";
import { ciMark, sizeMark } from "./marks.ts";
import { myPrsPanel } from "./mine.panel.ts";
import { postedKey } from "./review/post.ts";
import type { Bucket, GithubData, PullRequest } from "./types.ts";

/** The lozenge on a PR raised by a member of the review crew: such a PR may bypass the crew's review. */
export const CREW = "raised by crew member";

/** The buckets that count as waiting on me. */
export const NEEDS_YOU: Bucket[] = ["review_now", "quick_win", "flagged"];

// `id` names the group's section on the page, which remembers the ones I folded shut.
const GROUPS: { id: string; title: string; buckets: Bucket[] }[] = [
  { id: "needs-you", title: "Needs you", buckets: NEEDS_YOU },
  { id: "waiting", title: "Waiting on authors", buckets: ["blocked"] },
  { id: "covered", title: "Covered or low priority", buckets: ["skip", "excluded"] },
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

const KINDS: [string, string][] = [
  ["COMMENT", "Comment"],
  ["APPROVE", "Approve"],
  ["REQUEST_CHANGES", "Request changes"],
];

/**
 * One tickable entry of the dialog: a heading row with its checkbox and where it goes,
 * then its text to edit. A note's heading also carries its severity and a Copy button;
 * the summary's says where it ends up instead.
 */
function entry(pick: string, where: string, text: string, label: string, severity?: string): string {
  const note = severity !== undefined;
  const tail = note ? `<span class="severity">${esc(severity)}</span>\n<button type="button" data-copy-text>Copy</button>` : '<span class="hint">goes in the overall comment</span>';
  return `<div class="finding"${note ? ` data-severity="${esc(severity)}"` : ""}>
<div class="note-head"><label class="pick"><input type="checkbox" autocomplete="off" data-pick="${esc(pick)}"> <span class="where">${esc(where)}</span></label> ${tail}</div>
<textarea data-text autocomplete="off" rows="${note ? 4 : 3}" aria-label="${esc(label)}">${esc(text)}</textarea>
</div>`;
}

/**
 * A drafted review, opened up: every note with a checkbox and its text to edit, a box for
 * my own message, the kind of review, and the button that posts what is ticked to the PR.
 * Nothing is ticked to start, and Comment is the kind selected whatever the draft says:
 * an approval or a change request only goes out when I pick it. `data-draft` is a
 * fingerprint of the draft, so the page never puts one draft's ticks on another and the
 * server never posts a note from a draft other than the one on screen. The boxes are
 * `autocomplete="off"` so that the browser does not refill them after a reload either.
 */
function dialogHtml(pr: PullRequest, review: Review, posted: string): string {
  const key = reviewKey(pr);
  const count = review.findings.length;
  const notes = review.findings.map((f, i) => entry(String(i), `${f.file}:${f.line}`, f.comment, `Note on ${f.file}:${f.line}`, f.severity));
  const kinds = KINDS.map(
    ([value, label]) => `<label><input type="radio" autocomplete="off" name="event:${esc(key)}" value="${value}"${value === "COMMENT" ? " checked" : ""}> ${label}</label>`,
  );
  return `<dialog class="review-dialog" data-review="${esc(key)}" data-draft="${hashOf(review)}" aria-label="Review of ${esc(pr.title)}">
<h2>${link(pr.title, pr.url)}</h2>
<p class="meta">${esc(pr.key)} · ${who(pr.author)} · <span class="tag">Draft says: ${esc(review.verdict.replaceAll("_", " "))}</span> · ${count} ${count === 1 ? "note" : "notes"}</p>
<div class="review-notes">
${[entry("summary", "Summary", review.summary, "Summary"), ...notes].join("\n")}
</div>
<div class="review-post">
<textarea data-message autocomplete="off" rows="2" placeholder="Your message. It goes first." aria-label="Your message"></textarea>
<div class="review-kind" role="radiogroup" aria-label="Kind of review">
${kinds.join("\n")}
</div>
<button type="button" data-review-close>Close</button>
<button type="button" data-review-post disabled>Post</button>
</div>
<p class="review-status" role="status">${esc(posted)}</p>
</dialog>`;
}

function meta(pr: PullRequest): string {
  const why = pr.rank.reasons.filter((r) => !SHOWN_ELSEWHERE.includes(r)).join(", ");
  const parts = [
    esc(pr.key),
    who(pr.author),
    sizeMark(pr.additions, pr.deletions),
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
    const ask = `data-enrich="pr-review" data-key="${esc(reviewKey(pr))}"`;
    // A draft can be asked for again: a rerun replaces it, and a rerun that fails keeps it.
    if (review) {
      const at = view.done[postedKey(reviewKey(pr))];
      const posted = at === undefined ? "" : `Posted ${when(at, view.now, view.config.me.timezone)}`;
      const open = `<button type="button" data-review-open="${esc(reviewKey(pr))}">Open review</button>`;
      extra = `\n${reviewHtml(review)}\n${open}\n${dialogHtml(pr, review, posted)}\n<button ${ask} data-again>Rerun review</button>`;
      if (posted) extra += `\n<p class="fix-note">${posted}</p>`;
    } else extra = `\n<button ${ask}>Draft review</button>`;
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

  const groups = GROUPS.map(({ id, title, buckets }) => {
    const prs = fresh.filter((pr) => buckets.includes(pr.rank.bucket));
    if (prs.length === 0) return "";
    return fold(id, `${title} · ${prs.length}`, `<ul class="items">\n${prs.map((pr) => item(pr, view)).join("\n")}\n</ul>`);
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
