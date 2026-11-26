import type { PullDetail } from "../client.ts";
import type { CheckRun, Ci, CombinedStatus } from "../types.ts";

// What GitHub says about a PR that a fix needs: may it be fixed, what is wrong with it,
// and which checks are failing.

export interface FailingCheck {
  name: string;
  /** Where the check's build can be seen. A CI server's status links to its build. */
  url?: string;
}

const FAILED_STATUSES = ["failure", "error"];
const FAILED_RUNS = ["failure", "timed_out", "cancelled"];

/** The head commit's failing checks: commit statuses first, then check runs, each in the order given. */
export function failingChecks(runs: CheckRun[], combined: CombinedStatus): FailingCheck[] {
  const named = (name: string | undefined, url: string | null | undefined): FailingCheck => ({ name: name || "a check", ...(url ? { url } : {}) });
  return [
    ...(combined.statuses ?? []).filter((s) => FAILED_STATUSES.includes(s.state)).map((s) => named(s.context, s.target_url)),
    ...runs.filter((r) => FAILED_RUNS.includes(r.conclusion ?? "")).map((r) => named(r.name, r.details_url)),
  ];
}

/**
 * What one attempt works on. Conflicts come first and alone: CI runs again on the merged
 * result, and what it then fails is the next attempt's job.
 */
export function whatToFix(pull: PullDetail, ci: Ci): "conflicts" | "ci" | "running" | "nothing" {
  if (pull.mergeable === false) return "conflicts";
  if (ci === "fail") return "ci";
  if (ci === "pending") return "running";
  return "nothing";
}

/** Why this PR may not be fixed, in plain words, or undefined when it may. */
export function whyNot(pull: PullDetail, login: string, repo: string): string | undefined {
  if (pull.state !== "open") return "the PR is not open";
  if (pull.draft === true) return "the PR is a draft";
  if (pull.user?.login.toLowerCase() !== login.toLowerCase()) return "the PR is not yours";
  const same = (name: string | undefined) => name?.toLowerCase() === repo.toLowerCase();
  if (pull.head.repo === null || (pull.head.repo && !same(pull.head.repo.full_name))) return "the PR comes from a fork";
  if (!pull.head.ref || !pull.base?.ref || !pull.head.repo) return "GitHub did not say which branches the PR is on";
  if (pull.base.repo && !same(pull.base.repo.full_name)) return "the PR comes from a fork";
  return undefined;
}
