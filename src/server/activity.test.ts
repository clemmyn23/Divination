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

// Streaming: lines are numbered, and a listener hears each one as it is said

test("every line has an id that only goes up, and the lines after an id can be asked for", () => {
  const { a } = activity();
  a.record("tick-start", { forced: true });
  a.record("collect-start", { source: "github" });
  a.record("tick", { result: "ran", ms: 10 });
  const ids = a.lines().map((l) => l.id);
  assert.ok(ids[0]! < ids[1]! && ids[1]! < ids[2]!);
  assert.deepEqual(a.linesAfter(ids[0]!).map((l) => l.id), [ids[1], ids[2]]);
  assert.deepEqual(a.linesAfter(ids[2]!), []);
});

test("a server started later numbers its lines above an earlier server's", () => {
  const first = createActivity(() => T0, []);
  for (let i = 0; i < 50; i++) first.record("tick-start", {});
  const second = createActivity(() => T0 + 1000, []);
  second.record("tick-start", {});
  assert.ok(second.lines()[0]!.id > first.lines().at(-1)!.id);
});

test("a listener hears each new line as it is said, until it stops listening", () => {
  const { a } = activity();
  const heard: unknown[] = [];
  const stop = a.subscribe((update) => heard.push(update));
  a.record("tick-start", { forced: true });
  assert.deepEqual(heard, [{ type: "line", line: a.lines()[0] }]);
  stop();
  a.record("tick", { result: "ran", ms: 10 });
  assert.equal(heard.length, 1);
});

test("what Claude writes grows one line as it streams; a tool or a new passage starts another", () => {
  const { a } = activity();
  const heard: { type: string; id?: number; text?: string; line?: { id: number; text: string } }[] = [];
  a.subscribe((update) => heard.push(update));

  a.record("llm-text", { text: "Reading ", start: true });
  a.record("llm-text", { text: "the diff." });
  a.record("llm-tool", { name: "Bash", detail: "gh pr diff 12" });
  a.record("llm-text", { text: "Looks ", start: true });
  a.record("llm-text", { text: "fine." });
  a.record("llm-text", { text: "Second thought.", start: true });
  a.record("llm-tool", { name: "Read", detail: "" });

  assert.deepEqual(
    a.lines().map((l) => l.text),
    ["Claude: Reading the diff.", "Claude is using Bash: gh pr diff 12", "Claude: Looks fine.", "Claude: Second thought.", "Claude is using Read"],
  );
  const first = a.lines()[0]!.id;
  assert.deepEqual(heard.slice(0, 2), [
    { type: "line", line: { id: first, at: T0, level: "info", text: "Claude: Reading " } },
    { type: "more", id: first, text: "the diff." },
  ]);
});

test("text that arrives after something else was logged starts a new line rather than growing an old one", () => {
  const { a } = activity();
  a.record("llm-text", { text: "One", start: true });
  a.record("tick-start", { forced: false });
  a.record("llm-text", { text: " two" });
  assert.deepEqual(a.lines().map((l) => l.text), ["Claude: One", "Refresh started (timer)", "Claude:  two"]);
});

test("a streamed line stops growing at 4000 characters, and says it was cut", () => {
  const { a } = activity();
  const heard: { type: string; text?: string }[] = [];
  a.record("llm-text", { text: "x".repeat(3000), start: true });
  a.subscribe((update) => heard.push(update));
  a.record("llm-text", { text: "y".repeat(3000) });
  a.record("llm-text", { text: "z".repeat(10) });
  const text = a.lines()[0]!.text;
  assert.equal(text.length, 4000);
  assert.ok(text.endsWith("y…"));
  assert.equal(heard.length, 1); // the listener hears only what was kept
  assert.equal(heard[0]!.text!.length, 4000 - "Claude: ".length - 3000);
});

test("a page catching up is also given the line still being written, which may have grown", () => {
  const { a } = activity();
  a.record("tick-start", { forced: true });
  a.record("llm-text", { text: "Read", start: true });
  const growing = a.lines()[1]!.id;
  a.record("llm-text", { text: "ing" });
  assert.deepEqual(a.linesAfter(growing).map((l) => l.text), ["Claude: Reading"]);
  a.record("llm-tool", { name: "Bash", detail: "ls" });
  assert.deepEqual(a.linesAfter(growing).map((l) => l.text), ["Claude is using Bash: ls"]);
});
