export type Request = "rotation" | "team" | "direct" | "ambiguous";

export type Bucket = "review_now" | "quick_win" | "flagged" | "blocked" | "skip" | "excluded";

export type Ci = "pass" | "fail" | "pending" | "none";

/** What the PR's post in the Slack review channel says about it. */
export interface Signal {
  kind: "skip" | "flag";
  reason: string;
  url: string;
}

export interface Rank {
  score: number;
  bucket: Bucket;
  reasons: string[];
}

export interface PullRequest {
  /** `owner/repo#number` */
  key: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  headSha: string;
  createdAt: number;
  updatedAt: number;
  draft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  paths: string[];
  ci: Ci;
  request: Request;
  reviewedByMeAtHead: boolean;
  signal?: Signal;
  /** Raised by a member of the review crew, so it may bypass the crew's review. */
  byCrew?: boolean;
  rank: Rank;
}

/** Where the reviews of one of my PRs stand. */
export type ReviewState = "approved" | "changes_requested" | "none";

/**
 * What one of my PRs is waiting on, and why in plain words. `me` calls for me now: it is
 * ready to merge, or a reviewer asked for changes. `fix` is mine to fix, without the call.
 */
export interface Waits {
  on: "me" | "fix" | "others" | "draft";
  reasons: string[];
}

/** An open PR that I raised. */
export interface MyPull {
  /** `owner/repo#number` */
  key: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  headSha: string;
  createdAt: number;
  updatedAt: number;
  draft: boolean;
  additions: number;
  deletions: number;
  ci: Ci;
  review: ReviewState;
  conflicts: boolean;
  /** Comments from other people since I last commented or pushed. */
  unanswered: number;
  waits: Waits;
  /** Missing in data collected before fixes were. */
  fix?: FixState;
}

/** One try at fixing one of my PRs. Kept in `out/fix/attempts.json`, a list per PR key. */
export interface Attempt {
  at: number;
  what: "ci" | "conflicts";
  /** The failing checks it was for. Empty for conflicts. */
  checks: string[];
  /** The head commit the attempt started from. */
  startSha: string;
  /** The commit it pushed, when it pushed one. */
  pushedSha?: string;
  outcome: "pushed" | "gave-up" | "failed";
  /** Claude's summary, or why it stopped. Plain words for the PR's line. */
  text: string;
  /** False when the attempt ended before Claude was asked. Only true ones count toward the limit. */
  ranClaude: boolean;
  costUsd?: number;
}

/** Where one of my PRs stands with the Fix button. */
export interface FixState {
  /** A Fix button belongs on this PR now. */
  can: boolean;
  /** Attempts in a row have reached `github.fix.maxAttempts`. */
  spent: boolean;
  /** The latest attempt on the current chain. */
  last?: { at: number; outcome: Attempt["outcome"]; text: string };
}

export interface GithubData {
  login: string;
  prs: PullRequest[];
  /** My own open PRs. Missing in data collected before they were. */
  mine?: MyPull[];
}

/** Something said on a PR: a comment, or a review that only comments. */
export interface Voice {
  login: string;
  bot: boolean;
  at: number;
}

/** One submitted review. */
export interface Verdict {
  login: string;
  /** GitHub's review state: APPROVED, CHANGES_REQUESTED, DISMISSED, COMMENTED. */
  state: string;
  at: number;
}

/** What is fetched once per update or push of one of my PRs and kept in the cache. */
export interface MyFacts {
  updatedAt: number;
  headSha: string;
  /** When the head commit was made, which stands for when I last pushed. */
  pushedAt: number;
  verdicts: Verdict[];
  said: Voice[];
}

/** A PR timeline entry. Only `review_requested` events are kept. */
export interface TimelineEvent {
  event: string;
  created_at: string;
  actor?: { login: string };
  requested_team?: { slug: string };
  requested_reviewer?: { login: string };
}

/** One hit from the review-queue search. */
export interface QueueHit {
  key: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  draft: boolean;
  createdAt: number;
  updatedAt: number;
}

/** What is fetched once per PR update and kept in the cache. */
export interface Facts {
  updatedAt: number;
  headSha: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  paths: string[];
  requests: TimelineEvent[];
  reviewedByMeAtHead: boolean;
}

export interface CheckRun {
  status: string;
  conclusion: string | null;
}

export interface CombinedStatus {
  state: string;
  total_count: number;
}
