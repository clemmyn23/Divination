import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { NOW, contextWith, tempRoot } from "../../test/helpers.ts";
import { createContext } from "./context.ts";

test("a context carries config, paths and working services", () => {
  const root = tempRoot({ tick: { minutes: 5 } });
  const ctx = createContext(root);
  assert.equal(ctx.root, root);
  assert.equal(ctx.config.tick.minutes, 5);
  assert.equal(ctx.paths.out, join(root, "out"));
  assert.ok(Math.abs(ctx.now() - Date.now()) < 5000);
  assert.equal(typeof ctx.http.json, "function");
  assert.equal(typeof ctx.exec, "function");
  assert.equal(typeof ctx.secrets.get, "function");
});

test("overrides replace services", () => {
  const ctx = createContext(tempRoot(), { now: () => 42 });
  assert.equal(ctx.now(), 42);
});

test("log appends one JSON line per event", () => {
  const ctx = createContext(tempRoot(), { now: () => 42 });
  ctx.log("collect", { source: "github", ok: true });
  ctx.log("render");
  const lines = readFileSync(join(ctx.paths.logs, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines, [{ at: 42, event: "collect", source: "github", ok: true }, { at: 42, event: "render" }]);
});

test("contextWith gives a fixed clock, fakes and the local config", async () => {
  const ctx = contextWith({ staleAfterMinutes: 5 });
  assert.equal(ctx.now(), NOW);
  assert.equal(ctx.config.staleAfterMinutes, 5);
  await assert.rejects(ctx.http.json("https://anything.example"), /fakeHttp: no route/);
  assert.equal((await ctx.exec("anything", [])).code, 1);
  assert.equal(await ctx.secrets.get("slack"), undefined);
  assert.equal(contextWith({}, { now: () => 7 }).now(), 7);
});

test("the pieces of text Claude streams are not written to the log file; the events around them are", () => {
  const ctx = createContext(tempRoot());
  ctx.log("llm-start", { model: "haiku" });
  ctx.log("llm-text", { text: "Read", start: true });
  ctx.log("llm-text", { text: "ing" });
  ctx.log("llm-tool", { name: "Bash", detail: "gh pr diff 12" });
  const events = readFileSync(join(ctx.paths.logs, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).event);
  assert.deepEqual(events, ["llm-start", "llm-tool"]);
});
