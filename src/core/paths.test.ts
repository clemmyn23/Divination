import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { createPaths } from "./paths.ts";

test("every path sits under out/", () => {
  const paths = createPaths("/repo");
  assert.equal(paths.out, join("/repo", "out"));
  assert.equal(paths.data("github"), join("/repo", "out", "data", "github.json"));
  assert.equal(paths.inbox("slack"), join("/repo", "out", "inbox", "slack.json"));
  assert.equal(paths.cache("enrich", "pr-review", "abc.json"), join("/repo", "out", "cache", "enrich", "pr-review", "abc.json"));
  assert.equal(paths.site, join("/repo", "out", "site", "index.html"));
  assert.equal(paths.logs, join("/repo", "out", "logs"));
  assert.equal(paths.lock, join("/repo", "out", "tick.lock"));
});
