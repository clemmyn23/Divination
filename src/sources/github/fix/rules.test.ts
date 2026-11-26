import assert from "node:assert/strict";
import { test } from "node:test";
import { buildIdOf, commitMessage, cutLog, originIs, touched, worktreeName } from "./rules.ts";

test("the build id is the last part of the link when it is a number", () => {
  assert.equal(buildIdOf("https://ci.example.com/teamcity/buildConfiguration/Acme_StyleCheck/4090522"), "4090522");
  assert.equal(buildIdOf("https://ci.example.com/teamcity/buildConfiguration/Acme_StyleCheck/4090522?tab=log"), "4090522");
  assert.equal(buildIdOf("https://ci.example.com/build/latest"), undefined);
  assert.equal(buildIdOf(undefined), undefined);
  assert.equal(buildIdOf("not a url"), undefined);
});

test("a short log is kept whole", () => {
  assert.equal(cutLog("one\ntwo\n"), "one\ntwo\n");
});

test("a long log keeps its failure lines with two either side, and its last 200 lines, in order", () => {
  const lines = Array.from({ length: 5000 }, (_, i) => `line ${i} ${"x".repeat(40)}`);
  lines[1000] = "src/Writer.cs(223,28): [SA1201] error: a method should not follow a struct";
  const cut = cutLog(lines.join("\n"));
  for (const kept of ["line 998 ", "line 999 ", "SA1201", "line 1001 ", "line 1002 ", "line 4999 ", "line 4800 "]) assert.ok(cut.includes(kept), kept);
  assert.ok(!cut.includes("line 997 ") && !cut.includes("line 1003 ") && !cut.includes("line 4799 "));
  assert.ok(cut.indexOf("SA1201") < cut.indexOf("line 4800 "));
  assert.ok(cut.includes("…")); // a gap is marked
});

test("the cut never exceeds its limit or splits a character", () => {
  const cut = cutLog("错误 error é\n".repeat(20_000), 1000);
  assert.ok(Buffer.byteLength(cut) <= 1000);
  assert.ok(!cut.includes("�"));
});

test("the commit message names the ticket and the checks, then says what was done", () => {
  const pr = { title: "ABC-101: Add the archive writer", headRef: "me/ABC-101-writer", baseRef: "main" };
  assert.equal(commitMessage("ci", pr, ["Style check", "Unit tests"], "Moved the helper above the struct."),
    "ABC-101: fix Style check, Unit tests\n\nMoved the helper above the struct.");
  assert.equal(commitMessage("ci", { ...pr, title: "Add the archive writer" }, ["Style check"], "Done."), "Fix Style check\n\nDone.");
  assert.equal(commitMessage("conflicts", pr, [], "Kept both imports."), "Merge main into me/ABC-101-writer\n\nKept both imports.");
});

test("an odd summary becomes one tidy paragraph", () => {
  const pr = { title: "x", headRef: "h", baseRef: "main" };
  const message = commitMessage("ci", pr, ["Style check"], '  -m "oops"\n\n\nsecond line\r\n' + "y".repeat(2000));
  const [subject, blank, ...body] = message.split("\n");
  assert.equal(subject, "Fix Style check");
  assert.equal(blank, "");
  assert.equal(body.length, 1);
  assert.ok(body[0]!.startsWith('-m "oops" second line'));
  assert.ok(body[0]!.length <= 500);
});

test("a changed path under a protected pattern is found", () => {
  const patterns = [".github/**", ".teamcity/**"];
  assert.equal(touched(["src/a.cs", ".github/workflows/ci.yml"], patterns), ".github/workflows/ci.yml");
  assert.equal(touched(["src/.github.ts", "docs/teamcity.md"], patterns), undefined);
});

test("the clone's origin is recognised in each form git writes it", () => {
  for (const url of ["git@git.example.com:acme/monolith.git", "https://git.example.com/acme/monolith", "https://git.example.com/acme/monolith.git", "ssh://git@git.example.com/acme/monolith.git", "https://me@git.example.com/Acme/Monolith.git"]) {
    assert.ok(originIs(url, "git.example.com", "acme/monolith"), url);
  }
  for (const url of ["git@other.example.com:acme/monolith.git", "https://git.example.com/acme/monolith-2.git", "https://git.example.com/acme/other", ""]) {
    assert.ok(!originIs(url, "git.example.com", "acme/monolith"), url);
  }
});

test("a worktree is named from the PR, with nothing a path could misread", () => {
  assert.equal(worktreeName("acme/monolith#501"), "acme-monolith-501");
  const odd = worktreeName("../../etc#1");
  assert.ok(!odd.includes("..") && !odd.includes("/") && odd.endsWith("etc-1"));
});
