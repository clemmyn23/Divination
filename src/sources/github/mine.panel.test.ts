import assert from "node:assert/strict";
import { test } from "node:test";
import { NOW, view } from "../../../test/helpers.ts";
import { github } from "./index.ts";
import { myDoneKey, myPrsPanel } from "./mine.panel.ts";
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
const BROKEN = mine(8, { on: "me", reasons: ["CI failing", "merge conflicts", "2 comments to answer"] }, { ci: "fail", conflicts: true, unanswered: 2 });
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

test("they are grouped by who each waits on, with counts, and an empty group is left out", () => {
  const html = myPrsPanel(DATA, view).html;
  assert.ok(html.includes('<h3 class="group">Needs you · 2</h3>'));
  assert.ok(html.includes('<h3 class="group">Waiting on others · 2</h3>'));
  assert.ok(html.includes('<h3 class="group">Drafts · 1</h3>'));
  assert.ok(html.indexOf("Needs you") < html.indexOf("Waiting on others"));
  assert.ok(html.indexOf("Waiting on others") < html.indexOf("Drafts"));
  const onlyDraft = myPrsPanel({ login: "me", prs: [], mine: [DRAFT] }, view).html;
  assert.ok(!onlyDraft.includes("Needs you") && !onlyDraft.includes("Waiting on others"));
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

test("only the ones waiting on me get the star", () => {
  const html = myPrsPanel(DATA, view).html;
  assert.equal((html.match(/class="item pr needs-you"/g) ?? []).length, 2);
  assert.equal((html.match(/class="item pr"/g) ?? []).length, 3);
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
  const quiet = mine(12, { on: "me", reasons: ["CI failing"] }, { updatedAt: NOW - 46 * DAY });
  const html = myPrsPanel({ login: "me", prs: [], mine: [READY, quiet] }, view).html;
  assert.ok(html.includes('<h3 class="group">Needs you · 1</h3>'));
  assert.ok(html.indexOf("My change 12") > html.indexOf('<details class="stale">'));
  assert.ok(html.indexOf("My change 7") < html.indexOf('<details class="stale">'));
});

test("a PR can be ticked off, and comes back when its commit or what it waits on changes", () => {
  assert.equal(myDoneKey(BROKEN), "mine:o/r#8@sha8:CI failing,merge conflicts,2 comments to answer");
  const done = { ...view, done: { [myDoneKey(BROKEN)]: NOW } };
  const html = myPrsPanel(DATA, done).html;
  assert.ok(html.includes('<h3 class="group">Needs you · 1</h3>'));
  assert.ok(html.indexOf("My change 8") > html.indexOf('<details class="stale done">'));
  assert.ok(html.includes(`data-done="${myDoneKey(READY)}" data-state="open"`));
  assert.ok(html.includes(`data-done="${myDoneKey(BROKEN)}" data-state="done"`));

  const another = { ...BROKEN, unanswered: 3, waits: { on: "me" as const, reasons: ["CI failing", "merge conflicts", "3 comments to answer"] } };
  assert.ok(myPrsPanel({ login: "me", prs: [], mine: [another] }, done).html.includes('<h3 class="group">Needs you · 1</h3>'));
});

test("the ones waiting on me are in Needs you, marked as mine", () => {
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
    {
      key: "mine:o/r#8",
      title: "My change 8",
      reason: "your PR, CI failing, merge conflicts, 2 comments to answer",
      parts: [{ tag: "your PR" }, "CI failing, merge conflicts, 2 comments to answer"],
      url: "https://git.example.com/o/r/pull/8",
      at: NOW - DAY,
      doneKey: myDoneKey(BROKEN),
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
