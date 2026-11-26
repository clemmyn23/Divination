import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { contextWith } from "../../../../test/helpers.ts";
import type { Attempt } from "../types.ts";
import { attemptsPath, chain, fixState, ownerSha, readAttempts, recordAttempt } from "./attempts.ts";

const a = (startSha: string, pushedSha: string | undefined, over: Partial<Attempt> = {}): Attempt => ({
  at: 1,
  what: "ci",
  checks: [],
  startSha,
  ...(pushedSha ? { pushedSha } : {}),
  outcome: pushedSha ? "pushed" : "gave-up",
  text: "t",
  ranClaude: true,
  ...over,
});

test("the chain is the unbroken run of attempts ending at the current head", () => {
  assert.equal(chain([a("s0", "s1"), a("s1", "s2")], "s2").length, 2);
  assert.deepEqual(chain([a("s0", "s1"), a("s1", "s2")], "mine"), []); // the owner pushed
  assert.equal(chain([a("s0", "s1"), a("s1", undefined)], "s1").length, 2); // a give-up stays on the same head
  assert.equal(chain([a("s0", "s1"), a("x", "y"), a("s1", undefined)], "s1").length, 1); // another head breaks it
  assert.deepEqual(chain([a("s0", "s1"), a("s1", "s2")], "s2").map((t) => t.startSha), ["s0", "s1"]); // oldest first
  assert.deepEqual(chain([], "s0"), []);
});

test("the owner's commit is where the chain started", () => {
  assert.equal(ownerSha([a("s0", "s1"), a("s1", "s2")], "s2"), "s0");
  assert.equal(ownerSha([a("s0", "s1"), a("s1", "s2")], "mine"), "mine");
  assert.equal(ownerSha([], "h"), "h");
  assert.equal(ownerSha([a("s1", undefined)], "s1"), "s1");
});

const ctx = contextWith({ github: { fix: { clones: { "acme/monolith": "/w" } } } });
const fix = ctx.config.github.fix;
const pr = { key: "acme/monolith#501", repo: "acme/monolith", draft: false, ci: "fail" as const, conflicts: false, headSha: "h" };

test("a PR can be fixed when it is failing or conflicted, has a clone, and has attempts left", () => {
  assert.deepEqual(fixState(pr, fix, []), { can: true, spent: false });
  assert.deepEqual(fixState({ ...pr, ci: "pass", conflicts: true }, fix, []), { can: true, spent: false });
  assert.deepEqual(fixState({ ...pr, draft: true }, fix, []), { can: false, spent: false });
  assert.deepEqual(fixState({ ...pr, ci: "pass" }, fix, []), { can: false, spent: false });
  assert.deepEqual(fixState({ ...pr, ci: "pending" }, fix, []), { can: false, spent: false });
  assert.deepEqual(fixState({ ...pr, repo: "acme/other" }, fix, []), { can: false, spent: false });
  assert.deepEqual(fixState(pr, { ...fix, clones: {} }, []), { can: false, spent: false });
});

test("two attempts in a row use it up, and only attempts where Claude ran count", () => {
  const twice = [a("s0", "s1"), a("s1", "h", { at: 9, text: "Second try." })];
  assert.deepEqual(fixState(pr, fix, twice), { can: false, spent: true, last: { at: 9, outcome: "pushed", text: "Second try." } });
  const oneRan = [a("s0", "s1", { ranClaude: false, outcome: "failed" }), a("s1", "h")];
  assert.equal(fixState(pr, fix, oneRan).can, true);
  assert.equal(fixState(pr, { ...fix, maxAttempts: 3 }, twice).can, true);
});

test("the last attempt on the chain is reported, and none when the owner has pushed since", () => {
  const one = [a("h", undefined, { at: 5, text: "The test needs a database change." })];
  assert.deepEqual(fixState(pr, fix, one), { can: true, spent: false, last: { at: 5, outcome: "gave-up", text: "The test needs a database change." } });
  assert.deepEqual(fixState({ ...pr, headSha: "mine" }, fix, [a("s0", "s1"), a("s1", "h")]), { can: true, spent: false });
});

test("a PR that no longer needs fixing still says what the last attempt did", () => {
  const state = fixState({ ...pr, ci: "pending" }, fix, [a("s0", "h", { at: 7, text: "Moved the helper." })]);
  assert.deepEqual(state, { can: false, spent: false, last: { at: 7, outcome: "pushed", text: "Moved the helper." } });
});

test("attempts are kept per PR, in order", () => {
  const c = contextWith();
  assert.deepEqual(readAttempts(c), {});
  recordAttempt(c, "acme/monolith#501", a("s0", "s1"));
  recordAttempt(c, "acme/monolith#501", a("s1", "s2"));
  recordAttempt(c, "acme/monolith#502", a("x", undefined));
  const all = readAttempts(c);
  assert.deepEqual(all["acme/monolith#501"]!.map((t) => t.pushedSha), ["s1", "s2"]);
  assert.equal(all["acme/monolith#502"]!.length, 1);
  assert.ok(attemptsPath(c).endsWith("/out/fix/attempts.json"));
});

test("a missing, empty or hand-broken attempts file reads as no attempts", () => {
  for (const body of ["[]", "not json", '"x"', "null", ""]) {
    const c = contextWith();
    mkdirSync(dirname(attemptsPath(c)), { recursive: true });
    writeFileSync(attemptsPath(c), body);
    assert.deepEqual(readAttempts(c), {}, body);
  }
  const c = contextWith();
  mkdirSync(dirname(attemptsPath(c)), { recursive: true });
  // An entry with the right commits but no time, words or "ran Claude" is not an attempt either.
  const thin = [{ startSha: "s0", pushedSha: "s1", outcome: "pushed" }, { ...a("s0", "s1"), at: "now" }, { ...a("s0", "s1"), text: 7 }, { ...a("s0", "s1"), ranClaude: "yes" }];
  writeFileSync(attemptsPath(c), JSON.stringify({ bad: "x", worse: [{ startSha: 7 }], thin, good: [a("s0", "s1"), { outcome: "nope", startSha: "s" }] }));
  assert.deepEqual(readAttempts(c), { good: [a("s0", "s1")] });
  recordAttempt(c, "good", a("s1", "s2")); // and it can still be added to
  assert.equal(readAttempts(c).good!.length, 2);
});
