import assert from "node:assert/strict";
import { test } from "node:test";
import { lineRange, place, reviewBody, rightLines } from "./anchor.ts";

const PATCH = ["@@ -1,4 +1,5 @@", " one", "-two", "+two!", "+two and a half", " three", " four", "@@ -20,3 +21,3 @@", " twenty", "-old", "+new", " last", "\\ No newline at end of file"].join(
  "\n",
);

test("the lines of the new file that a comment can sit on: context and added lines, by hunk", () => {
  const lines = rightLines(PATCH);
  assert.deepEqual([...lines.keys()], [1, 2, 3, 4, 5, 21, 22, 23]);
  assert.equal(lines.get(2), 0);
  assert.equal(lines.get(5), 0);
  assert.equal(lines.get(21), 1);
  assert.equal(lines.get(23), 1);
});

test("a file with no patch, such as a binary one, has no lines to comment on", () => {
  assert.equal(rightLines(undefined).size, 0);
  assert.equal(rightLines("").size, 0);
});

test("a hunk header without counts is one line long", () => {
  assert.deepEqual([...rightLines("@@ -0,0 +1 @@\n+only").keys()], [1]);
});

test("a note's line is read as its first and last whole number", () => {
  assert.deepEqual(lineRange("42"), { start: 42, end: 42 });
  assert.deepEqual(lineRange("42-48"), { start: 42, end: 48 });
  assert.deepEqual(lineRange("L42–L48"), { start: 42, end: 48 });
  assert.deepEqual(lineRange("48-42"), { start: 42, end: 48 });
  assert.equal(lineRange("the whole file"), undefined);
  assert.equal(lineRange(""), undefined);
  assert.equal(lineRange("0"), undefined);
});

const FILES = new Map([["src/a.ts", rightLines(PATCH)]]);

test("a note on one line of the diff is placed there", () => {
  assert.deepEqual(place({ file: "src/a.ts", line: "3" }, FILES), { path: "src/a.ts", line: 3 });
});

test("a range inside one hunk is a comment on the whole range", () => {
  assert.deepEqual(place({ file: "src/a.ts", line: "2-4" }, FILES), { path: "src/a.ts", line: 4, start_line: 2 });
});

test("a range across two hunks, or starting outside the diff, is placed on its last line", () => {
  assert.deepEqual(place({ file: "src/a.ts", line: "4-22" }, FILES), { path: "src/a.ts", line: 22 });
  assert.deepEqual(place({ file: "src/a.ts", line: "10-21" }, FILES), { path: "src/a.ts", line: 21 });
});

test("a range whose end is outside the diff is placed on its first line", () => {
  assert.deepEqual(place({ file: "src/a.ts", line: "5-9" }, FILES), { path: "src/a.ts", line: 5 });
});

test("a note that cannot be placed is not placed: no such file, no such line, no number", () => {
  assert.equal(place({ file: "src/b.ts", line: "3" }, FILES), undefined);
  assert.equal(place({ file: "src/a.ts", line: "12" }, FILES), undefined);
  assert.equal(place({ file: "src/a.ts", line: "somewhere" }, FILES), undefined);
  assert.equal(place({ file: "__proto__", line: "1" }, FILES), undefined);
});

test("the overall comment is my message, then the summary, then the notes that have no line", () => {
  const body = reviewBody(" lgtm \n", "Looks fine.", [{ file: "src/b.ts", line: "9", text: "Rename this.\n" }]);
  assert.equal(body, "lgtm\n\nLooks fine.\n\n**`src/b.ts:9`**\n\nRename this.");
});

test("parts that are missing or blank leave no gap", () => {
  assert.equal(reviewBody("", undefined, []), "");
  assert.equal(reviewBody("  ", "  ", []), "");
  assert.equal(reviewBody("lgtm", undefined, []), "lgtm");
  assert.equal(reviewBody("", "Fine.", []), "Fine.");
  assert.equal(reviewBody("", undefined, [{ file: "a", line: "1", text: "x" }]), "**`a:1`**\n\nx");
});

test("a file name with a backtick in it cannot break out of its label", () => {
  assert.equal(reviewBody("", undefined, [{ file: "a`b", line: "1", text: "x" }]), "**`a'b:1`**\n\nx");
});
