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
  rank: Rank;
}

export interface GithubData {
  login: string;
  prs: PullRequest[];
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
