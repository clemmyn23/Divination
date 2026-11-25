import assert from "node:assert/strict";
import { test } from "node:test";
import { NOW, view } from "../../../test/helpers.ts";
import { github } from "./index.ts";
import { githubPanels } from "./panel.ts";
import type { Bucket, GithubData, PullRequest } from "./types.ts";

function pr(number: number, bucket: Bucket, over: Partial<PullRequest> = {}): PullRequest {
  return {
    key: `o/r#${number}`,
    repo: "o/r",
    number,
    title: `Change ${number}`,
    url: `https://git.example.com/o/r/pull/${number}`,
    author: "ann",
    headSha: number === 1 ? "aaa111" : `sha${number}`,
    createdAt: NOW - 86_400_000,
    updatedAt: NOW,
    draft: false,
    additions: 1200,
    deletions: 34,
    changedFiles: 3,
    paths: ["src/app.ts"],
    ci: "pass",
    request: "rotation",
    reviewedByMeAtHead: false,
    rank: { score: 3, bucket, reasons: ["touches billing", "rotation", "CI passing"] },
    ...over,
  };
}

const DATA: GithubData = {
  login: "me",
  prs: [
    pr(1, "review_now"),
    pr(2, "quick_win", { rank: { score: 1, bucket: "quick_win", reasons: ["quick win", "CI passing"] }, request: "direct" }),
    pr(3, "blocked", { ci: "fail", rank: { score: 0, bucket: "blocked", reasons: ["CI failing"] } }),
    pr(4, "skip", { rank: { score: 0, bucket: "skip", reasons: ["docs only"] }, request: "team" }),
  ],
};

test("panel groups PRs and shows review drafts with copy buttons", () => {
  const review = { verdict: "comment", summary: "Fine.", findings: [{ file: "a.ts", line: "3", severity: "nit", comment: "Rename `x`." }] };
  const v = { ...view, enrich: { "pr-review": { "o/r#1@aaa111": review } } };
  const html = githubPanels(DATA, v)[0]!.html;
  assert.ok(html.indexOf("Needs you") < html.indexOf("Waiting on authors"));
  assert.ok(html.indexOf("Waiting on authors") < html.indexOf("Covered or low priority"));
  assert.equal((html.match(/Copy comment/g) ?? []).length, 1);
  assert.ok(html.includes('data-copy="Rename `x`."'));
  assert.ok(!html.includes('data-enrich="pr-review" data-key="o/r#1@aaa111"')); // drafted already, no button
  assert.ok(githubPanels(DATA, view)[0]!.html.includes('<button data-enrich="pr-review" data-key="o/r#1@aaa111">Draft review</button>'));
});

test("the panel is one blush panel called the review queue", () => {
  const panels = githubPanels(DATA, view);
  assert.deepEqual(panels.map((p) => [p.id, p.title, p.tint, p.size]), [["prs", "Review queue", "blush", undefined]]);
});

test("each PR is a title and one meta line", () => {
  const html = githubPanels(DATA, view)[0]!.html;
  assert.ok(html.includes('<a href="https://git.example.com/o/r/pull/1" target="_blank" rel="noopener noreferrer">Change 1</a>'));
  assert.ok(
    html.includes(
      '<p class="meta">o/r#1 · ann · +1,200 −34 · <span class="ci-pass">CI ✓</span> · <span class="tag">rotation</span> · touches billing</p>',
    ),
    html,
  );
  assert.ok(html.includes('<span class="ci-fail">CI ✗</span>'));
  assert.equal((html.match(/<p class="meta">/g) ?? []).length, 4);
});

test("group headings carry counts, and an empty group is left out", () => {
  const html = githubPanels(DATA, view)[0]!.html;
  assert.ok(html.includes('<h3 class="group">Needs you · 2</h3>'));
  assert.ok(html.includes('<h3 class="group">Waiting on authors · 1</h3>'));
  assert.ok(html.includes('<h3 class="group">Covered or low priority · 1</h3>'));
  const onlyBlocked = githubPanels({ login: "me", prs: [pr(3, "blocked")] }, view)[0]!.html;
  assert.ok(!onlyBlocked.includes("Needs you"));
  assert.ok(!onlyBlocked.includes("Covered"));
});

test("only PRs that need you get the star and a draft button", () => {
  const html = githubPanels(DATA, view)[0]!.html;
  assert.equal((html.match(/class="item pr needs-you"/g) ?? []).length, 2);
  assert.equal((html.match(/data-enrich="pr-review"/g) ?? []).length, 2);
});

test("a drafted review is folded, with its verdict and note count in the summary", () => {
  const review = {
    verdict: "request_changes",
    summary: "Two problems.",
    findings: [
      { file: "a.ts", line: "3", severity: "blocker", comment: "First." },
      { file: "b.ts", line: "9-12", severity: "nit", comment: "Second." },
    ],
  };
  const html = githubPanels(DATA, { ...view, enrich: { "pr-review": { "o/r#1@aaa111": review } } })[0]!.html;
  assert.ok(html.includes('<details class="review">'));
  assert.ok(html.includes("<summary>Draft: request changes · 2 notes</summary>"));
  assert.ok(html.includes('<p class="where">b.ts:9-12 · nit</p>'));
});

test("a review for an older head commit is not shown", () => {
  const stale = { ...view, enrich: { "pr-review": { "o/r#1@old000": { verdict: "comment", summary: "Old.", findings: [] } } } };
  const html = githubPanels(DATA, stale)[0]!.html;
  assert.ok(!html.includes("Old."));
  assert.ok(html.includes('data-key="o/r#1@aaa111"'));
});

test("text from GitHub and from the model is escaped", () => {
  const evil = pr(1, "review_now", { title: "<img src=x onerror=alert(1)>", author: '"><b>', url: "javascript:alert(1)" });
  const review = { verdict: "comment", summary: "<script>1</script>", findings: [{ file: "<f>", line: "1", severity: "nit", comment: '"><script>alert(2)</script>' }] };
  const html = githubPanels({ login: "me", prs: [evil] }, { ...view, enrich: { "pr-review": { "o/r#1@aaa111": review } } })[0]!.html;
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<b>"));
  assert.ok(!html.includes("javascript:"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(html.includes('data-copy="&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;"'));
});

test("an empty queue says so", () => {
  assert.ok(githubPanels({ login: "me", prs: [] }, view)[0]!.html.includes("No reviews waiting"));
});

test("PRs that need you become needs-you items with their reasons", () => {
  const items = github.attention(DATA, view);
  assert.deepEqual(items, [
    { key: "o/r#1", title: "Change 1", reason: "touches billing, rotation, CI passing", url: "https://git.example.com/o/r/pull/1" },
    { key: "o/r#2", title: "Change 2", reason: "quick win, CI passing", url: "https://git.example.com/o/r/pull/2" },
  ]);
  assert.deepEqual(github.panels(DATA, view).map((p) => p.id), ["prs"]);
});
