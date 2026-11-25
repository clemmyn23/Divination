import assert from "node:assert/strict";
import { test } from "node:test";
import { contextWith, fakeExec } from "../../../test/helpers.ts";
import { hashOf } from "../../enrich/cache.ts";
import { slack } from "./index.ts";
import { slackSummary } from "./summary.enricher.ts";
import type { SlackData, SlackThread } from "./types.ts";

const todayTs = (minutes: number) => `${Date.parse("2026-11-24T13:00:00Z") / 1000 + minutes * 60}.000100`;

const thread = (ts: string, over: Partial<SlackThread> = {}): SlackThread => ({
  channelId: "C1",
  ts,
  url: "https://w.slack.com/x",
  authors: ["Sam"],
  excerpt: "e",
  text: `Sam: about ${ts}\nAna: ok\nSam: thanks`,
  messageCount: 3,
  latestTs: todayTs(60),
  ...over,
});

const DATA: SlackData = {
  conversations: [{ id: "C1", name: "team-dev", group: "Team", kind: "channel" }],
  threads: [
    thread("1.000100"),
    thread("2.000100", { messageCount: 2 }), // too short
    thread("3.000100", { latestTs: "1795300000.000100" }), // not today
    thread("4.000100", { latestTs: "1795300000.000100", needsYou: "mentioned you" }), // old, but waiting on me
    thread("5.000100", { text: "" }), // nothing to summarise (came through the inbox)
    thread("6.000100", { summary: "Already summed up." }),
  ],
  alerts: {},
};

function withAnswer(output: unknown) {
  const exec = fakeExec({ "claude -p": { stdout: JSON.stringify({ type: "result", is_error: false, structured_output: output }) } });
  return { ctx: contextWith({ slack: { summary: { model: "haiku", minMessages: 3 } } }, { exec }), exec };
}

test("the Slack source offers the summary enricher", () => {
  assert.deepEqual(slack.enrichers?.map((e) => e.id), ["slack-summary"]);
});

test("items are the shown threads long enough to be worth it, keyed by thread and hashed by their text", () => {
  const { ctx } = withAnswer({});
  const items = slackSummary.items(DATA, ctx);
  assert.deepEqual(items.map((i) => i.key), ["C1:1.000100", "C1:4.000100"]);
  assert.equal(items[0]!.hash, hashOf(DATA.threads[0]!.text)); // a thread that grows is summarised again
  assert.deepEqual(items[0]!.input, { text: DATA.threads[0]!.text });
});

test("all threads are summarised in one call, on the configured model, with no tools", async () => {
  const { ctx, exec } = withAnswer({ summaries: [{ key: "C1:1.000100", summary: "Sam asked; Ana answered." }, { key: "C1:4.000100", summary: "Waiting on you." }] });
  const out = await slackSummary.run(slackSummary.items(DATA, ctx), ctx);
  assert.deepEqual(out, { "C1:1.000100": "Sam asked; Ana answered.", "C1:4.000100": "Waiting on you." });

  assert.equal(exec.calls.length, 1);
  const args = exec.calls[0]!;
  assert.equal(args[args.indexOf("--model") + 1], "haiku");
  assert.ok(!args.includes("--allowedTools"));
  assert.ok(args.includes("--strict-mcp-config"));
});

test("summaries for unknown threads, empty ones and junk are dropped; a wrong shape is an error", async () => {
  const { ctx } = withAnswer({ summaries: [{ key: "C1:1.000100", summary: "  Fine.  " }, { key: "C9:9", summary: "Not asked for." }, { key: "C1:4.000100", summary: "" }, "junk"] });
  assert.deepEqual(await slackSummary.run(slackSummary.items(DATA, ctx), ctx), { "C1:1.000100": "Fine." });

  const bad = withAnswer({ nope: true });
  await assert.rejects(slackSummary.run(slackSummary.items(DATA, bad.ctx), bad.ctx), /wrong shape/);
});
