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

/** Who one of my PRs is waiting on, and why in plain words. */
export interface Waits {
  on: "me" | "others" | "draft";
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
