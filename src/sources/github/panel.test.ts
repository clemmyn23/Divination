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

test("the first panel is a short blush one called the review queue", () => {
  const [queue] = githubPanels(DATA, view);
  assert.deepEqual([queue!.id, queue!.title, queue!.tint, queue!.size], ["prs", "Review queue", "blush", "short"]);
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

const DAY = 86_400_000;

test("PRs older than the limit fold into one accordion at the end of the panel", () => {
  const old = [
    pr(5, "review_now", { createdAt: NOW - 46 * DAY }),
    pr(6, "blocked", { createdAt: NOW - 100 * DAY, ci: "fail" }),
  ];
  const html = githubPanels({ login: "me", prs: [...DATA.prs, ...old] }, view)[0]!.html;

  assert.ok(html.includes('<details class="stale">'));
  assert.ok(html.includes("<summary>Expand for stale tasks · 2</summary>"));
  // The headings above only count what is shown.
  assert.ok(html.includes('<h3 class="group">Needs you · 2</h3>'));
  assert.ok(html.includes('<h3 class="group">Waiting on authors · 1</h3>'));

  const [shown, folded] = html.split('<details class="stale">');
  assert.ok(!shown!.includes("Change 5") && !shown!.includes("Change 6"));
  assert.ok(folded!.includes("Change 5") && folded!.includes("Change 6"));
  assert.ok(folded!.trimEnd().endsWith("</details>"));
  // A stale PR that needs you can still be drafted from inside the accordion.
  assert.ok(folded!.includes('data-enrich="pr-review" data-key="o/r#5@sha5"'));
});

test("exactly at the limit is not stale, and a limit of 0 never folds", () => {
  const edge = pr(5, "review_now", { createdAt: NOW - 45 * DAY });
  assert.ok(!githubPanels({ login: "me", prs: [edge] }, view)[0]!.html.includes("<details class=\"stale\">"));

  const ancient = pr(6, "review_now", { createdAt: NOW - 900 * DAY });
  const never = { ...view, config: { ...view.config, hideOlderThanDays: 0 } };
  assert.ok(!githubPanels({ login: "me", prs: [ancient] }, never)[0]!.html.includes("<details class=\"stale\">"));
});

test("a queue with only stale PRs shows just the accordion", () => {
  const html = githubPanels({ login: "me", prs: [pr(5, "review_now", { createdAt: NOW - 60 * DAY })] }, view)[0]!.html;
  assert.ok(!html.includes("<h3 class=\"group\">Needs you · 0"));
  assert.ok(!html.includes("No reviews waiting"));
  assert.ok(html.startsWith("<details class=\"stale\">"));
});

test("an empty queue says so", () => {
  assert.ok(githubPanels({ login: "me", prs: [] }, view)[0]!.html.includes("No reviews waiting"));
});

test("PRs that need you become needs-you items with their reasons", () => {
  const items = github.attention(DATA, view);
  assert.deepEqual(items, [
    {
      key: "o/r#1",
      title: "Change 1",
      reason: "touches billing, rotation, CI passing",
      parts: ["ann", { tag: "rotation" }, "touches billing, CI passing"],
      url: "https://git.example.com/o/r/pull/1",
      at: NOW - 86_400_000,
      doneKey: "pr:o/r#1@aaa111",
    },
    {
      key: "o/r#2",
      title: "Change 2",
      reason: "quick win, CI passing",
      parts: ["ann", { tag: "direct" }, "quick win, CI passing"],
      url: "https://git.example.com/o/r/pull/2",
      at: NOW - 86_400_000,
      doneKey: "pr:o/r#2@sha2",
    },
  ]);
  assert.deepEqual(github.panels(DATA, view).map((p) => p.id), ["prs", "my-prs"]);
});

test("a PR raised by a crew member carries a lozenge on its meta line, and says so where it needs me", () => {
  const data: GithubData = { login: "me", prs: [pr(1, "review_now", { byCrew: true }), pr(2, "review_now")] };
  const html = githubPanels(data, view)[0]!.html;
  assert.equal(html.match(/<span class="tag crew">raised by crew member<\/span>/g)!.length, 1);
  const first = html.slice(html.indexOf("Change 1"), html.indexOf("Change 2"));
  assert.ok(first.includes('<span class="tag">rotation</span> · <span class="tag crew">raised by crew member</span>'));

  const reasons = github.attention(data, view).map((a) => a.reason);
  assert.ok(reasons[0]!.endsWith("raised by crew member"));
  assert.ok(!reasons[1]!.includes("crew member"));
});

test("every PR carries a tick; a PR marked done folds away, is not counted, and can be unticked", () => {
  const data: GithubData = { login: "me", prs: [pr(1, "review_now"), pr(2, "review_now"), pr(3, "blocked")] };
  const open = githubPanels(data, view)[0]!.html;
  assert.equal(open.match(/class="tick"/g)!.length, 3);
  assert.ok(open.includes('data-done="pr:o/r#1@aaa111" data-state="open"'));
  assert.ok(!open.includes("Done ·"));

  const v = { ...view, done: { "pr:o/r#1@aaa111": NOW, "pr:o/r#3@sha3": NOW } };
  const html = githubPanels(data, v)[0]!.html;
  assert.ok(html.includes('<h3 class="group">Needs you · 1</h3>'));
  assert.ok(!html.includes("Waiting on authors"));
  const fold = html.slice(html.indexOf('<details class="stale done">'));
  assert.ok(fold.startsWith('<details class="stale done">\n<summary>Done · 2</summary>'));
  assert.ok(fold.includes("Change 1") && fold.includes("Change 3") && !fold.includes("Change 2"));
  assert.ok(fold.includes('data-done="pr:o/r#1@aaa111" data-state="done"'));

  // New commits change the key, so the PR comes back.
  const moved: GithubData = { login: "me", prs: [pr(1, "review_now", { headSha: "bbb222" })] };
  assert.ok(!githubPanels(moved, v)[0]!.html.includes("Done ·"));
});

test("a PR's needs-you item carries the same key, so ticking either clears both", () => {
  const data: GithubData = { login: "me", prs: [pr(1, "review_now")] };
  assert.equal(github.attention(data, view)[0]!.doneKey, "pr:o/r#1@aaa111");
});

test("numbers and CI words that came from a hand-dropped file cannot carry markup into the page", () => {
  const hostile = { ...pr(1, "review_now"), additions: "<img src=x onerror=alert(1)>", deletions: '"><script>x</script>', ci: 'pass"><b>x</b>' } as unknown as PullRequest;
  const html = githubPanels({ login: "me", prs: [hostile] }, view)[0]!.html;
  assert.ok(!html.includes("<img") && !html.includes("<script>") && !html.includes("<b>x</b>"));
  assert.ok(html.includes("+0 −0"));
  assert.ok(html.includes('<span class="ci-none">no CI</span>'));
});

test("a PR's needs-you item names its author, then carries the same lozenges as the queue, then the other reasons", () => {
  const data: GithubData = {
    login: "me",
    prs: [
      pr(1, "review_now", { author: "kit", byCrew: true }),
      pr(2, "quick_win", { rank: { score: 1, bucket: "quick_win", reasons: ["rotation"] } }),
    ],
  };
  const [crew, plain] = github.attention(data, view);
  // The author sits beside the crew lozenge; "rotation" is a lozenge, so it is not said again in words.
  assert.deepEqual(crew!.parts, ["kit", { tag: "raised by crew member", kind: "crew" }, { tag: "rotation" }, "touches billing, CI passing"]);
  assert.equal(crew!.reason, "touches billing, rotation, CI passing, raised by crew member"); // the plain words are unchanged
  assert.deepEqual(plain!.parts, ["ann", { tag: "rotation" }]); // nothing left to say in words
});

test("validate checks every field the panel prints, so a half-shaped file is refused before it is drawn", () => {
  const good: GithubData = { login: "me", prs: [pr(1, "review_now")] };
  assert.deepEqual(github.validate(good), []);
  const broken = (over: object) => github.validate({ login: "me", prs: [{ ...pr(1, "review_now"), ...over }] });
  assert.match(broken({ rank: { bucket: "review_now", score: 1 } }).join(), /rank\.reasons/);
  assert.match(broken({ additions: "many" }).join(), /additions/);
  assert.match(broken({ ci: "exploded" }).join(), /ci/);
  assert.match(broken({ title: 7 }).join(), /title/);
  assert.match(broken({ createdAt: "yesterday" }).join(), /createdAt/);
  assert.match(broken({ rank: { bucket: "nonsense", score: 1, reasons: [] } }).join(), /rank\.bucket/);
});
