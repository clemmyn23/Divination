import assert from "node:assert/strict";
import { test } from "node:test";
import { type Voice, lastWord, reviewState, unanswered, waitsOn } from "./mine.ts";

const at = (minute: number) => Date.parse("2026-11-24T00:00:00Z") + minute * 60_000;
const review = (login: string, state: string, minute: number) => ({ login, state, at: at(minute) });
const voice = (login: string, minute: number, bot = false): Voice => ({ login, bot, at: at(minute) });

test("with no verdicts a PR has no review state", () => {
  assert.deepEqual(reviewState([], "me"), { state: "none", at: 0 });
  assert.deepEqual(reviewState([review("ann", "COMMENTED", 1)], "me"), { state: "none", at: 0 });
});

test("an approval stands, and a later comment from the same person does not take it back", () => {
  const reviews = [review("ann", "APPROVED", 1), review("ann", "COMMENTED", 2)];
  assert.deepEqual(reviewState(reviews, "me"), { state: "approved", at: at(1) });
});

test("one request for changes outweighs any approval", () => {
  const reviews = [review("ann", "APPROVED", 1), review("bob", "CHANGES_REQUESTED", 2), review("cat", "APPROVED", 3)];
  assert.deepEqual(reviewState(reviews, "me"), { state: "changes_requested", at: at(2) });
});

test("each person's latest verdict is the one that counts, whatever order they arrive in", () => {
  const cameRound = [review("bob", "APPROVED", 5), review("bob", "CHANGES_REQUESTED", 2)];
  assert.deepEqual(reviewState(cameRound, "me"), { state: "approved", at: at(5) });
  const dismissed = [review("bob", "CHANGES_REQUESTED", 2), review("bob", "DISMISSED", 3)];
  assert.deepEqual(reviewState(dismissed, "me"), { state: "none", at: 0 });
});

test("my own reviews are not a verdict on my PR", () => {
  assert.deepEqual(reviewState([review("Me", "APPROVED", 1)], "me"), { state: "none", at: 0 });
});

test("my last word is my latest comment or my latest push, whichever is later", () => {
  assert.equal(lastWord([voice("me", 3), voice("ann", 9)], "me", at(1)), at(3));
  assert.equal(lastWord([voice("me", 3)], "me", at(7)), at(7));
  assert.equal(lastWord([], "me", at(7)), at(7));
});

test("what others say after my last word is waiting on an answer", () => {
  const said = [voice("ann", 1), voice("me", 2), voice("ann", 3), voice("bob", 4)];
  assert.equal(unanswered(said, "me", at(0), []), 2);
});

test("a push answers what was said before it", () => {
  assert.equal(unanswered([voice("ann", 1), voice("bob", 4)], "me", at(2), []), 1);
});

test("bots and the people I have chosen to ignore are not waiting on an answer", () => {
  const said = [voice("ci-bot", 1, true), voice("Review-Agent", 2), voice("ann", 3)];
  assert.equal(unanswered(said, "me", at(0), ["review-agent"]), 1);
});

const base = { draft: false, ci: "pass" as const, review: "none" as const, reviewAnswered: false, conflicts: false, blocked: false, unanswered: 0 };

test("a PR nobody has reviewed waits on others", () => {
  assert.deepEqual(waitsOn(base), { on: "others", reasons: ["waiting on review"] });
  assert.deepEqual(waitsOn({ ...base, ci: "pending" }), { on: "others", reasons: ["CI running", "waiting on review"] });
});

test("failing CI, conflicts and unanswered comments are mine to fix, but do not call for me", () => {
  assert.deepEqual(waitsOn({ ...base, ci: "fail" }), { on: "fix", reasons: ["CI failing"] });
  assert.deepEqual(waitsOn({ ...base, conflicts: true }), { on: "fix", reasons: ["merge conflicts"] });
  assert.deepEqual(waitsOn({ ...base, unanswered: 1 }), { on: "fix", reasons: ["1 comment to answer"] });
  assert.deepEqual(waitsOn({ ...base, ci: "fail", conflicts: true, unanswered: 3 }), {
    on: "fix",
    reasons: ["CI failing", "merge conflicts", "3 comments to answer"],
  });
});

test("requested changes call for me until I push or reply, then wait on the reviewer", () => {
  assert.deepEqual(waitsOn({ ...base, review: "changes_requested" }), { on: "me", reasons: ["changes requested"] });
  // What else is wrong with it follows the reason it calls for me.
  assert.deepEqual(waitsOn({ ...base, review: "changes_requested", ci: "fail" }), { on: "me", reasons: ["changes requested", "CI failing"] });
  assert.deepEqual(waitsOn({ ...base, review: "changes_requested", reviewAnswered: true }), {
    on: "others",
    reasons: ["waiting on a second look"],
  });
});

test("an approved PR calls for me once CI is green and nothing blocks it: it is ready to merge", () => {
  assert.deepEqual(waitsOn({ ...base, review: "approved" }), { on: "me", reasons: ["ready to merge"] });
  // A repository with no CI has nothing that could fail.
  assert.deepEqual(waitsOn({ ...base, review: "approved", ci: "none" }), { on: "me", reasons: ["ready to merge"] });
  assert.deepEqual(waitsOn({ ...base, review: "approved", unanswered: 1 }), { on: "me", reasons: ["ready to merge", "1 comment to answer"] });
  assert.deepEqual(waitsOn({ ...base, review: "approved", ci: "fail" }), { on: "fix", reasons: ["CI failing"] });
  assert.deepEqual(waitsOn({ ...base, review: "approved", ci: "pending" }), { on: "others", reasons: ["CI running"] });
  assert.deepEqual(waitsOn({ ...base, review: "approved", blocked: true }), {
    on: "others",
    reasons: ["waiting on another approval or check"],
  });
  assert.deepEqual(waitsOn({ ...base, review: "approved", conflicts: true }), { on: "fix", reasons: ["merge conflicts"] });
});

test("a draft waits on nobody, whatever state it is in", () => {
  assert.deepEqual(waitsOn({ ...base, draft: true, ci: "fail", unanswered: 2 }), { on: "draft", reasons: [] });
});
