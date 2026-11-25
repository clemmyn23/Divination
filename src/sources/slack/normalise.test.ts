import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { view } from "../../../test/helpers.ts";
import { appLink, conversationsFromConfig, permalink, plainText, toThread } from "./normalise.ts";
import type { SlackConversation, SlackMessage } from "./types.ts";

const CONV: SlackConversation = { id: "C1", name: "team-dev", group: "Team", kind: "channel" };
const msg = (ts: string, user: string, text: string): SlackMessage => ({ ts, user, text });

test("permalinks", () => {
  assert.equal(permalink("https://w.slack.com", "C1", "1700000000.000100"), "https://w.slack.com/archives/C1/p1700000000000100");
  assert.equal(
    permalink("https://w.slack.com", "C1", "1700000050.000200", "1700000000.000100"),
    "https://w.slack.com/archives/C1/p1700000050000200?thread_ts=1700000000.000100&cid=C1",
  );
});

test("a thread is normalised", () => {
  const t = toThread(CONV, [msg("1.000100", "U1", "Is the   build\nbroken?"), msg("2.000100", "U2", "Looking"), msg("3.000100", "U1", "Thanks")], { U1: "Sam", U2: "Ana" }, "https://w.slack.com");
  assert.deepEqual([t.authors, t.excerpt, t.messageCount, t.latestTs], [["Sam", "Ana"], "Is the build broken?", 3, "3.000100"]);
  assert.equal(t.text, "Sam: Is the   build\nbroken?\nAna: Looking\nSam: Thanks");
  assert.deepEqual([t.channelId, t.ts, t.url], ["C1", "1.000100", "https://w.slack.com/archives/C1/p1000100"]);
});

test("long text is cut", () => {
  const t = toThread(CONV, [msg("1.000100", "U1", "x".repeat(500))], { U1: "Sam" }, "https://w.slack.com");
  assert.equal(t.excerpt.length, 200);
  assert.ok(t.excerpt.endsWith("…"));
  const long = toThread(CONV, [msg("1.000100", "U1", "y".repeat(5000))], { U1: "Sam" }, "https://w.slack.com");
  assert.equal(long.text.length, 4000);
});

test("bots show their bot id and an unknown user shows their id", () => {
  const t = toThread(CONV, [{ ts: "1.000100", bot_id: "B1", text: "Deploy done" }, msg("2.000100", "U9", "ok")], {}, "https://w.slack.com");
  assert.deepEqual(t.authors, ["B1", "U9"]);
});

test("Slack's markup reads as plain text in an excerpt", () => {
  const names = { U1: "Sam" };
  assert.equal(plainText("hey <@U1> see <https://x.example/a|the doc> &amp; <#C5|deploys> <!here>", names), "hey @Sam see the doc & #deploys @here");
  assert.equal(plainText("<https://x.example/a> by <@U9> &lt;b&gt;", names), "https://x.example/a by @U9 <b>");
  const t = toThread(CONV, [msg("1.000100", "U1", "ping <@U1>: <https://x.example|link>")], names, "https://w.slack.com");
  assert.equal(t.excerpt, "ping @Sam: link");
});

test("conversations come from the configured groups, in order, with their kind", () => {
  const config = {
    ...view.config,
    slack: {
      ...view.config.slack,
      groups: [
        { name: "Team", kind: "digest" as const, conversations: [{ id: "C1", name: "team-dev" }, { id: "D1", name: "Ana", dm: true }] },
        { name: "Alerts", kind: "alerts" as const, conversations: [{ id: "C2", name: "svc-alerts" }] },
        { name: "Starred", kind: "digest" as const, conversations: [{ id: "C1", name: "team-dev" }] }, // listed twice: first wins
      ],
    },
  };
  assert.deepEqual(conversationsFromConfig(config), [
    { id: "C1", name: "team-dev", group: "Team", kind: "channel" },
    { id: "D1", name: "Ana", group: "Team", kind: "dm" },
    { id: "C2", name: "svc-alerts", group: "Alerts", kind: "alerts" },
  ]);
});

test("the app manifest asks for read-only user scopes and no bot", () => {
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../../../docs/slack-app-manifest.json", import.meta.url)), "utf8"));
  assert.equal(manifest.display_information.name, "Divination");
  assert.deepEqual(manifest.oauth_config.scopes.user, ["channels:history", "groups:history", "im:history", "mpim:history", "users:read", "search:read"]);
  assert.equal(manifest.oauth_config.scopes.bot, undefined);
  assert.equal(manifest.features?.bot_user, undefined);
  assert.ok(!/write|chat:|reactions:/.test(JSON.stringify(manifest.oauth_config)));
});

test("a message link becomes a link that opens the Slack app at that message", () => {
  assert.equal(appLink("https://w.slack.com/archives/C1/p1795563588591749", "T02ABC"), "slack://channel?team=T02ABC&id=C1&message=1795563588.591749");
  assert.equal(
    appLink("https://w.slack.com/archives/D03MS4595SA/p1794544467370979?thread_ts=1794544000.000100&cid=D03MS4595SA", "T02ABC"),
    "slack://channel?team=T02ABC&id=D03MS4595SA&message=1794544467.370979&thread_ts=1794544000.000100",
  );
});

test("without a team id, or for a link that is not a Slack message, the link is left alone", () => {
  const url = "https://w.slack.com/archives/C1/p1795563588591749";
  assert.equal(appLink(url, ""), url);
  assert.equal(appLink("https://git.example.com/o/r/pull/1", "T02ABC"), "https://git.example.com/o/r/pull/1");
  assert.equal(appLink("https://w.slack.com/archives/C1/p5", "T02ABC"), "https://w.slack.com/archives/C1/p5"); // too short to be a message
  assert.equal(appLink("https://w.slack.com/archives/C1/p1795563588591749", "T02 ABC"), url); // a team id is letters and digits only
});
