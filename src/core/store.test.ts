import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { readJson, writeJson } from "./store.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "divination-store-"));
});

test("missing file returns the fallback", () => {
  assert.deepEqual(readJson(join(dir, "nope.json"), { a: 1 }), { a: 1 });
});

test("round trip creates parents and leaves no temp file", () => {
  const p = join(dir, "data", "x.json");
  writeJson(p, { k: ["v"] });
  assert.deepEqual(readJson(p, null), { k: ["v"] });
  assert.deepEqual(readdirSync(join(dir, "data")), ["x.json"]);
});

test("corrupt file falls back and is kept", () => {
  const p = join(dir, "s.json");
  writeFileSync(p, "{not json");
  assert.deepEqual(readJson(p, {}), {});
  assert.equal(readFileSync(p + ".bad", "utf8"), "{not json");
});
