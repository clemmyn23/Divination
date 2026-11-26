import type { Panel, View } from "../../core/types.ts";
import { doneAccordion, isDone, tick } from "../../render/done.ts";
import { esc, link } from "../../render/html.ts";
import { isOld, staleAccordion } from "../../render/old.ts";
import { ciMark, sizeText } from "./marks.ts";
import type { GithubData, MyPull, ReviewState, Waits } from "./types.ts";

const GROUPS: { title: string; on: Waits["on"] }[] = [
  { title: "Needs you", on: "me" },
  { title: "Waiting on others", on: "others" },
  { title: "Drafts", on: "draft" },
];

const VERDICT: Record<ReviewState, string> = { approved: "approved", changes_requested: "changes requested", none: "" };

// Already shown on the meta line by the CI mark and the verdict's lozenge.
const SHOWN_ELSEWHERE = ["CI failing", "CI running", "changes requested"];

/**
 * The key that marks one of my PRs done. It includes the head commit and what the PR is
 * waiting on, so a new commit, a new comment or a CI failure brings the PR back.
 */
export const myDoneKey = (pr: MyPull) => `mine:${pr.key}@${pr.headSha}:${pr.waits.reasons.join(",")}`;

function meta(pr: MyPull): string {
  const verdict = Object.hasOwn(VERDICT, pr.review) ? VERDICT[pr.review] : "";
  const why = pr.waits.reasons.filter((r) => !SHOWN_ELSEWHERE.includes(r)).join(", ");
  const parts = [
    esc(pr.key),
    sizeText(pr.additions, pr.deletions),
    ciMark(pr.ci),
    ...(verdict ? [`<span class="tag">${verdict}</span>`] : []),
    ...(why ? [esc(why)] : []),
  ];
  return `<p class="meta">${parts.join(" · ")}</p>`;
}

function item(pr: MyPull, view: View): string {
  const key = myDoneKey(pr);
  return `<li class="item pr${pr.waits.on === "me" ? " needs-you" : ""}">${link(pr.title, pr.url)}
${meta(pr)}${tick(key, isDone(key, view))}</li>`;
}

const list = (prs: MyPull[], view: View) => `<ul class="items">\n${prs.map((pr) => item(pr, view)).join("\n")}\n</ul>`;

/**
 * My own open PRs, grouped by who each is waiting on, one title and one meta line each.
 * PRs with nothing new for longer than `hideOlderThanDays` fold into one accordion at the
 * end, and PRs ticked off by hand into another.
 */
export function myPrsPanel(data: GithubData, view: View): Panel {
  const all = data.mine ?? [];
  const done = all.filter((pr) => isDone(myDoneKey(pr), view));
  const open = all.filter((pr) => !isDone(myDoneKey(pr), view));
  const stale = open.filter((pr) => isOld(pr.updatedAt, view));
  const fresh = open.filter((pr) => !isOld(pr.updatedAt, view));

  const groups = GROUPS.map(({ title, on }) => {
    const prs = fresh.filter((pr) => pr.waits.on === on);
    return prs.length === 0 ? "" : `<h3 class="group">${title} · ${prs.length}</h3>\n${list(prs, view)}`;
  }).filter((html) => html !== "");

  if (stale.length > 0) groups.push(staleAccordion(stale.length, list(stale, view)));
  if (done.length > 0) groups.push(doneAccordion(done.length, list(done, view)));

  const html = groups.length > 0 ? groups.join("\n") : '<p class="quiet">No open PRs of yours.</p>';
  return { id: "my-prs", title: "My PRs", tint: "sky", size: "short", html };
}
