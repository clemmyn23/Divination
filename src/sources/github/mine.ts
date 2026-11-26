import type { Ci, MyPull, ReviewState, Verdict, Voice, Waits } from "./types.ts";

export type { Verdict, Voice } from "./types.ts";

const DECISIVE = ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"];
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Where the reviews stand, and since when. Each person's latest verdict is the one that
 * counts, and one request for changes outweighs any approval.
 */
export function reviewState(reviews: Verdict[], me: string): { state: ReviewState; at: number } {
  const latest = new Map<string, Verdict>();
  for (const review of [...reviews].sort((a, b) => a.at - b.at)) {
    if (DECISIVE.includes(review.state) && !same(review.login, me)) latest.set(review.login.toLowerCase(), review);
  }
  const newest = (state: string) => Math.max(0, ...[...latest.values()].filter((r) => r.state === state).map((r) => r.at));
  const changes = newest("CHANGES_REQUESTED");
  if (changes > 0) return { state: "changes_requested", at: changes };
  const approved = newest("APPROVED");
  return approved > 0 ? { state: "approved", at: approved } : { state: "none", at: 0 };
}

/** When I last spoke on the PR: my latest comment, or my latest push if that is later. */
export function lastWord(said: Voice[], me: string, pushedAt: number): number {
  return Math.max(pushedAt, ...said.filter((v) => same(v.login, me)).map((v) => v.at));
}

/** How many times other people have spoken since my last word. Bots and the names in `ignore` do not count. */
export function unanswered(said: Voice[], me: string, pushedAt: number, ignore: string[]): number {
  const since = lastWord(said, me, pushedAt);
  const skip = new Set(ignore.map((name) => name.toLowerCase()));
  return said.filter((v) => !same(v.login, me) && !v.bot && !skip.has(v.login.toLowerCase()) && v.at > since).length;
}

export interface Standing {
  draft: boolean;
  ci: Ci;
  review: ReviewState;
  reviewAnswered: boolean;
  conflicts: boolean;
  /** GitHub says something required is still missing: another approval, a required check. */
  blocked: boolean;
  unanswered: number;
}

/** Who a PR of mine is waiting on. Anything I can act on makes it mine; a draft waits on nobody. */
export function waitsOn(pr: Standing): Waits {
  if (pr.draft) return { on: "draft", reasons: [] };

  const mine: string[] = [];
  if (pr.ci === "fail") mine.push("CI failing");
  if (pr.review === "changes_requested" && !pr.reviewAnswered) mine.push("changes requested");
  if (pr.conflicts) mine.push("merge conflicts");
  if (pr.unanswered > 0) mine.push(`${pr.unanswered} ${pr.unanswered === 1 ? "comment" : "comments"} to answer`);
  const green = pr.ci === "pass" || pr.ci === "none";
  if (pr.review === "approved" && green && !pr.conflicts && !pr.blocked) mine.push("ready to merge");
  if (mine.length > 0) return { on: "me", reasons: mine };

  const others: string[] = [];
  if (pr.ci === "pending") others.push("CI running");
  if (pr.review === "changes_requested") others.push("waiting on a second look");
  else if (pr.review === "none") others.push("waiting on review");
  else if (pr.ci !== "pending") others.push("waiting on another approval or check");
  return { on: "others", reasons: others };
}

const ORDER: Waits["on"][] = ["me", "others", "draft"];

/** The ones waiting on me first, drafts last, and the latest activity first within each. */
export function sortMine(prs: MyPull[]): MyPull[] {
  return [...prs].sort((a, b) => ORDER.indexOf(a.waits.on) - ORDER.indexOf(b.waits.on) || b.updatedAt - a.updatedAt);
}
