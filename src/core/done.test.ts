import assert from "node:assert/strict";
import { test } from "node:test";
import { NOW, contextWith } from "../../test/helpers.ts";
import { readDone, setDone } from "./done.ts";
import { buildView } from "./pipeline.ts";
import { readJson, writeJson } from "./store.ts";

test("nothing is done at first, and a mark is remembered with when it was made", () => {
  const ctx = contextWith();
  assert.deepEqual(readDone(ctx), {});
  setDone(ctx, "pr:o/r#1@abc", true);
  setDone(ctx, "slack:C1:1.000100@2.000100", true);
  assert.deepEqual(readDone(ctx), { "pr:o/r#1@abc": NOW, "slack:C1:1.000100@2.000100": NOW });
  assert.deepEqual(buildView(ctx, []).done, readDone(ctx)); // panels see it
});

test("a mark can be taken back", () => {
  const ctx = contextWith();
  setDone(ctx, "a", true);
  setDone(ctx, "b", true);
  setDone(ctx, "a", false);
  assert.deepEqual(Object.keys(readDone(ctx)), ["b"]);
  setDone(ctx, "never-marked", false); // harmless
  assert.deepEqual(Object.keys(readDone(ctx)), ["b"]);
});

test("marks older than two weeks are dropped when the file is next written", () => {
  const ctx = contextWith();
  writeJson(`${ctx.paths.out}/done.json`, { old: NOW - 15 * 86_400_000, recent: NOW - 13 * 86_400_000 });
  setDone(ctx, "new", true);
  assert.deepEqual(Object.keys(readJson(`${ctx.paths.out}/done.json`, {})).sort(), ["new", "recent"]);
});

test("a key must be a short, non-empty string, and a damaged file reads as empty", () => {
  const ctx = contextWith();
  assert.throws(() => setDone(ctx, "", true), /key/);
  assert.throws(() => setDone(ctx, "x".repeat(401), true), /key/);
  writeJson(`${ctx.paths.out}/done.json`, ["not", "an", "object"]);
  assert.deepEqual(readDone(ctx), {});
  writeJson(`${ctx.paths.out}/done.json`, { ok: NOW, bad: "yesterday" });
  assert.deepEqual(readDone(ctx), { ok: NOW });
});
