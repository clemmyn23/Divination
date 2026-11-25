import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, HOST, githubRoutes } from "../../../test/fixtures/github/api.ts";
import { contextWith, fakeExec, fakeHttp } from "../../../test/helpers.ts";
import { writeJson } from "../../core/store.ts";
import type { Secrets } from "../../core/types.ts";
import type { SlackMessage } from "../slack/types.ts";
import { collectGithub } from "./collect.ts";
import { findSignal } from "./slack-signal.ts";

const post = (ts: string, url: string, over: object = {}): SlackMessage => ({ ts, text: `requested a review <${url}>`, ...over });
const args: [string, string[], Record<string, string>, (ts: string) => string] = ["ME", ["octagonal_sign", "eyes"], { U1: "Sam", ME: "Me" }, (ts) => `https://w.slack.com/p${ts}`];

test("signals", () => {
  const url = "https://git.example.com/o/r/pull/1";
  assert.equal(findSignal(url, [post("1", url)], ...args), undefined);
  assert.deepEqual(findSignal(url, [post("1", url, { reactions: [{ name: "octagonal_sign", users: ["U1"] }] })], ...args), {
    kind: "skip",
    reason: "not for this crew (:octagonal_sign:)",
    url: "https://w.slack.com/p1",
  });
  assert.equal(findSignal(url, [post("1", url, { reactions: [{ name: "eyes", users: ["U1", "ME"] }] })], ...args)?.reason, "already picked up by Sam");
  assert.equal(findSignal(url, [post("1", url, { reactions: [{ name: "eyes", users: ["ME"] }] })], ...args), undefined);
  assert.deepEqual(findSignal(url, [post("1", url, { reply_count: 2 })], ...args), { kind: "flag", reason: "2 replies in the review thread", url: "https://w.slack.com/p1" });
  assert.equal(findSignal(url, [post("1", "https://git.example.com/o/r/pull/11")], ...args), undefined);
  assert.equal(findSignal(url, [post("1", url, { reply_count: 1 }), post("2", url, { reactions: [{ name: "eyes", users: ["U1"] }] })], ...args)?.kind, "skip");
});

test("only listed reactions count, several people are all named, and one reply reads properly", () => {
  const url = "https://git.example.com/o/r/pull/1";
  const eyes = post("1", url, { reactions: [{ name: "eyes", users: ["U1", "U2"] }] });
  assert.equal(findSignal(url, [eyes], "ME", ["octagonal_sign"], { U1: "Sam" }, () => "x"), undefined);
  assert.equal(findSignal(url, [eyes], "ME", ["eyes"], { U1: "Sam" }, () => "x")?.reason, "already picked up by Sam, U2");
  assert.equal(findSignal(url, [post("1", url, { reply_count: 1 })], ...args)?.reason, "1 reply in the review thread");
  assert.equal(findSignal(url, [post("1", `see ${url}/files for the diff`)], ...args), undefined); // posts carry the link in their text; a bare prefix match is enough
});

// ---- collectGithub ----

const SIGNAL_LOCAL = {
  github: { host: HOST, slackSignal: { channelId: "CREVIEW" } },
  slack: { workspaceUrl: "https://w.slack.com", userId: "ME" },
};
const token: Secrets = { get: async (name) => (name === "slack" ? "xoxp-sekrit" : undefined) };
const gh = () => fakeExec({ "gh auth token": { stdout: "tok-123\n" } });
const PR1_URL = `https://${HOST}/o/r/pull/1`;

function withSlack(messages: object[]) {
  return fakeHttp({
    ...githubRoutes(),
    "https://slack.com/api/conversations.history?channel=CREVIEW": { ok: true, messages },
    "https://slack.com/api/users.info?user=U1": { ok: true, user: { profile: { display_name: "Sam" } } },
  });
}

test("a PR that someone picked up in the review channel is skipped, with a link to the post", async () => {
  const http = withSlack([{ ts: "1795560000.000100", bot_id: "B1", text: `requested a review <${PR1_URL}|PR number 1>`, reactions: [{ name: "eyes", users: ["U1"] }] }]);
  const data = await collectGithub(contextWith(SIGNAL_LOCAL, { http, exec: gh(), secrets: token }));
  const pr = data.prs.find((p) => p.key === "o/r#1")!;
  assert.deepEqual(pr.signal, { kind: "skip", reason: "already picked up by Sam", url: "https://w.slack.com/archives/CREVIEW/p1795560000000100" });
  assert.equal(pr.rank.bucket, "skip");
  assert.equal(data.prs.find((p) => p.key === "o/r#2")!.signal, undefined);
  assert.equal(http.calls.filter((u) => u.includes("conversations.history")).length, 1); // read once, not once per PR
});

test("no Slack token means no signals, not a failure", async () => {
  const data = await collectGithub(contextWith(SIGNAL_LOCAL, { http: fakeHttp(githubRoutes()), exec: gh(), secrets: { get: async () => undefined } }));
  assert.equal(data.prs.length, 2);
  assert.ok(data.prs.every((p) => p.signal === undefined));
});

test("a failing Slack call, or no review channel set, means no signals", async () => {
  const failing = fakeHttp({ ...githubRoutes(), "https://slack.com/api/": { ok: false, error: "missing_scope" } });
  const a = await collectGithub(contextWith(SIGNAL_LOCAL, { http: failing, exec: gh(), secrets: token }));
  assert.ok(a.prs.length === 2 && a.prs.every((p) => p.signal === undefined));

  const none = withSlack([]);
  const b = await collectGithub(contextWith({ github: { host: HOST } }, { http: none, exec: gh(), secrets: token }));
  assert.ok(b.prs.every((p) => p.signal === undefined));
  assert.equal(none.calls.filter((u) => u.includes("slack.com")).length, 0);
});

test("when Slack is fed by hand, signals come from the swept file's review posts", async () => {
  const ctx = contextWith({ ...SIGNAL_LOCAL, slack: { ...SIGNAL_LOCAL.slack, transport: "inbox" } }, { http: fakeHttp(githubRoutes()), exec: gh(), secrets: { get: async () => undefined } });
  writeJson(ctx.paths.inbox("slack"), {
    conversations: [],
    reviewPosts: [
      { ts: "1795560000.000100", text: `requested a review <${PR1_URL}|PR number 1>`, replyCount: 0, reactions: [{ name: "eyes", users: [{ id: "U1", name: "Sam" }, { id: "ME", name: "Me" }] }] },
      { ts: "1795550000.000100", text: `requested a review <https://${HOST}/o/r/pull/2|PR number 2>`, replyCount: 3 },
      "junk",
    ],
  });
  const data = await collectGithub(ctx);
  assert.deepEqual(data.prs.find((p) => p.key === "o/r#1")!.signal, { kind: "skip", reason: "already picked up by Sam", url: "https://w.slack.com/archives/CREVIEW/p1795560000000100" });
  assert.equal(data.prs.find((p) => p.key === "o/r#2")!.signal?.reason, "3 replies in the review thread");
  assert.ok(BASE.length > 0);
});
