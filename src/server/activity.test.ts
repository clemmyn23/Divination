import assert from "node:assert/strict";
import { test } from "node:test";
import { type SourceState, createActivity } from "./activity.ts";

const T0 = Date.parse("2026-11-25T05:00:00Z");

function activity(initial: SourceState[] = [{ id: "github", title: "Review queue", state: "ok", at: T0 - 60_000 }]) {
  let now = T0;
  const a = createActivity(() => now, initial);
  return { a, tick: (ms: number) => (now += ms) };
}

test("each source starts in the state its last collection left it in", () => {
  const { a } = activity([
    { id: "github", title: "Review queue", state: "ok", at: T0 - 60_000 },
    { id: "slack", title: "Slack", state: "failed", at: 0, error: "inbox file missing", byHand: true },
  ]);
  assert.deepEqual(a.sources(), [
    { id: "github", title: "Review queue", state: "ok", at: T0 - 60_000 },
    { id: "slack", title: "Slack", state: "failed", at: 0, error: "inbox file missing", byHand: true },
  ]);
  assert.deepEqual(a.lines(), []);
});

test("a source is running from the moment its collection starts until it ends, with how long it took", () => {
  const { a, tick } = activity();
  a.record("collect-start", { source: "github" });
  assert.deepEqual(a.sources()[0], { id: "github", title: "Review queue", state: "running", at: T0 - 60_000, startedAt: T0 });

  tick(900);
  a.record("collect", { source: "github", ok: true, ms: 900, at: T0 + 900 });
  assert.deepEqual(a.sources()[0], { id: "github", title: "Review queue", state: "ok", at: T0 + 900, ms: 900 });

  a.record("collect-start", { source: "github" });
  a.record("collect", { source: "github", ok: false, ms: 30, at: T0 - 60_000, error: "cannot reach git.example.com" });
  assert.deepEqual(a.sources()[0], { id: "github", title: "Review queue", state: "failed", at: T0 - 60_000, ms: 30, error: "cannot reach git.example.com" });
});

test("a refresh reads as a story: started, each source, finished", () => {
  const { a, tick } = activity();
  a.record("tick-start", { forced: true });
  a.record("collect-start", { source: "github" });
  tick(1200);
  a.record("collect", { source: "github", ok: true, ms: 1200, at: T0 + 1200 });
  a.record("tick", { result: "ran", ms: 1250 });
  assert.deepEqual(
    a.lines().map((l) => [l.at, l.level, l.text]),
    [
      [T0, "info", "Refresh started (Refresh now)"],
      [T0, "info", "Review queue: reading…"],
      [T0 + 1200, "info", "Review queue: ok in 1.2 s"],
      [T0 + 1200, "info", "Refresh finished in 1.3 s"],
    ],
  );
});

test("timer refreshes, skipped refreshes and failures say so", () => {
  const { a } = activity();
  a.record("tick-start", { forced: false });
  a.record("tick", { result: "outside-hours", ms: 0 });
  a.record("tick", { result: "locked", ms: 0 });
  a.record("collect", { source: "github", ok: false, ms: 40, at: 0, error: "HTTP 502" });
  a.record("collect", { source: "mystery", ok: true, ms: 5, at: T0 });
  assert.deepEqual(
    a.lines().map((l) => [l.level, l.text]),
    [
      ["info", "Refresh started (timer)"],
      ["info", "Refresh skipped: outside working hours"],
      ["info", "Refresh skipped: another refresh is still running"],
      ["error", "Review queue: failed in 0 s: HTTP 502"],
      ["info", "mystery: ok in 0 s"],
    ],
  );
});

test("a Claude call is logged when it starts and when it ends, with its cost, turns and answer", () => {
  const { a, tick } = activity();
  a.record("enrich", { enricher: "pr-review", key: "o/r#1@abc", items: 1 });
  a.record("llm-start", { model: "opus", prompt: "pr-review.md", tools: ["Bash(gh pr diff:*)"] });
  tick(42_000);
  a.record("llm", { ok: true, ms: 42_000, model: "opus", costUsd: 0.1234, turns: 5, output: '{"verdict":"comment",\n"summary":"Fine."}' });
  a.record("llm-start", { model: "haiku", prompt: "slack-summary.md", tools: [] });
  a.record("llm", { ok: false, ms: 115, model: "haiku", costUsd: 0, turns: 1, error: "claude failed: Failed to authenticate" });
  assert.deepEqual(
    a.lines().map((l) => [l.level, l.text]),
    [
      ["info", "Asked for pr-review on o/r#1@abc (1 item)"],
      ["info", "Claude (opus) started: pr-review.md, tools: Bash(gh pr diff:*)"],
      ["info", 'Claude (opus) finished in 42 s · $0.12 · 5 turns\n  {"verdict":"comment",\n  "summary":"Fine."}'],
      ["info", "Claude (haiku) started: slack-summary.md, no tools"],
      ["error", "Claude (haiku) failed in 0.1 s · $0.00 · 1 turn\n  claude failed: Failed to authenticate"],
    ],
  );
});

test("the log keeps the newest 300 lines, can be asked for fewer, and ignores events it does not know", () => {
  const { a } = activity();
  a.record("something-else", { x: 1 });
  for (let i = 0; i < 320; i++) a.record("tick-start", { forced: true });
  assert.equal(a.lines().length, 300);
  assert.equal(a.lines(5).length, 5);
});
