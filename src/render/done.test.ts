import assert from "node:assert/strict";
import { test } from "node:test";
import { view } from "../../test/helpers.ts";
import { doneAccordion, isDone, tick } from "./done.ts";

test("a tick is a small button that carries the line's key and whether it is done", () => {
  assert.equal(tick("pr:o/r#1@abc", false), '<button type="button" class="tick" data-done="pr:o/r#1@abc" data-state="open" title="Mark as done" aria-label="Mark as done">✓</button>');
  assert.equal(tick('a"<b>', true), '<button type="button" class="tick" data-done="a&quot;&lt;b&gt;" data-state="done" title="Mark as not done" aria-label="Mark as not done">✓</button>');
});

test("done is looked up by key, and odd keys are not mistaken for done", () => {
  const v = { ...view, done: { a: 1 } };
  assert.equal(isDone("a", v), true);
  assert.equal(isDone("b", v), false);
  assert.equal(isDone("toString", v), false);
  assert.equal(isDone(undefined, v), false);
});

test("done lines fold into one accordion", () => {
  assert.equal(doneAccordion(2, "<ul></ul>"), '<details class="stale done">\n<summary>Done · 2</summary>\n<ul></ul>\n</details>');
});
