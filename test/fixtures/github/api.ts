// Invented GitHub Enterprise responses, in the shapes the real API returns
// (checked against a live host: search items carry `repository_url`, `draft` and
// `user.login`; CI arrives as commit statuses, with an empty `check_runs` list; a PR
// carries `mergeable` and `mergeable_state`; reviews carry `submitted_at`, comments
// `created_at`, both a `user.type` of "User" or "Bot"; a commit's push time is
// `commit.committer.date`).

export const HOST = "git.example.com";
export const BASE = `https://${HOST}/api/v3`;

type Route = unknown | ((url: string) => unknown);

function searchItem(number: number, over: object = {}) {
  return {
    number,
    title: `PR number ${number}`,
    html_url: `https://${HOST}/o/r/pull/${number}`,
    repository_url: `${BASE}/repos/o/r`,
    created_at: "2026-11-20T01:00:00Z",
    updated_at: "2026-11-24T02:00:00Z",
    draft: false,
    user: { login: "ann" },
    pull_request: { url: `${BASE}/repos/o/r/pulls/${number}` },
    ...over,
  };
}

export interface PullFixture {
  number: number;
  sha: string;
  additions: number;
  deletions: number;
  files: string[];
  status: { state: string; total_count: number };
  runs?: { status: string; conclusion: string | null }[];
  timeline?: object[];
  reviews?: object[];
  item?: object;
}

export const PR1: PullFixture = {
  number: 1,
  sha: "aaa111",
  additions: 12,
  deletions: 3,
  files: ["src/app.ts", "src/app.test.ts"],
  status: { state: "success", total_count: 2 },
};

export const PR2: PullFixture = {
  number: 2,
  sha: "bbb222",
  additions: 900,
  deletions: 40,
  files: ["src/billing/charge.ts", "db/migration_7.sql", "README.md"],
  status: { state: "failure", total_count: 1 },
};

/** One of my own PRs: what the PR, its reviews, its comments and its head commit say. */
export interface MyPullFixture {
  number: number;
  sha: string;
  additions: number;
  deletions: number;
  status: { state: string; total_count: number };
  pushedAt: string;
  mergeable?: boolean | null;
  mergeableState?: string;
  reviews?: object[];
  comments?: object[];
  item?: object;
  /** The statuses behind `status`, each with the link to its build. */
  statuses?: object[];
  /** What the PR itself says, over the usual: open, mine, on `me/ABC-<number>` into `main`, not a fork. */
  pull?: object;
}

const person = (login: string) => ({ login, type: "User" });

/** Approved, green and clean: ready to merge. */
export const MINE1: MyPullFixture = {
  number: 7,
  sha: "mmm777",
  additions: 40,
  deletions: 2,
  status: { state: "success", total_count: 2 },
  pushedAt: "2026-11-23T01:00:00Z",
  mergeable: true,
  mergeableState: "clean",
  reviews: [{ user: person("ann"), state: "APPROVED", submitted_at: "2026-11-23T05:00:00Z", commit_id: "mmm777", body: "" }],
  item: { updated_at: "2026-11-23T05:00:00Z" },
};

/** Red CI, conflicts, and a question nobody has answered. */
export const MINE2: MyPullFixture = {
  number: 8,
  sha: "mmm888",
  additions: 300,
  deletions: 120,
  status: { state: "failure", total_count: 1 },
  pushedAt: "2026-11-24T01:00:00Z",
  mergeable: false,
  mergeableState: "dirty",
  comments: [
    { user: person("ann"), created_at: "2026-11-23T09:00:00Z", body: "Before the push." },
    { user: { login: "ci-bot", type: "Bot" }, created_at: "2026-11-24T01:05:00Z", body: "Build failed." },
    { user: person("ann"), created_at: "2026-11-24T02:00:00Z", body: "Why this way?" },
  ],
  item: { updated_at: "2026-11-24T02:00:00Z" },
};

/**
 * Routes for `fakeHttp` covering the queue search and every fact call for the given PRs,
 * and the same for my own PRs when any are given.
 */
export function githubRoutes(pulls: PullFixture[] = [PR1, PR2], login = "me", mine: MyPullFixture[] = []): Record<string, Route> {
  const queue = { total_count: pulls.length, items: pulls.map((p) => searchItem(p.number, p.item)) };
  const own = { total_count: mine.length, items: mine.map((p) => searchItem(p.number, { user: { login }, ...p.item })) };
  const routes: Record<string, Route> = {
    [`${BASE}/user`]: { login },
    [`${BASE}/search/issues`]: (url: string) => (url.includes("author%3A") ? own : queue),
  };
  for (const p of mine) {
    const pull = `${BASE}/repos/o/r/pulls/${p.number}`;
    routes[pull] = {
      number: p.number,
      draft: false,
      additions: p.additions,
      deletions: p.deletions,
      changed_files: 1,
      state: "open",
      head: { sha: p.sha, ref: `me/ABC-${p.number}`, repo: { full_name: "o/r" } },
      base: { ref: "main", repo: { full_name: "o/r" } },
      user: { login },
      mergeable: p.mergeable ?? null,
      mergeable_state: p.mergeableState ?? "unknown",
      ...p.pull,
    };
    routes[`${pull}/reviews`] = p.reviews ?? [];
    routes[`${BASE}/repos/o/r/issues/${p.number}/comments`] = p.comments ?? [];
    routes[`${BASE}/repos/o/r/commits/${p.sha}`] = { sha: p.sha, commit: { committer: { date: p.pushedAt }, author: { date: p.pushedAt } } };
    routes[`${BASE}/repos/o/r/commits/${p.sha}/check-runs`] = { total_count: 0, check_runs: [] };
    routes[`${BASE}/repos/o/r/commits/${p.sha}/status`] = { ...p.status, statuses: p.statuses ?? [] };
  }
  for (const p of pulls) {
    const pull = `${BASE}/repos/o/r/pulls/${p.number}`;
    routes[pull] = {
      number: p.number,
      draft: false,
      additions: p.additions,
      deletions: p.deletions,
      changed_files: p.files.length,
      head: { sha: p.sha },
      user: { login: "ann" },
    };
    routes[`${pull}/files`] = p.files.map((filename) => ({ filename, status: "modified", additions: 1, deletions: 0 }));
    routes[`${pull}/reviews`] = p.reviews ?? [];
    routes[`${BASE}/repos/o/r/issues/${p.number}/timeline`] = p.timeline ?? [];
    routes[`${BASE}/repos/o/r/commits/${p.sha}/check-runs`] = { total_count: p.runs?.length ?? 0, check_runs: p.runs ?? [] };
    routes[`${BASE}/repos/o/r/commits/${p.sha}/status`] = { ...p.status, statuses: [] };
  }
  return routes;
}
