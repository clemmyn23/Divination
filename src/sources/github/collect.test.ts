import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, HOST, MINE1, MINE2, PR1, PR2, githubRoutes } from "../../../test/fixtures/github/api.ts";
import { contextWith, fakeExec, fakeHttp, tempRoot } from "../../../test/helpers.ts";
import { ciState, collectGithub } from "./collect.ts";
import { recordAttempt } from "./fix/attempts.ts";
import { github } from "./index.ts";

function setup(routes = githubRoutes(), local: object = {}) {
  const http = fakeHttp(routes);
  const exec = fakeExec({ "gh auth token": { stdout: "tok-123\n" } });
  const ctx = contextWith({ github: { host: HOST }, ...local }, { http, exec });
  return { ctx, http, exec };
}

test("collects the queue with facts and CI", async () => {
  const { ctx } = setup();
  const data = await collectGithub(ctx);
  assert.equal(data.login, "me");
  assert.deepEqual(
    data.prs.map((p) => [p.key, p.headSha, p.ci, p.additions, p.paths.length]),
    [
      ["o/r#1", "aaa111", "pass", 12, 2],
      ["o/r#2", "bbb222", "fail", 900, 3],
    ],
  );
});

test("a PR carries what the search and the PR itself say about it", async () => {
  const { ctx } = setup();
  const [pr] = (await collectGithub(ctx)).prs;
  assert.deepEqual(
    { ...pr, paths: undefined },
    {
      key: "o/r#1",
      repo: "o/r",
      number: 1,
      title: "PR number 1",
      url: `https://${HOST}/o/r/pull/1`,
      author: "ann",
      headSha: "aaa111",
      createdAt: Date.parse("2026-11-20T01:00:00Z"),
      updatedAt: Date.parse("2026-11-24T02:00:00Z"),
      draft: false,
      additions: 12,
      deletions: 3,
      changedFiles: 2,
      paths: undefined,
      ci: "pass",
      request: "ambiguous",
      reviewedByMeAtHead: false,
      // 15 changed lines, no risky paths, green CI, opened 4 days before NOW
      rank: { score: 2, bucket: "quick_win", reasons: ["quick win", "4 days old", "CI passing"] },
    },
  );
  assert.deepEqual(pr!.paths, ["src/app.ts", "src/app.test.ts"]);
});

test("uses the token from gh and the enterprise API base", async () => {
  const { ctx, http, exec } = setup();
  await collectGithub(ctx);
  assert.deepEqual(exec.calls[0], ["gh", "auth", "token", "--hostname", "git.example.com"]);
  assert.equal(exec.calls.length, 1); // asked once, reused for every request
  assert.ok(http.calls.every((u) => u.startsWith("https://git.example.com/api/v3/")));
  assert.ok(http.calls.some((u) => u.includes("review-requested%3Ame")));
});

test("unchanged PRs reuse cached facts but refetch CI", async () => {
  const { ctx, http } = setup();
  await collectGithub(ctx);
  http.calls.length = 0;
  const again = await collectGithub(ctx);
  assert.equal(http.calls.filter((u) => /\/pulls\/\d+($|\/files|\/reviews)|\/timeline/.test(u)).length, 0);
  assert.equal(http.calls.filter((u) => u.includes("/check-runs")).length, 2);
  assert.deepEqual(again.prs.map((p) => [p.key, p.additions]), [["o/r#1", 12], ["o/r#2", 900]]);
});

test("a PR that was updated is fetched again, and one that left the queue is forgotten", async () => {
  const first = setup();
  await collectGithub(first.ctx);

  const moved = { ...PR1, sha: "ccc333", additions: 50, item: { updated_at: "2026-11-25T03:00:00Z" } };
  const http = fakeHttp(githubRoutes([moved]));
  const data = await collectGithub({ ...first.ctx, http });
  assert.deepEqual(data.prs.map((p) => [p.key, p.headSha, p.additions]), [["o/r#1", "ccc333", 50]]);
  assert.ok(http.calls.some((u) => u.endsWith("/repos/o/r/pulls/1")));

  // PR 2 is gone from the cache: when it comes back unchanged it must be fetched, not reused.
  const back = fakeHttp(githubRoutes([moved, PR2]));
  await collectGithub({ ...first.ctx, http: back });
  assert.ok(back.calls.some((u) => u.endsWith("/repos/o/r/pulls/2")));
});

test("file lists follow the next link and stop at 300 files", async () => {
  const routes = githubRoutes([PR1]);
  const page = (from: number, next?: string) => ({
    $data: Array.from({ length: 100 }, (_, i) => ({ filename: `f${from + i}.ts` })),
    $headers: next ? { link: `<${next}>; rel="next", <${BASE}/x>; rel="last"` } : {},
  });
  const more = `${BASE}/repositories/9/pulls/1/files?per_page=100&page=`;
  routes[`${BASE}/repos/o/r/pulls/1/files`] = page(0, `${more}2`);
  routes[`${more}2`] = page(100, `${more}3`);
  routes[`${more}3`] = page(200, `${more}4`);
  routes[`${more}4`] = () => {
    throw new Error("a fourth page must not be requested");
  };
  const { ctx } = setup(routes);
  const [pr] = (await collectGithub(ctx)).prs;
  assert.equal(pr!.paths.length, 300);
  assert.equal(pr!.paths[299], "f299.ts");
});

test("a next link that points at another host is not followed", async () => {
  const routes = githubRoutes([PR1]);
  routes[`${BASE}/repos/o/r/pulls/1/files`] = {
    $data: [{ filename: "a.ts" }],
    $headers: { link: '<https://evil.example/steal?page=2>; rel="next"' },
  };
  const { ctx, http } = setup(routes);
  const [pr] = (await collectGithub(ctx)).prs;
  assert.deepEqual(pr!.paths, ["a.ts"]);
  assert.ok(!http.calls.some((u) => u.includes("evil.example")));
});

test("my own review at the head commit is noticed; an older one is not", async () => {
  const mine = { ...PR1, reviews: [{ user: { login: "me" }, commit_id: "aaa111", state: "COMMENTED" }] };
  const stale = { ...PR2, reviews: [{ user: { login: "me" }, commit_id: "old000", state: "APPROVED" }, { user: { login: "ann" }, commit_id: "bbb222", state: "COMMENTED" }] };
  const { ctx } = setup(githubRoutes([mine, stale]));
  const byKey = Object.fromEntries((await collectGithub(ctx)).prs.map((p) => [p.key, p]));
  assert.equal(byKey["o/r#1"]!.reviewedByMeAtHead, true);
  assert.equal(byKey["o/r#1"]!.rank.bucket, "excluded"); // and so it drops out of what needs me
  assert.equal(byKey["o/r#2"]!.reviewedByMeAtHead, false);
});

test("a draft is carried through", async () => {
  const { ctx } = setup(githubRoutes([{ ...PR1, item: { draft: true } }]));
  assert.equal((await collectGithub(ctx)).prs[0]!.draft, true);
});

test("ci states", () => {
  assert.equal(ciState([{ status: "completed", conclusion: "success" }], { state: "success", total_count: 1 }), "pass");
  assert.equal(ciState([{ status: "in_progress", conclusion: null }], { state: "pending", total_count: 0 }), "pending");
  assert.equal(ciState([{ status: "completed", conclusion: "failure" }], { state: "success", total_count: 1 }), "fail");
  assert.equal(ciState([], { state: "pending", total_count: 0 }), "none");
  // statuses only, which is how the work host reports CI
  assert.equal(ciState([], { state: "success", total_count: 8 }), "pass");
  assert.equal(ciState([], { state: "pending", total_count: 3 }), "pending");
  assert.equal(ciState([], { state: "error", total_count: 1 }), "fail");
  assert.equal(ciState([{ status: "completed", conclusion: "timed_out" }], { state: "success", total_count: 0 }), "fail");
  assert.equal(ciState([{ status: "completed", conclusion: "skipped" }], { state: "pending", total_count: 0 }), "pass");
});

test("not logged in is a clear error", async () => {
  const { ctx } = setup();
  await assert.rejects(
    collectGithub({ ...ctx, exec: fakeExec({ "gh auth token": { code: 1 } }) }),
    /gh is not logged in to git\.example\.com/,
  );
});

test("a missing host is a clear error before anything is called", async () => {
  const http = fakeHttp({});
  const exec = fakeExec({});
  const ctx = contextWith({}, { http, exec });
  await assert.rejects(collectGithub(ctx), /github\.host is not set/);
  assert.equal(http.calls.length + exec.calls.length, 0);
});

test("the token never reaches the collected data", async () => {
  const { ctx } = setup();
  assert.ok(!JSON.stringify(await collectGithub(ctx)).includes("tok-123"));
});

test("validate accepts collected data and names what is wrong otherwise", async () => {
  const { ctx } = setup();
  assert.deepEqual(github.validate(await collectGithub(ctx)), []);
  assert.deepEqual(github.validate(null), ["github data must be an object"]);
  assert.deepEqual(github.validate({ prs: [] }), ["login must be a string"]);
  const problems = github.validate({ login: "me", prs: [{ key: "o/r#1" }] });
  assert.ok(problems.includes("prs[0] needs headSha") && problems.includes("prs[0] needs rank.bucket"));
  assert.ok(!problems.includes("prs[0] needs key"));
});

test("doctor passes when gh is logged in and the API answers", async () => {
  const { ctx } = setup();
  const checks = await github.doctor(ctx);
  assert.deepEqual(checks.map((c) => [c.name, c.ok]), [["host", true], ["gh login", true], ["api", true]]);
  assert.match(checks[2]!.detail, /signed in as me/);
});

test("doctor says how to fix a missing host or login", async () => {
  const noHost = await github.doctor(contextWith({}, { http: fakeHttp({}), exec: fakeExec({}) }));
  assert.deepEqual(noHost.map((c) => [c.name, c.ok]), [["host", false]]);
  assert.match(noHost[0]!.fix!, /config\/local\.yaml/);

  const { ctx } = setup();
  const noLogin = await github.doctor({ ...ctx, exec: fakeExec({ "gh auth token": { code: 1 } }) });
  assert.deepEqual(noLogin.map((c) => [c.name, c.ok]), [["host", true], ["gh login", false]]);
  assert.equal(noLogin[1]!.fix, "gh auth login --hostname git.example.com");
});

test("doctor reports an API that does not answer", async () => {
  const { ctx } = setup({ [`${BASE}/user`]: new Error("cannot reach git.example.com: fetch failed") });
  const checks = await github.doctor(ctx);
  assert.deepEqual(checks.map((c) => [c.name, c.ok]), [["host", true], ["gh login", true], ["api", false]]);
  assert.match(checks[2]!.detail, /cannot reach git\.example\.com/);
});

test("a PR raised by a crew member is marked, whatever the case of the name; others are not", async () => {
  // Both PRs in the fixture were raised by "ann".
  const crew = await collectGithub(setup(githubRoutes(), { github: { host: HOST, crew: { members: ["zed", "ANN"] } } }).ctx);
  assert.deepEqual(crew.prs.map((p) => [p.author, p.byCrew]), [["ann", true], ["ann", true]]);

  const others = await collectGithub(setup(githubRoutes(), { github: { host: HOST, crew: { members: ["zed"] } } }).ctx);
  assert.ok(others.prs.every((p) => !("byCrew" in p)));
});

test("my own open PRs are collected, each with what it is waiting on", async () => {
  const { ctx, http } = setup(githubRoutes([PR1], "me", [MINE1, MINE2]));
  const data = await collectGithub(ctx);
  assert.ok(http.calls.some((u) => u.includes("author%3Ame")));
  assert.deepEqual(
    data.mine!.map((p) => [p.key, p.ci, p.review, p.conflicts, p.unanswered, p.waits]),
    [
      // the one that calls for me first, then the one that is mine to fix
      ["o/r#7", "pass", "approved", false, 0, { on: "me", reasons: ["ready to merge"] }],
      ["o/r#8", "fail", "none", true, 1, { on: "fix", reasons: ["CI failing", "merge conflicts", "1 comment to answer"] }],
    ],
  );
  assert.deepEqual(data.prs.map((p) => p.key), ["o/r#1"]); // the review queue is not mixed in
});

test("one of my PRs carries what the search, the PR and its head commit say about it", async () => {
  const { ctx } = setup(githubRoutes([], "me", [MINE1]));
  assert.deepEqual((await collectGithub(ctx)).mine, [
    {
      key: "o/r#7",
      repo: "o/r",
      number: 7,
      title: "PR number 7",
      url: `https://${HOST}/o/r/pull/7`,
      headSha: "mmm777",
      createdAt: Date.parse("2026-11-20T01:00:00Z"),
      updatedAt: Date.parse("2026-11-23T05:00:00Z"),
      draft: false,
      additions: 40,
      deletions: 2,
      ci: "pass",
      review: "approved",
      conflicts: false,
      unanswered: 0,
      waits: { on: "me", reasons: ["ready to merge"] },
      fix: { can: false, spent: false },
    },
  ]);
});

test("with no open PRs of my own the list is empty", async () => {
  assert.deepEqual((await collectGithub(setup().ctx)).mine, []);
});

test("an unchanged PR of mine reuses its reviews and comments but asks again for conflicts and CI", async () => {
  const { ctx, http } = setup(githubRoutes([], "me", [MINE2]));
  await collectGithub(ctx);
  http.calls.length = 0;
  const again = await collectGithub(ctx);
  assert.equal(http.calls.filter((u) => /\/reviews|\/comments|\/commits\/mmm888$/.test(u)).length, 0);
  assert.equal(http.calls.filter((u) => u.endsWith("/pulls/8")).length, 1);
  assert.equal(http.calls.filter((u) => u.includes("/check-runs")).length, 1);
  assert.equal(again.mine![0]!.unanswered, 1);
});

test("a new push to one of my PRs is noticed even when nothing else moved", async () => {
  const first = setup(githubRoutes([], "me", [MINE2]));
  await collectGithub(first.ctx);
  // The push answers the question, and the new commit is green and merges cleanly.
  const pushed = { ...MINE2, sha: "mmm999", pushedAt: "2026-11-24T03:00:00Z", mergeable: true, status: { state: "success", total_count: 1 } };
  const data = await collectGithub({ ...first.ctx, http: fakeHttp(githubRoutes([], "me", [pushed])) });
  assert.deepEqual(data.mine!.map((p) => [p.headSha, p.unanswered, p.waits]), [["mmm999", 0, { on: "others", reasons: ["waiting on review"] }]]);
});

test("comments from the people I have chosen to ignore do not wait on an answer", async () => {
  const local = { github: { host: HOST, mine: { ignoreCommenters: ["ANN"] } } };
  const { ctx } = setup(githubRoutes([], "me", [{ ...MINE2, mergeable: true, status: { state: "success", total_count: 1 } }]), local);
  assert.deepEqual((await collectGithub(ctx)).mine!.map((p) => [p.unanswered, p.waits.on]), [[0, "others"]]);
});

test("requested changes call for me until I push, then wait on the reviewer", async () => {
  const asked = { user: { login: "ann", type: "User" }, state: "CHANGES_REQUESTED", submitted_at: "2026-11-23T03:00:00Z", commit_id: "mmm777", body: "Split this." };
  const waiting = await collectGithub(setup(githubRoutes([], "me", [{ ...MINE1, reviews: [asked] }])).ctx);
  assert.deepEqual(waiting.mine![0]!.waits, { on: "me", reasons: ["changes requested"] });

  const pushed = await collectGithub(setup(githubRoutes([], "me", [{ ...MINE1, reviews: [asked], pushedAt: "2026-11-23T04:00:00Z" }])).ctx);
  assert.deepEqual(pushed.mine![0]!.waits, { on: "others", reasons: ["waiting on a second look"] });
});

test("a draft of mine waits on nobody, and drafts come last", async () => {
  const draft = { ...MINE2, item: { draft: true, updated_at: "2026-11-24T22:00:00Z" } };
  const data = await collectGithub(setup(githubRoutes([], "me", [draft, MINE1])).ctx);
  assert.deepEqual(data.mine!.map((p) => [p.key, p.draft, p.waits.on]), [["o/r#7", false, "me"], ["o/r#8", true, "draft"]]);
});

// The crew and me asked in one action: a rotation pick, for someone whose config names that crew.
const PICKED = {
  ...PR1,
  timeline: [
    { event: "review_requested", created_at: "2026-11-24T01:00:00Z", actor: { login: "ann" }, requested_team: { slug: "frontend-crew" } },
    { event: "review_requested", created_at: "2026-11-24T01:00:00Z", actor: { login: "ann" }, requested_reviewer: { login: "me" } },
  ],
};

test("with a crew configured, its rotation picks and its members' PRs are marked", async () => {
  const local = { github: { host: HOST, crew: { rotationTeam: "frontend-crew", members: ["ann"] } } };
  const [pr] = (await collectGithub(setup(githubRoutes([PICKED]), local).ctx)).prs;
  assert.deepEqual([pr!.request, pr!.byCrew, pr!.rank.reasons.includes("rotation")], ["rotation", true, true]);
});

test("with no crew configured, the same PR is a direct request, nobody is crew and Slack is not asked", async () => {
  const { ctx, http } = setup(githubRoutes([PICKED]));
  const [pr] = (await collectGithub({ ...ctx, secrets: { get: async () => "xoxp-sekrit" } })).prs;
  assert.deepEqual([pr!.request, "byCrew" in pr!, "signal" in pr!, pr!.rank.reasons.includes("rotation")], ["direct", false, false, false]);
  assert.ok(http.calls.every((u) => u.startsWith(BASE)));
});

const WITH_CLONE = { github: { host: HOST, fix: { clones: { "o/r": "/work/monolith" } } } };
const tried = (startSha: string, pushedSha: string, text = "Moved the helper.") => ({ at: 5, what: "ci" as const, checks: [], startSha, pushedSha, outcome: "pushed" as const, text, ranClaude: true });

test("each PR of mine says whether it can be fixed", async () => {
  const withClone = await collectGithub(setup(githubRoutes([], "me", [MINE1, MINE2]), WITH_CLONE).ctx);
  assert.deepEqual(withClone.mine!.map((p) => [p.key, p.fix]), [
    ["o/r#7", { can: false, spent: false }], // green: nothing to fix
    ["o/r#8", { can: true, spent: false }], // red and conflicted
  ]);
  const without = await collectGithub(setup(githubRoutes([], "me", [MINE1, MINE2])).ctx);
  assert.deepEqual(without.mine!.map((p) => p.fix), [{ can: false, spent: false }, { can: false, spent: false }]);
});

test("after two attempts in a row a PR says so, with what the last one did", async () => {
  // "s0" is my own last commit: both commits after it were pushed by fixes.
  const routes = { ...githubRoutes([], "me", [MINE2]), [`${BASE}/repos/o/r/commits/s0`]: { sha: "s0", commit: { committer: { date: MINE2.pushedAt } } } };
  const { ctx } = setup(routes, WITH_CLONE);
  recordAttempt(ctx, "o/r#8", tried("s0", "s1", "First try."));
  recordAttempt(ctx, "o/r#8", tried("s1", MINE2.sha, "Second try."));
  assert.deepEqual((await collectGithub(ctx)).mine![0]!.fix, { can: false, spent: true, last: { at: 5, outcome: "pushed", text: "Second try." } });
});

test("a fix's push is not my answer: changes requested before it still wait on me", async () => {
  // Changes were requested at 05:00. The head commit, made at 09:00, is one a fix pushed;
  // my own last commit was at 02:00.
  const asked = {
    ...MINE1,
    sha: "fixsha",
    pushedAt: "2026-11-23T09:00:00Z",
    reviews: [{ user: { login: "ann", type: "User" }, state: "CHANGES_REQUESTED", submitted_at: "2026-11-23T05:00:00Z", commit_id: "minesha", body: "" }],
  };
  const routes = () => ({
    ...githubRoutes([], "me", [asked]),
    [`${BASE}/repos/o/r/commits/minesha`]: { sha: "minesha", commit: { committer: { date: "2026-11-23T02:00:00Z" } } },
  });

  const fixed = setup(routes(), WITH_CLONE);
  recordAttempt(fixed.ctx, "o/r#7", tried("minesha", "fixsha"));
  assert.deepEqual((await collectGithub(fixed.ctx)).mine![0]!.waits, { on: "me", reasons: ["changes requested"] });
  assert.ok(fixed.http.calls.includes(`${BASE}/repos/o/r/commits/minesha`));
  assert.ok(!fixed.http.calls.includes(`${BASE}/repos/o/r/commits/fixsha`));

  // The same PR where the head commit is my own: my push answered the review.
  const mine = setup(routes(), WITH_CLONE);
  assert.deepEqual((await collectGithub(mine.ctx)).mine![0]!.waits, { on: "others", reasons: ["waiting on a second look"] });
});

test("with no clones named the doctor has no fix checks; with one, the clone, the log tool and Claude are checked", async () => {
  const plain = await github.doctor(setup().ctx);
  assert.deepEqual(plain.map((c) => c.name), ["host", "gh login", "api"]);

  const clone = tempRoot(); // any folder that exists
  const exec = fakeExec({
    "gh auth token": { stdout: "tok-123\n" },
    [`git -C ${clone} rev-parse --git-dir`]: { stdout: ".git\n" },
    [`git -C ${clone} remote get-url origin`]: { stdout: `git@${HOST}:o/r.git\n` },
    "teamcity auth status": {},
    "claude auth status": { stdout: '{"loggedIn":true}' },
  });
  const ctx = contextWith({ github: { host: HOST, fix: { clones: { "o/r": clone } } } }, { http: fakeHttp(githubRoutes()), exec });
  const checks = await github.doctor(ctx);
  assert.deepEqual(checks.map((c) => [c.name, c.ok]), [["host", true], ["gh login", true], ["api", true], ["fix clone o/r", true], ["teamcity", true], ["claude", true]]);
  assert.equal(checks[3]!.detail, clone);
});

test("the doctor says how to fix a clone that is missing or not this repository, and a log tool that is signed out", async () => {
  const clone = tempRoot();
  const exec = fakeExec({
    "gh auth token": { stdout: "tok-123\n" },
    [`git -C ${clone} rev-parse --git-dir`]: { stdout: ".git\n" },
    [`git -C ${clone} remote get-url origin`]: { stdout: `git@${HOST}:o/other.git\n` },
    "teamcity auth status": { code: 1 },
    "claude auth status": { stdout: '{"loggedIn":true}' },
  });
  const local = { github: { host: HOST, fix: { clones: { "o/r": clone, "o/gone": "/no/such/folder" } } } };
  const checks = await github.doctor(contextWith(local, { http: fakeHttp(githubRoutes()), exec }));
  const named = (name: string) => checks.find((c) => c.name === name)!;
  assert.deepEqual([named("fix clone o/r").ok, named("fix clone o/gone").ok, named("teamcity").ok], [false, false, false]);
  assert.match(named("fix clone o/r").detail, /its origin is not o\/r on git\.example\.com/);
  assert.match(named("fix clone o/gone").detail, /is not a git repository/);
  assert.equal(named("fix clone o/gone").fix, "set github.fix.clones in config/local.yaml to the path of your clone of o/gone");
  assert.equal(named("teamcity").fix, "teamcity auth login");
});
