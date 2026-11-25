// Invented GitHub Enterprise responses, in the shapes the real API returns
// (checked against a live host: search items carry `repository_url`, `draft` and
// `user.login`; CI arrives as commit statuses, with an empty `check_runs` list).

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

/** Routes for `fakeHttp` covering the queue search and every fact call for the given PRs. */
export function githubRoutes(pulls: PullFixture[] = [PR1, PR2], login = "me"): Record<string, Route> {
  const routes: Record<string, Route> = {
    [`${BASE}/user`]: { login },
    [`${BASE}/search/issues`]: { total_count: pulls.length, items: pulls.map((p) => searchItem(p.number, p.item)) },
  };
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
