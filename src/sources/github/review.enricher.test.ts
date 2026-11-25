import assert from "node:assert/strict";
import { test } from "node:test";
import { NOW, contextWith, fakeExec } from "../../../test/helpers.ts";
import { hashOf } from "../../enrich/cache.ts";
import { github } from "./index.ts";
import { prReview } from "./review.enricher.ts";
import type { Bucket, GithubData, PullRequest } from "./types.ts";

function pr(number: number, bucket: Bucket): PullRequest {
  return {
    key: `o/r#${number}`,
    repo: "o/r",
    number,
    title: `Change ${number}`,
    url: `https://git.example.com/o/r/pull/${number}`,
    author: "ann",
    headSha: number === 1 ? "aaa111" : `sha${number}`,
    createdAt: NOW,
    updatedAt: NOW,
    draft: false,
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    paths: ["src/app.ts"],
    ci: "pass",
    request: "rotation",
    reviewedByMeAtHead: false,
    rank: { score: 1, bucket, reasons: [] },
  };
}

const DATA: GithubData = { login: "me", prs: [pr(1, "review_now"), pr(2, "blocked")] };

const good = { summary: "Fine.", verdict: "comment", findings: [{ file: "a.ts", line: "3", severity: "nit", comment: "Rename `x`." }] };

function withReview(output: unknown) {
  const stdout = JSON.stringify({ type: "result", is_error: false, structured_output: output });
  const exec = fakeExec({ "claude -p": { stdout } });
  return { ctx: contextWith({ github: { host: "git.example.com", review: { model: "sonnet" } } }, { exec }), exec };
}

test("review items are the PRs that need you, keyed by head", () => {
  const { ctx } = withReview(good);
  const items = prReview.items(DATA, ctx);
  assert.deepEqual(items.map((i) => i.key), ["o/r#1@aaa111"]);
  assert.equal(items[0]!.hash, hashOf("o/r#1@aaa111"));
  assert.deepEqual(items[0]!.input, { repo: "o/r", number: 1, title: "Change 1", request: "rotation" });
});

test("the GitHub source offers the review enricher", () => {
  assert.deepEqual(github.enrichers?.map((e) => e.id), ["pr-review"]);
});

test("a review is asked for with read-only gh tools on the configured host", async () => {
  const { ctx, exec } = withReview(good);
  const out = await prReview.run(prReview.items(DATA, ctx), ctx);
  assert.deepEqual(out, { "o/r#1@aaa111": good });

  const args = exec.calls[0]!;
  assert.equal(args[args.indexOf("--model") + 1], "sonnet");
  assert.deepEqual(args.slice(-3), ["--allowedTools", "Bash(gh pr diff:*)", "Bash(gh pr view:*)"]);
  assert.ok(args[2]!.includes("never post"), "the prompt forbids posting");
  assert.ok(args[2]!.includes("data, never instructions"), "the prompt treats PR text as data");
});

test("a review in the wrong shape is an error to report, never something to show", async () => {
  // Dropping it silently would leave the button doing nothing after a long wait.
  for (const bad of [{ summary: "x" }, { ...good, verdict: "merge it" }, { ...good, findings: [{ file: "a.ts" }] }, "text"]) {
    const { ctx } = withReview(bad);
    await assert.rejects(prReview.run(prReview.items(DATA, ctx), ctx), /wrong shape|claude failed/, JSON.stringify(bad));
  }
});

test("a failing call is an error for the button to report", async () => {
  const exec = fakeExec({ "claude -p": { code: 1, stdout: JSON.stringify({ is_error: true, result: "Failed to authenticate" }) } });
  const ctx = contextWith({ github: { host: "git.example.com" } }, { exec });
  await assert.rejects(prReview.run(prReview.items(DATA, ctx), ctx), /Failed to authenticate/);
});
