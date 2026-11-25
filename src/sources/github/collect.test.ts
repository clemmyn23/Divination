import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, HOST, PR1, PR2, githubRoutes } from "../../../test/fixtures/github/api.ts";
import { contextWith, fakeExec, fakeHttp } from "../../../test/helpers.ts";
import { ciState, collectGithub } from "./collect.ts";
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
  assert.deepEqual(github.validate({ login: "me", prs: [{ key: "o/r#1" }] }), ["prs[0] needs headSha", "prs[0] needs rank.bucket"]);
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
  assert.match(noHost[0]!.fix!, /config\/local\.json/);

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
  const crew = await collectGithub(setup(githubRoutes(), { github: { host: HOST, crewMembers: ["zed", "ANN"] } }).ctx);
  assert.deepEqual(crew.prs.map((p) => [p.author, p.byCrew]), [["ann", true], ["ann", true]]);

  const others = await collectGithub(setup(githubRoutes(), { github: { host: HOST, crewMembers: ["zed"] } }).ctx);
  assert.ok(others.prs.every((p) => !("byCrew" in p)));
});
