import assert from "node:assert/strict";
import { test } from "node:test";
import type { PullDetail } from "../client.ts";
import { failingChecks, whatToFix, whyNot } from "./checks.ts";

const pull = (over: Partial<PullDetail> = {}): PullDetail => ({
  additions: 1,
  deletions: 1,
  changed_files: 1,
  state: "open",
  draft: false,
  user: { login: "Me" },
  head: { sha: "h", ref: "me/ABC-101-writer", repo: { full_name: "acme/monolith" } },
  base: { ref: "main", repo: { full_name: "acme/monolith" } },
  mergeable: true,
  ...over,
});

test("failing statuses and failing check runs are listed, statuses first", () => {
  const combined = {
    state: "failure",
    total_count: 3,
    statuses: [
      { state: "failure", context: "Style check", target_url: "https://ci.example.com/teamcity/buildConfiguration/Acme_Style/4090522" },
      { state: "success", context: "Unit tests", target_url: "https://ci.example.com/teamcity/buildConfiguration/Acme_Unit/4090523" },
      { state: "error", context: "Docker tests", target_url: null },
      { state: "pending", context: "Deploy preview" },
    ],
  };
  const runs = [
    { status: "completed", conclusion: "failure", name: "lint", details_url: "https://git.example.com/acme/monolith/runs/9" },
    { status: "completed", conclusion: "success", name: "build" },
    { status: "completed", conclusion: "timed_out" },
  ];
  assert.deepEqual(failingChecks(runs, combined), [
    { name: "Style check", url: "https://ci.example.com/teamcity/buildConfiguration/Acme_Style/4090522" },
    { name: "Docker tests" },
    { name: "lint", url: "https://git.example.com/acme/monolith/runs/9" },
    { name: "a check" },
  ]);
  assert.deepEqual(failingChecks([], { state: "success", total_count: 0 }), []);
});

test("conflicts come before failing CI", () => {
  assert.equal(whatToFix(pull({ mergeable: false }), "fail"), "conflicts");
  assert.equal(whatToFix(pull({ mergeable: false }), "pass"), "conflicts");
  assert.equal(whatToFix(pull(), "fail"), "ci");
  assert.equal(whatToFix(pull({ mergeable: null }), "fail"), "ci");
  assert.equal(whatToFix(pull(), "pending"), "running");
  assert.equal(whatToFix(pull(), "pass"), "nothing");
  assert.equal(whatToFix(pull(), "none"), "nothing");
});

test("a PR that is closed, a draft, someone else's or from a fork may not be fixed", () => {
  const why = (over: Partial<PullDetail>) => whyNot(pull(over), "me", "acme/monolith");
  assert.equal(why({}), undefined); // mine, whatever the case of the login
  assert.equal(why({ state: "closed" }), "the PR is not open");
  assert.equal(why({ draft: true }), "the PR is a draft");
  assert.equal(why({ user: { login: "ann" } }), "the PR is not yours");
  assert.equal(why({ head: { sha: "h", ref: "x", repo: { full_name: "ann/monolith" } } }), "the PR comes from a fork");
  assert.equal(why({ head: { sha: "h", ref: "x", repo: null } }), "the PR comes from a fork"); // the fork was deleted
  assert.equal(why({ head: { sha: "h", repo: { full_name: "acme/monolith" } } }), "GitHub did not say which branches the PR is on");
  assert.equal(why({ base: undefined }), "GitHub did not say which branches the PR is on");
});
