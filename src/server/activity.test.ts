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

// Claude reads started by Refresh now

test("a Claude read shows on its source while it runs, and reads as a story in the log", () => {
  const { a } = activity([{ id: "slack", title: "Slack", state: "ok", at: T0 - 60_000, byHand: true }]);
  a.record("feed-start", { source: "slack" });
  assert.deepEqual(a.sources()[0], { id: "slack", title: "Slack", state: "running", at: T0 - 60_000, byHand: true, startedAt: T0, asking: true });

  a.record("feed", { source: "slack", ok: true, ms: 324_000 });
  a.record("collect-start", { source: "slack" });
  a.record("collect", { source: "slack", ok: true, ms: 3, at: T0 });
  assert.deepEqual(a.sources()[0], { id: "slack", title: "Slack", state: "ok", at: T0, byHand: true, ms: 3 });
  assert.deepEqual(a.lines().map((l) => l.text).slice(0, 2), ["Slack: asking Claude to read it…", "Slack: Claude read it in 324 s"]);
});

test("a Claude read that fails leaves its source marked failed, with why", () => {
  const { a } = activity([{ id: "slack", title: "Slack", state: "ok", at: T0 - 60_000, byHand: true }]);
  a.record("feed-start", { source: "slack" });
  a.record("feed", { source: "slack", ok: false, ms: 115, error: "claude failed: Failed to authenticate" });
  assert.deepEqual(a.sources()[0], { id: "slack", title: "Slack", state: "failed", at: T0 - 60_000, byHand: true, ms: 115, error: "claude failed: Failed to authenticate" });
  assert.deepEqual(
    a.lines().map((l) => [l.level, l.text]).at(-1),
    ["error", "Slack: Claude could not read it (0.1 s): claude failed: Failed to authenticate"],
  );
});

test("a read held back by the throttle says so, and how long is left", () => {
  const { a } = activity([{ id: "slack", title: "Slack", state: "ok", at: T0, byHand: true }]);
  a.record("feed-skip", { source: "slack", waitMs: 90_000, throttleMinutes: 2 });
  assert.equal(a.lines()[0]!.text, "Slack: Claude was asked less than 2 minutes ago, so it was not asked again (90 s to go)");
  assert.equal(a.sources()[0]!.state, "ok");
});

test("switching a source on or off for Refresh now is a line in the log", () => {
  const { a } = activity([{ id: "slack", title: "Slack", state: "ok", at: T0, byHand: true }]);
  a.record("reads", { source: "slack", on: false });
  a.record("reads", { source: "slack", on: true });
  assert.deepEqual(a.lines().map((l) => l.text), [
    "Slack: Refresh now will no longer ask Claude to read it",
    "Slack: Refresh now will ask Claude to read it",
  ]);
});

test("tools a Claude run was refused are named on its closing line", () => {
  const { a } = activity();
  a.record("llm", { ok: true, ms: 1000, model: "haiku", turns: 2, denied: ["Bash", "mcp__x__send"] });
  assert.equal(a.lines()[0]!.text, "Claude (haiku) finished in 1 s · 2 turns · refused: Bash, mcp__x__send");
});

test("the tokens a Claude run read and wrote are on its closing line, with how much came from the cache", () => {
  const { a } = activity();
  a.record("llm", { ok: false, ms: 31_000, model: "haiku", costUsd: 0.51, turns: 14, tokens: { in: 1200, cacheWrite: 30_000, cacheRead: 400_000, out: 950 }, error: "claude failed: stopped" });
  assert.equal(a.lines()[0]!.text, "Claude (haiku) failed in 31 s · $0.51 · 14 turns · 431k tokens in (400k cached), 950 out\n  claude failed: stopped");
});

test("what a Claude run loaded before it began is one line of counts", () => {
  const { a } = activity();
  a.record("llm-loaded", { tools: 312, servers: ["claude.ai Slack", "playwright"], skills: 56, plugins: 8 });
  a.record("llm-loaded", { tools: 2, servers: [], skills: 0, plugins: 0 });
  assert.equal(a.lines()[0]!.text, "Claude loaded 312 tools, 2 MCP servers (claude.ai Slack, playwright), 56 skills, 8 plugins");
  assert.equal(a.lines()[1]!.text, "Claude loaded 2 tools, 0 MCP servers, 0 skills, 0 plugins");
});

test("a fix reads as a story: which PR, each step, how it ended", () => {
  const { a } = activity();
  a.record("fix-start", { key: "o/r#8", what: "ci" });
  a.record("fix-step", { key: "o/r#8", step: "reading the log of Style check" });
  a.record("fix-end", { key: "o/r#8", outcome: "pushed", text: "Moved the helper." });
  a.record("fix-start", { key: "o/r#9", what: "conflicts" });
  a.record("fix-end", { key: "o/r#9", outcome: "gave-up", text: "Needs a database change." });
  a.record("fix-end", { key: "o/r#10", outcome: "failed", text: "the branch moved" });
  a.record("fix-end", { key: "o/r#11", outcome: "refused", text: "CI is still running" });
  a.record("fix-all", { pushed: 1, gaveUp: 1, failed: 1, refused: 1, skipped: 2 });
  assert.deepEqual(a.lines().map((l) => [l.level, l.text]), [
    ["info", "Fixing o/r#8 (CI failing)"],
    ["info", "o/r#8: reading the log of Style check"],
    ["info", "o/r#8: fix pushed: Moved the helper."],
    ["info", "Fixing o/r#9 (merge conflicts)"],
    ["info", "o/r#9: could not fix: Needs a database change."],
    ["error", "o/r#10: fix failed: the branch moved"],
    ["info", "o/r#11: not fixed: CI is still running"],
    ["info", "Fix all finished: 1 pushed, 1 gave up, 1 failed, 1 not fixed, 2 skipped"],
  ]);
});

test("a posted review says which PR, what kind and how many notes; a failed one says why", () => {
  const { a } = activity();
  a.record("review-post", { key: "o/r#1", event: "approve", comments: 3, inBody: 1 });
  a.record("review-post", { key: "o/r#2", event: "request_changes", comments: 1, inBody: 0 });
  a.record("review-post", { key: "o/r#3", event: "comment", comments: 0, inBody: 0 });
  a.record("review-post-failed", { key: "o/r#4", error: "HTTP 422 from GitHub" });
  assert.deepEqual(a.lines().map((l) => [l.level, l.text]), [
    ["info", "Posted a review on o/r#1: approve, 3 comments on lines, 1 in the overall comment"],
    ["info", "Posted a review on o/r#2: request changes, 1 comment on a line"],
    ["info", "Posted a review on o/r#3: comment"],
    ["error", "Could not post the review on o/r#4: HTTP 422 from GitHub"],
  ]);
});
