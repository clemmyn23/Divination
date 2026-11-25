import assert from "node:assert/strict";
import { test } from "node:test";
import { NOW, view } from "../../../test/helpers.ts";
import { rankPull, sortPulls } from "./rank.ts";
import type { Bucket, PullRequest } from "./types.ts";

const RULES = view.config.github.rank;
const DAY = 86_400_000;

/** 200 changed lines, CI passing, one ordinary source file, written by ann a day ago. */
const BASE: Omit<PullRequest, "rank"> = {
  key: "o/r#1",
  repo: "o/r",
  number: 1,
  title: "A change",
  url: "https://git.example.com/o/r/pull/1",
  author: "ann",
  headSha: "aaa111",
  createdAt: NOW - DAY,
  updatedAt: NOW - DAY,
  draft: false,
  additions: 150,
  deletions: 50,
  changedFiles: 1,
  paths: ["src/app.ts"],
  ci: "pass",
  request: "direct",
  reviewedByMeAtHead: false,
};

test("buckets", () => {
  const b = (over: object) => rankPull({ ...BASE, ...over }, RULES, "me", NOW).bucket;
  assert.equal(b({}), "review_now");
  assert.equal(b({ draft: true }), "excluded");
  assert.equal(b({ author: "me" }), "excluded");
  assert.equal(b({ reviewedByMeAtHead: true }), "excluded");
  assert.equal(b({ signal: { kind: "skip", reason: "eyes from Sam", url: "https://s/1" } }), "skip");
  assert.equal(b({ signal: { kind: "flag", reason: "2 replies", url: "https://s/1" } }), "flagged");
  assert.equal(b({ ci: "fail" }), "blocked");
  assert.equal(b({ paths: ["README.md", "docs/a.md"] }), "skip");
  assert.equal(b({ additions: 30, deletions: 10 }), "quick_win");
  assert.equal(b({ additions: 30, deletions: 10, paths: ["src/billing/charge.ts"] }), "review_now");
});

test("earlier rules win over later ones", () => {
  const b = (over: object) => rankPull({ ...BASE, ...over }, RULES, "me", NOW).bucket;
  assert.equal(b({ draft: true, ci: "fail" }), "excluded");
  assert.equal(b({ ci: "fail", signal: { kind: "skip", reason: "x", url: "https://s/1" } }), "skip");
  assert.equal(b({ ci: "fail", paths: ["README.md"] }), "blocked");
  assert.equal(b({ additions: 80, deletions: 0 }), "quick_win"); // exactly the limit
  assert.equal(b({ additions: 81, deletions: 0 }), "review_now");
  assert.equal(b({ paths: [] }), "review_now"); // no paths is not "docs only"
});

test("score and reasons", () => {
  const r = rankPull(
    {
      ...BASE,
      additions: 700,
      deletions: 200,
      request: "rotation",
      createdAt: NOW - 4 * DAY,
      paths: ["src/billing/a.ts", "src/billing/b.ts", "db/migration_1.sql"],
    },
    RULES,
    "me",
    NOW,
  );
  assert.equal(r.score, 3 + 3 + 2 + 2 + 1 + 1);
  assert.deepEqual(r.reasons, ["touches billing", "touches migrations", "large change", "rotation", "4 days old", "CI passing"]);
});

test("the reason that decided the bucket comes first", () => {
  const first = (over: object) => rankPull({ ...BASE, ...over }, RULES, "me", NOW).reasons[0];
  assert.equal(first({ draft: true }), "draft");
  assert.equal(first({ author: "me" }), "yours");
  assert.equal(first({ reviewedByMeAtHead: true }), "already reviewed");
  assert.equal(first({ signal: { kind: "skip", reason: "already picked up by Sam", url: "https://s/1" } }), "already picked up by Sam");
  assert.equal(first({ ci: "fail" }), "CI failing");
  assert.equal(first({ paths: ["README.md"] }), "docs only");
  assert.equal(first({ additions: 30, deletions: 10 }), "quick win");
});

test("age only counts after three full days, and exactly three days does not", () => {
  const reasons = (age: number) => rankPull({ ...BASE, createdAt: NOW - age }, RULES, "me", NOW).reasons;
  assert.ok(!reasons(3 * DAY).some((r) => r.endsWith("days old")));
  assert.ok(reasons(3 * DAY + 1).includes("3 days old"));
  assert.ok(reasons(40 * DAY).includes("40 days old"));
});

test("a broken pattern in config is ignored instead of crashing the collect", () => {
  const rules = { ...RULES, riskPaths: [{ pattern: "(", label: "broken", weight: 9 }], docsPattern: "(" };
  const r = rankPull(BASE, rules, "me", NOW);
  assert.equal(r.bucket, "review_now");
  assert.ok(!r.reasons.includes("touches broken"));
});

test("sort order", () => {
  const pr = (key: string, bucket: Bucket, score: number, createdAt = NOW): PullRequest => ({
    ...BASE,
    key,
    createdAt,
    rank: { score, bucket, reasons: [] },
  });
  const prs = [pr("a", "skip", 9), pr("b", "review_now", 1), pr("c", "review_now", 5), pr("d", "quick_win", 0)];
  assert.deepEqual(sortPulls(prs).map((p) => p.key), ["c", "b", "d", "a"]);
  // Same bucket and score: the older one first.
  const tie = [pr("new", "review_now", 2, NOW), pr("old", "review_now", 2, NOW - DAY)];
  assert.deepEqual(sortPulls(tie).map((p) => p.key), ["old", "new"]);
  assert.deepEqual(tie.map((p) => p.key), ["new", "old"]); // the input is left alone
});
