import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, HOST } from "../../../test/fixtures/github/api.ts";
import { contextWith, fakeExec, fakeHttp } from "../../../test/helpers.ts";
import { createGithub } from "./client.ts";

function setup(routes: Parameters<typeof fakeHttp>[0]) {
  const http = fakeHttp(routes);
  const exec = fakeExec({ "gh auth token": { stdout: "tok-123\n" } });
  return { gh: createGithub(contextWith({ github: { host: HOST } }, { http, exec })), http };
}

test("a PR's files come with their patches, across pages", async () => {
  const second = `${BASE}/repos/o/r/pulls/1/files?per_page=100&page=2`;
  const { gh } = setup({
    [`${BASE}/repos/o/r/pulls/1/files?per_page=100`]: { $data: [{ filename: "a.ts", patch: "@@ -1 +1 @@\n+a" }], $headers: { link: `<${second}>; rel="next"` } },
    [second]: [{ filename: "logo.png" }],
  });
  assert.deepEqual(await gh.patches("o/r", 1), [{ filename: "a.ts", patch: "@@ -1 +1 @@\n+a" }, { filename: "logo.png" }]);
});

test("posting a review is one POST to that PR's reviews, carrying the review as JSON", async () => {
  const { gh, http } = setup({ [`${BASE}/repos/o/r/pulls/1/reviews`]: { html_url: "https://git.example.com/o/r/pull/1#pullrequestreview-9" } });
  const review = {
    commit_id: "aaa111",
    event: "COMMENT",
    body: "lgtm",
    comments: [{ path: "a.ts", line: 3, side: "RIGHT" as const, body: "Rename `x`." }],
  };
  const posted = await gh.review("o/r", 1, review);

  assert.equal(posted.html_url, "https://git.example.com/o/r/pull/1#pullrequestreview-9");
  const sent = http.sent.filter((request) => request.method !== "GET");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, `${BASE}/repos/o/r/pulls/1/reviews`);
  assert.equal(sent[0]!.method, "POST");
  assert.deepEqual(JSON.parse(sent[0]!.body ?? ""), review);
  assert.equal(sent[0]!.headers?.authorization, "Bearer tok-123");
  assert.equal(sent[0]!.headers?.["content-type"], "application/json");
});

test("nothing but posting a review sends anything other than a GET", async () => {
  const { gh, http } = setup({ [`${BASE}/user`]: { login: "me" }, [`${BASE}/repos/o/r/pulls/1`]: { head: { sha: "aaa111" } } });
  await gh.login();
  await gh.pull("o/r", 1);
  assert.deepEqual(
    http.sent.map((request) => request.method),
    ["GET", "GET"],
  );
});
