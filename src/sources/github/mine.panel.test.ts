import assert from "node:assert/strict";
import { test } from "node:test";
import { NOW, view } from "../../../test/helpers.ts";
import { github } from "./index.ts";
import { myDoneKey, myPrsPanel, openFixable } from "./mine.panel.ts";
import { githubPanels } from "./panel.ts";
import type { GithubData, MyPull, Waits } from "./types.ts";

const DAY = 86_400_000;

function mine(number: number, waits: Waits, over: Partial<MyPull> = {}): MyPull {
  return {
    key: `o/r#${number}`,
    repo: "o/r",
    number,
    title: `My change ${number}`,
    url: `https://git.example.com/o/r/pull/${number}`,
    headSha: `sha${number}`,
    createdAt: NOW - 3 * DAY,
    updatedAt: NOW - DAY,
    draft: waits.on === "draft",
    additions: 1200,
    deletions: 34,
    ci: "pass",
    review: "none",
    conflicts: false,
    unanswered: 0,
    waits,
    ...over,
  };
}

const READY = mine(7, { on: "me", reasons: ["ready to merge"] }, { review: "approved" });
const ASKED = mine(13, { on: "me", reasons: ["changes requested", "CI failing"] }, { review: "changes_requested", ci: "fail" });
const BROKEN = mine(8, { on: "fix", reasons: ["CI failing", "merge conflicts", "2 comments to answer"] }, { ci: "fail", conflicts: true, unanswered: 2 });
const WAITING = mine(9, { on: "others", reasons: ["CI running", "waiting on review"] }, { ci: "pending" });
const SECOND_LOOK = mine(10, { on: "others", reasons: ["waiting on a second look"] }, { review: "changes_requested" });
const DRAFT = mine(11, { on: "draft", reasons: [] }, { ci: "fail" });

const DATA: GithubData = { login: "me", prs: [], mine: [READY, BROKEN, WAITING, SECOND_LOOK, DRAFT] };

test("my PRs are a sky panel that shares a column with the review queue, below it", () => {
  const panels = githubPanels(DATA, view);
  // Two short panels in a row fill one column, the first on top.
  assert.deepEqual(panels.map((p) => [p.id, p.title, p.tint, p.size]), [
    ["prs", "Review queue", "blush", "short"],
    ["my-prs", "My PRs", "sky", "short"],
  ]);
  assert.equal(panels[1]!.html, myPrsPanel(DATA, view).html);
});

test("they are grouped by what each waits on, with counts, and an empty group is left out", () => {
  const html = myPrsPanel(DATA, view).html;
  assert.deepEqual(html.match(/<h3 class="group">.*<\/h3>/g), [
    '<h3 class="group">Needs you · 1</h3>',
    '<h3 class="group">To fix · 1</h3>',
    '<h3 class="group">Waiting on others · 2</h3>',
    '<h3 class="group">Drafts · 1</h3>',
  ]);
  const onlyDraft = myPrsPanel({ login: "me", prs: [], mine: [DRAFT] }, view).html;
  assert.deepEqual(onlyDraft.match(/<h3 class="group">.*<\/h3>/g), ['<h3 class="group">Drafts · 1</h3>']);
});

test("each group is a section I can fold shut: open to start, named after what it waits on, its heading the handle", () => {
  const html = myPrsPanel(DATA, view).html;
  assert.deepEqual(html.match(/<details class="fold" data-fold="[a-z]+" open>\n<summary><h3 class="group">.*<\/h3><\/summary>/g), [
    '<details class="fold" data-fold="me" open>\n<summary><h3 class="group">Needs you · 1</h3></summary>',
    '<details class="fold" data-fold="fix" open>\n<summary><h3 class="group">To fix · 1</h3></summary>',
    '<details class="fold" data-fold="others" open>\n<summary><h3 class="group">Waiting on others · 2</h3></summary>',
    '<details class="fold" data-fold="draft" open>\n<summary><h3 class="group">Drafts · 1</h3></summary>',
  ]);
  // Each section holds its own PRs and nothing else.
  const toFix = html.slice(html.indexOf('data-fold="fix"'), html.indexOf('data-fold="others"'));
  assert.ok(toFix.includes("My change 8") && toFix.trimEnd().endsWith("</ul>\n</details>\n<details class=\"fold\""));
  assert.ok(!toFix.includes("My change 7") && !toFix.includes("My change 9"));
});

test("each PR is a title and one meta line: where, size, CI, the review's verdict, and why", () => {
  const html = myPrsPanel(DATA, view).html;
  assert.ok(html.includes('<a href="https://git.example.com/o/r/pull/7" target="_blank" rel="noopener noreferrer">My change 7</a>'));
  const metas = html.match(/<p class="meta">.*<\/p>/g);
  assert.deepEqual(metas, [
    '<p class="meta">o/r#7 · +1,200 −34 · <span class="ci-pass">CI ✓</span> · <span class="tag">approved</span> · ready to merge</p>',
    // The CI mark already says it is failing, so the words do not say it again.
    '<p class="meta">o/r#8 · +1,200 −34 · <span class="ci-fail">CI ✗</span> · merge conflicts, 2 comments to answer</p>',
    '<p class="meta">o/r#9 · +1,200 −34 · <span class="ci-pending">CI …</span> · waiting on review</p>',
    '<p class="meta">o/r#10 · +1,200 −34 · <span class="ci-pass">CI ✓</span> · <span class="tag">changes requested</span> · waiting on a second look</p>',
    '<p class="meta">o/r#11 · +1,200 −34 · <span class="ci-fail">CI ✗</span></p>',
  ]);
});

test("only a PR that calls for me gets the star", () => {
  const html = myPrsPanel(DATA, view).html;
  assert.equal((html.match(/class="item pr needs-you"/g) ?? []).length, 1);
  assert.equal((html.match(/class="item pr"/g) ?? []).length, 4);
  assert.ok(html.indexOf("My change 7") > html.indexOf('class="item pr needs-you"'));
  assert.ok(html.indexOf("My change 7") < html.indexOf('class="item pr"'));
});

test("with none open, and in data collected before my PRs were, the panel says so", () => {
  assert.equal(myPrsPanel({ login: "me", prs: [], mine: [] }, view).html, '<p class="quiet">No open PRs of yours.</p>');
  assert.equal(myPrsPanel({ login: "me", prs: [] }, view).html, '<p class="quiet">No open PRs of yours.</p>');
});

test("text from GitHub is escaped", () => {
  const evil = mine(7, { on: "me", reasons: ["<b>why</b>"] }, { title: "<img src=x onerror=alert(1)>", key: '"><i>', url: "javascript:alert(1)" });
  const html = myPrsPanel({ login: "me", prs: [], mine: [evil] }, view).html;
  assert.ok(!html.includes("<img") && !html.includes("<b>") && !html.includes("<i>") && !html.includes("javascript:"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
});

test("a PR with nothing new for longer than the limit folds into the accordion", () => {
  const quiet = mine(12, { on: "fix", reasons: ["CI failing"] }, { updatedAt: NOW - 46 * DAY });
  const html = myPrsPanel({ login: "me", prs: [], mine: [READY, quiet] }, view).html;
  assert.ok(html.includes('<h3 class="group">Needs you · 1</h3>') && !html.includes("To fix"));
  assert.ok(html.indexOf("My change 12") > html.indexOf('<details class="stale">'));
  assert.ok(html.indexOf("My change 7") < html.indexOf('<details class="stale">'));
});

test("a PR can be ticked off, and comes back when its commit or what it waits on changes", () => {
  assert.equal(myDoneKey(BROKEN), "mine:o/r#8@sha8:CI failing,merge conflicts,2 comments to answer");
  const done = { ...view, done: { [myDoneKey(BROKEN)]: NOW } };
  const html = myPrsPanel(DATA, done).html;
  assert.ok(!html.includes("To fix"));
  assert.ok(html.indexOf("My change 8") > html.indexOf('<details class="stale done">'));
  assert.ok(html.includes(`data-done="${myDoneKey(READY)}" data-state="open"`));
  assert.ok(html.includes(`data-done="${myDoneKey(BROKEN)}" data-state="done"`));

  const another = { ...BROKEN, unanswered: 3, waits: { on: "fix" as const, reasons: ["CI failing", "merge conflicts", "3 comments to answer"] } };
  assert.ok(myPrsPanel({ login: "me", prs: [], mine: [another] }, done).html.includes('<h3 class="group">To fix · 1</h3>'));
});

test("a PR of mine is in Needs you only when it is ready to merge or changes were requested, marked as mine", () => {
  assert.deepEqual(github.attention(DATA, view), [
    {
      key: "mine:o/r#7",
      title: "My change 7",
      reason: "your PR, ready to merge",
      parts: [{ tag: "your PR" }, "ready to merge"],
      url: "https://git.example.com/o/r/pull/7",
      at: NOW - DAY,
      doneKey: myDoneKey(READY),
    },
  ]);
  assert.deepEqual(github.attention({ login: "me", prs: [], mine: [ASKED, BROKEN, WAITING, DRAFT] }, view), [
    {
      key: "mine:o/r#13",
      title: "My change 13",
      reason: "your PR, changes requested, CI failing",
      parts: [{ tag: "your PR" }, "changes requested, CI failing"],
      url: "https://git.example.com/o/r/pull/13",
      at: NOW - DAY,
      doneKey: myDoneKey(ASKED),
    },
  ]);
  assert.deepEqual(github.attention({ login: "me", prs: [] }, view), []);
});

test("validate refuses PRs of mine in the wrong shape and accepts data without any", () => {
  assert.deepEqual(github.validate(DATA), []);
  assert.deepEqual(github.validate({ login: "me", prs: [] }), []);
  assert.deepEqual(github.validate({ login: "me", prs: [], mine: {} }), ["mine must be a list"]);
  const problems = github.validate({ login: "me", prs: [], mine: [{ key: "o/r#7", ci: "green", waits: { on: "nobody" } }] });
  assert.ok(problems.includes("mine[0] needs headSha") && problems.includes("mine[0].additions must be a number"));
  assert.ok(problems.includes("mine[0].ci must be one of pass, fail, pending, none"));
  assert.ok(problems.includes("mine[0] needs waits.on") && problems.includes("mine[0] needs waits.reasons"));
  assert.ok(!problems.includes("mine[0] needs key"));
});

test("validate checks a PR's fix state, and accepts a PR collected before there was one", () => {
  const withFix = (fix: unknown) => github.validate({ login: "me", prs: [], mine: [{ ...READY, fix }] });
  assert.deepEqual(withFix({ can: true, spent: false }), []);
  assert.deepEqual(withFix({ can: false, spent: true, last: { at: 5, outcome: "pushed", text: "Moved the helper." } }), []);
  assert.deepEqual(withFix({ can: "yes" }), ["mine[0].fix must say can and spent as true or false"]);
  assert.deepEqual(withFix("on"), ["mine[0].fix must say can and spent as true or false"]);
  assert.deepEqual(withFix({ can: true, spent: false, last: { at: "now", outcome: "pushed", text: 7 } }), ["mine[0].fix.last needs at, outcome and text"]);
  assert.deepEqual(github.validate({ login: "me", prs: [], mine: [READY] }), []);
});

// ---- The Fix button ----

const CAN = { can: true, spent: false };
const fixable = (number: number, over: Partial<MyPull> = {}) => mine(number, { on: "fix", reasons: ["CI failing"] }, { ci: "fail", fix: CAN, ...over });
const panelOf = (prs: MyPull[], v = view) => myPrsPanel({ login: "me", prs: [], mine: prs }, v).html;

test("a PR that can be fixed has a Fix button, and one that cannot has none", () => {
  const html = panelOf([fixable(8), { ...WAITING, fix: { can: false, spent: false } }, DRAFT, READY]);
  assert.deepEqual(html.match(/<button data-fix="[^"]*"[^>]*>[^<]*<\/button>/g), ['<button data-fix="o/r#8">Fix</button>']);
  // It sits under the meta line, before the tick.
  assert.ok(html.includes('<span class="ci-fail">CI ✗</span></p>\n<button data-fix="o/r#8">Fix</button>'));
});

test("the last attempt is told under the meta line", () => {
  const at = NOW + 42 * 60_000; // 10:42 in Sydney
  const noted = (last: { outcome: "pushed" | "gave-up" | "failed"; text: string }, over: Partial<MyPull> = {}) =>
    panelOf([fixable(8, { fix: { can: true, spent: false, last: { at, ...last } }, ...over })]).match(/<p class="fix-note">.*<\/p>/)?.[0];
  assert.equal(noted({ outcome: "pushed", text: "Moved the helper." }), '<p class="fix-note">Fix pushed 10:42: Moved the helper.</p>');
  assert.equal(noted({ outcome: "gave-up", text: "The test needs a database change." }), '<p class="fix-note">Could not fix: The test needs a database change.</p>');
  assert.equal(noted({ outcome: "failed", text: "the branch moved" }), '<p class="fix-note">Fix failed: the branch moved</p>');
  // The note comes between the meta line and the button.
  const html = panelOf([fixable(8, { fix: { can: true, spent: false, last: { at, outcome: "failed", text: "x" } } })]);
  assert.ok(html.includes('</p>\n<p class="fix-note">Fix failed: x</p>\n<button data-fix="o/r#8">Fix</button>'));
});

test("a pushed fix whose CI is still running says it is waiting on CI, and needs no button", () => {
  const running = mine(9, { on: "others", reasons: ["CI running", "waiting on review"] }, { ci: "pending", fix: { can: false, spent: false, last: { at: NOW + 42 * 60_000, outcome: "pushed", text: "Moved the helper." } } });
  const html = panelOf([running]);
  assert.ok(html.includes('<p class="fix-note">Fix pushed 10:42: Moved the helper. Waiting on CI.</p>'));
  assert.ok(!html.includes("data-fix"));
});

test("an attempt from another day is dated", () => {
  const html = panelOf([fixable(8, { fix: { can: true, spent: false, last: { at: NOW - 2 * DAY, outcome: "pushed", text: "Moved the helper." } } })]);
  assert.ok(html.includes('<p class="fix-note">Fix pushed 23 Nov: Moved the helper.</p>'));
});

test("at the limit the button gives way to words", () => {
  const spent = fixable(8, { fix: { can: false, spent: true, last: { at: NOW, outcome: "gave-up", text: "The test needs a database change." } } });
  const html = panelOf([spent]);
  assert.ok(!html.includes("data-fix"));
  assert.ok(html.includes('<p class="fix-note">Tried twice, over to you. Last: The test needs a database change.</p>'));
  const three = { ...view, config: { ...view.config, github: { ...view.config.github, fix: { ...view.config.github.fix, maxAttempts: 3 } } } };
  assert.ok(panelOf([spent], three).includes("Tried 3 times, over to you."));
});

test("Fix all appears when two or more open PRs can be fixed, and counts them", () => {
  const two = panelOf([fixable(8), fixable(9)]);
  assert.ok(two.includes('<h3 class="group">To fix · 2</h3></summary>\n<button data-fix="all" title="Fixes 2 PRs, one at a time">Fix all</button>\n<ul class="items">'));
  assert.ok(!panelOf([fixable(8), mine(9, { on: "fix", reasons: ["CI failing"] }, { ci: "fail" })]).includes('data-fix="all"'));
  // With nothing in "To fix", it sits under "Needs you".
  const asked = (n: number) => mine(n, { on: "me", reasons: ["changes requested", "CI failing"] }, { ci: "fail", review: "changes_requested", fix: CAN });
  assert.ok(panelOf([asked(8), asked(9)]).includes('<h3 class="group">Needs you · 2</h3></summary>\n<button data-fix="all" title="Fixes 2 PRs, one at a time">Fix all</button>'));
});

test("Fix all leaves out PRs that are old or ticked off, which keep their own button", () => {
  const old = fixable(12, { updatedAt: NOW - 46 * DAY });
  const ticked = fixable(13);
  const needsMe = mine(14, { on: "me", reasons: ["changes requested", "CI failing"] }, { ci: "fail", review: "changes_requested", fix: CAN });
  const prs = [fixable(8), old, ticked, needsMe, { ...WAITING, fix: { can: false, spent: false } }];
  const done = { ...view, done: { [myDoneKey(ticked)]: NOW } };
  // In the panel's order: what needs me first, then what is mine to fix.
  assert.deepEqual(openFixable(prs, done).map((pr) => pr.number), [14, 8]);
  assert.deepEqual(openFixable([], done), []);

  const html = panelOf(prs, done);
  assert.ok(html.includes('title="Fixes 2 PRs, one at a time"'));
  assert.ok(html.indexOf('data-fix="o/r#12"') > html.indexOf('<details class="stale">'));
  assert.ok(html.indexOf('data-fix="o/r#13"') > html.indexOf('<details class="stale done">'));
});

test("text in an attempt is escaped", () => {
  const html = panelOf([fixable(8, { key: '"><i>', fix: { can: true, spent: false, last: { at: NOW, outcome: "failed", text: "<b>x</b>" } } })]);
  assert.ok(html.includes("Fix failed: &lt;b&gt;x&lt;/b&gt;"));
  assert.ok(!html.includes("<b>") && !html.includes("<i>"));
});
