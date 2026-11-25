import assert from "node:assert/strict";
import { test } from "node:test";
import { tempRoot } from "../../test/helpers.ts";
import { loadConfig } from "./config.ts";

test("local config merges over defaults", () => {
  const cfg = loadConfig(tempRoot({ tick: { minutes: 5 }, sources: ["github"] }));
  assert.equal(cfg.tick.minutes, 5);
  assert.equal(cfg.tick.start, "08:00");
  assert.deepEqual(cfg.sources, ["github"]);
});

test("config works with no local file", () => {
  assert.equal(loadConfig(tempRoot()).staleAfterMinutes, 60);
});

test("config problems are all listed", () => {
  const root = tempRoot({
    tick: { start: "8am" },
    slack: { groups: [{ name: "x", kind: "loud", conversations: [{ id: "C1" }] }] },
  });
  assert.throws(
    () => loadConfig(root),
    (e: Error) => /tick\.start/.test(e.message) && /kind/.test(e.message) && /name/.test(e.message),
  );
});
