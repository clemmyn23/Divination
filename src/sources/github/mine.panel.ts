import type { Panel, View } from "../../core/types.ts";
import { doneAccordion, isDone, tick } from "../../render/done.ts";
import { esc, link } from "../../render/html.ts";
import { isOld, staleAccordion } from "../../render/old.ts";
import { tried } from "./fix/rules.ts";
import { ciMark, sizeText } from "./marks.ts";
import type { GithubData, MyPull, ReviewState, Waits } from "./types.ts";

const GROUPS: { title: string; on: Waits["on"] }[] = [
  { title: "Needs you", on: "me" },
  { title: "To fix", on: "fix" },
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

/** A time today as `10:42`, an earlier day as `23 Nov`, in my time zone. */
function when(at: number, view: View): string {
  const timeZone = view.config.me.timezone;
  const day = (ms: number) => new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short" }).format(new Date(ms));
  if (day(at) !== day(view.now)) return day(at);
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(at));
}

/** What the latest attempt at fixing this PR did, as one line; and at the limit, that it is over to me. */
function fixNote(pr: MyPull, view: View): string {
  const last = pr.fix?.last;
  let words = "";
  if (pr.fix?.spent) {
    const said = tried(view.config.github.fix.maxAttempts);
    words = `${said[0]!.toUpperCase()}${said.slice(1)}.${last ? ` Last: ${last.text}` : ""}`;
  } else if (last?.outcome === "pushed") {
    words = `Fix pushed ${when(last.at, view)}: ${last.text}${pr.ci === "pending" ? " Waiting on CI." : ""}`;
  } else if (last?.outcome === "gave-up") words = `Could not fix: ${last.text}`;
  else if (last) words = `Fix failed: ${last.text}`;
  return words ? `\n<p class="fix-note">${esc(words)}</p>` : "";
}

/** The button that starts a fix. It calls Claude and pushes, so it carries the sparkle. */
const fixButton = (pr: MyPull) => (pr.fix?.can ? `\n<button data-fix="${esc(pr.key)}">Fix</button>` : "");

function item(pr: MyPull, view: View): string {
  const key = myDoneKey(pr);
  return `<li class="item pr${pr.waits.on === "me" ? " needs-you" : ""}">${link(pr.title, pr.url)}
${meta(pr)}${fixNote(pr, view)}${fixButton(pr)}${tick(key, isDone(key, view))}</li>`;
}

// The groups whose PRs are mine to act on. Fix all works through these, in this order.
const MINE_TO_FIX: Waits["on"][] = ["me", "fix"];

/**
 * The PRs that Fix all covers, in the panel's order: fixable ones in the open groups. A PR
 * folded away as old, or ticked off, is left out; it keeps its own Fix button, so fixing a
 * long-quiet PR is always a deliberate press.
 */
export function openFixable(mine: MyPull[], view: View): MyPull[] {
  const open = mine.filter((pr) => pr.fix?.can && !isDone(myDoneKey(pr), view) && !isOld(pr.updatedAt, view));
  return MINE_TO_FIX.flatMap((on) => open.filter((pr) => pr.waits.on === on));
}

const list = (prs: MyPull[], view: View) => `<ul class="items">\n${prs.map((pr) => item(pr, view)).join("\n")}\n</ul>`;

/**
 * My own open PRs, grouped by what each is waiting on, one title and one meta line each.
 * PRs with nothing new for longer than `hideOlderThanDays` fold into one accordion at the
 * end, and PRs ticked off by hand into another. A PR that can be fixed has a Fix button,
 * and one that has been tried says what the last attempt did.
 */
export function myPrsPanel(data: GithubData, view: View): Panel {
  const all = data.mine ?? [];
  const done = all.filter((pr) => isDone(myDoneKey(pr), view));
  const open = all.filter((pr) => !isDone(myDoneKey(pr), view));
  const stale = open.filter((pr) => isOld(pr.updatedAt, view));
  const fresh = open.filter((pr) => !isOld(pr.updatedAt, view));

  // Fix all sits under the heading of the last group it covers: "To fix", or "Needs you" when that is all there is.
  const toFix = openFixable(all, view);
  const fixAllUnder = toFix.length < 2 ? undefined : MINE_TO_FIX.findLast((on) => toFix.some((pr) => pr.waits.on === on));
  const fixAll = `\n<button data-fix="all" title="Fixes ${toFix.length} PRs, one at a time">Fix all</button>`;

  const groups = GROUPS.map(({ title, on }) => {
    const prs = fresh.filter((pr) => pr.waits.on === on);
    return prs.length === 0 ? "" : `<h3 class="group">${title} · ${prs.length}</h3>${on === fixAllUnder ? fixAll : ""}\n${list(prs, view)}`;
  }).filter((html) => html !== "");

  if (stale.length > 0) groups.push(staleAccordion(stale.length, list(stale, view)));
  if (done.length > 0) groups.push(doneAccordion(done.length, list(done, view)));

  const html = groups.length > 0 ? groups.join("\n") : '<p class="quiet">No open PRs of yours.</p>';
  return { id: "my-prs", title: "My PRs", tint: "sky", size: "short", html };
}
