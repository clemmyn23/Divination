import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { NOW, contextWith, fakeHttp } from "../../../test/helpers.ts";
import { API, SLACK_LOCAL, slackRoutes } from "../../../test/fixtures/slack/api.ts";
import { readJson } from "../../core/store.ts";
import type { Context, Secrets } from "../../core/types.ts";
import { createSlack } from "./client.ts";
import { collectSlack } from "./collect.ts";
import { slack } from "./index.ts";

const token: Secrets = { get: async (name) => (name === "slack" ? "xoxp-sekrit" : undefined) };
let http: ReturnType<typeof fakeHttp>;
let ctx: Context;

beforeEach(() => {
  http = fakeHttp(slackRoutes());
  ctx = contextWith(SLACK_LOCAL, { http, secrets: token });
});

test("collect reads each conversation, fetches replies only for threads, skips in-channel replies", async () => {
  const data = await collectSlack(ctx);
  assert.deepEqual(
    data.threads.filter((t) => t.channelId === "C1").map((t) => [t.channelId, t.messageCount]),
    [
      ["C1", 1],
      ["C1", 3],
    ],
  );
  assert.equal(http.calls.filter((u) => u.includes("conversations.replies")).length, 1);
  assert.ok(http.calls.find((u) => u.includes("conversations.history"))!.includes(`oldest=${(NOW - 72 * 3_600_000) / 1000}`));
});

test("threads carry names, links and the conversation they came from; alert channels make no threads", async () => {
  const data = await collectSlack(ctx);
  const thread = data.threads.find((t) => t.messageCount === 3)!;
  assert.deepEqual(thread.authors, ["Sam", "Ana Lopez"]); // display name, else real name
  assert.equal(thread.url, "https://w.slack.com/archives/C1/p1795550000000200");
  assert.deepEqual(
    data.conversations.map((c) => [c.id, c.kind]),
    [
      ["C1", "channel"],
      ["D1", "dm"],
      ["C2", "alerts"],
    ],
  );
  assert.ok(data.threads.some((t) => t.channelId === "D1"));
  assert.ok(!data.threads.some((t) => t.channelId === "C2"));
  assert.deepEqual(slack.validate(data), []);
});

test("user names are looked up once and remembered between runs", async () => {
  await collectSlack(ctx);
  assert.deepEqual(readJson(ctx.paths.cache("slack", "users.json"), {}), { U1: "Sam", U2: "Ana Lopez" });
  const before = http.calls.filter((u) => u.includes("users.info")).length;
  assert.equal(before, 2);
  await collectSlack(ctx);
  assert.equal(http.calls.filter((u) => u.includes("users.info")).length, before);
});

test("a name that cannot be looked up falls back to the id and does not fail the collect", async () => {
  const routes = slackRoutes();
  routes[`${API}users.info?user=U2`] = { ok: false, error: "user_not_found" };
  const data = await collectSlack(contextWith(SLACK_LOCAL, { http: fakeHttp(routes), secrets: token }));
  assert.deepEqual(data.threads.find((t) => t.messageCount === 3)!.authors, ["Sam", "U2"]);
});

test("history and replies follow the next-page cursor", async () => {
  const pages: Record<string, unknown> = {
    ...slackRoutes(),
    [`${API}conversations.history?channel=C9`]: (url: string) =>
      url.includes("cursor=abc")
        ? { ok: true, messages: [{ ts: "1.000100", user: "U1", text: "older" }] }
        : { ok: true, messages: [{ ts: "2.000100", user: "U1", text: "newer" }], response_metadata: { next_cursor: "abc" } },
  };
  const client = createSlack(contextWith(SLACK_LOCAL, { http: fakeHttp(pages), secrets: token }));
  assert.deepEqual((await client.history("C9", "0")).map((m) => m.text), ["newer", "older"]);
});

test("search finds the channels I posted in, once each", async () => {
  const found = await createSlack(ctx).searchFromMe("2026-11-22");
  assert.deepEqual(found, [
    { id: "C7", name: "deploys" },
    { id: "C1", name: "team-dev" },
  ]);
  const url = decodeURIComponent(http.calls.find((u) => u.includes("search.messages"))!);
  assert.ok(url.includes("query=from:<@ME> after:2026-11-22"));
});

test("slack-level errors and a missing token are clear", async () => {
  await assert.rejects(collectSlack({ ...ctx, http: fakeHttp({ "https://slack.com/api/": { ok: false, error: "missing_scope" } }) }), /slack: missing_scope/);
  await assert.rejects(collectSlack({ ...ctx, secrets: { get: async () => undefined } }), /divination secret set slack/);
});

test("the token goes in the Authorization header and never in a URL, an error or a file", async () => {
  const seen: { url: string; auth?: string }[] = [];
  const spy = {
    json: async (url: string, init?: { headers?: Record<string, string> }) => {
      seen.push({ url, auth: init?.headers?.authorization });
      return { data: { ok: false, error: "invalid_auth" } as never, headers: new Headers() };
    },
    text: async () => ({ data: "", headers: new Headers() }),
  };
  await assert.rejects(collectSlack({ ...ctx, http: spy }), (e: Error) => !/sekrit/.test(e.message));
  assert.ok(seen.length > 0);
  assert.ok(seen.every((s) => s.auth === "Bearer xoxp-sekrit" && !s.url.includes("sekrit")));
  assert.equal(existsSync(ctx.paths.cache("slack", "users.json")), false);
});

test("doctor walks through token, sign-in, config and each conversation", async () => {
  const none = await slack.doctor({ ...ctx, secrets: { get: async () => undefined } });
  assert.deepEqual(none.map((c) => [c.name, c.ok]), [["token", false]]);
  assert.match(none[0]!.fix!, /docs\/slack-app-manifest\.json/);
  assert.match(none[0]!.fix!, /divination secret set slack/);

  const good = await slack.doctor(ctx);
  assert.deepEqual(
    good.map((c) => [c.name, c.ok]),
    [
      ["token", true],
      ["sign-in", true],
      ["config", true],
      ["conversations", true],
    ],
  );

  const routes = slackRoutes();
  routes[`${API}conversations.history?channel=C2`] = { ok: false, error: "channel_not_found" };
  const bad = await slack.doctor(contextWith(SLACK_LOCAL, { http: fakeHttp(routes), secrets: token }));
  const conversations = bad.find((c) => c.name === "conversations")!;
  assert.equal(conversations.ok, false);
  assert.match(conversations.detail, /svc-alerts.*channel_not_found/);
  assert.ok(!/sekrit/.test(JSON.stringify([none, good, bad])));
});

// ---- Task 9: what collect adds on top of the raw read ----

/** The routes with one method made to fail. */
function failing(method: string): Record<string, unknown> {
  return { ...slackRoutes(), [`${API}${method}`]: { ok: false, error: "missing_scope" } };
}

test("channels I posted in lately are read too, under Posted in", async () => {
  const routes = slackRoutes();
  routes[`${API}conversations.history?channel=C7`] = { ok: true, messages: [{ ts: "1795562500.000600", user: "U1", text: "Prune the noise." }] };
  const withDeploys = fakeHttp(routes);
  const data = await collectSlack(contextWith(SLACK_LOCAL, { http: withDeploys, secrets: token }));
  assert.deepEqual(data.conversations.at(-1), { id: "C7", name: "deploys", group: "Posted in", kind: "channel" });
  assert.ok(data.threads.some((t) => t.channelId === "C7"));
  const search = decodeURIComponent(withDeploys.calls.find((u) => u.includes("search.messages"))!);
  assert.ok(search.includes("after:2026-11-22")); // three days before Wednesday the 25th
});

test("a failing search does not fail the collect", async () => {
  const data = await collectSlack({ ...ctx, http: fakeHttp(failing("search.messages")) });
  assert.ok(data.threads.length > 0);
  assert.ok(!data.conversations.some((c) => c.group === "Posted in"));
});

test("a posted-in channel that cannot be read is dropped, not fatal", async () => {
  const data = await collectSlack(ctx); // the fixture has no history route for C7
  assert.ok(!data.conversations.some((c) => c.id === "C7"));
  assert.ok(data.threads.length > 0);
});

test("alert channels are counted since the start of today", async () => {
  const data = await collectSlack(ctx);
  assert.deepEqual(
    data.alerts.C2!.map((r) => [r.title, r.count, r.state]),
    [["Triggered: 5xx rate on checkout", 1, "firing"]], // the recovery was on Sunday
  );
});

test("each thread is checked for whether it needs me", async () => {
  const routes = slackRoutes();
  routes[`${API}conversations.history?channel=C1`] = { ok: true, messages: [{ ts: "1795562600.000700", user: "U1", text: "<@ME> can you look?" }, { ts: "1795540000.000100", user: "U2", text: "Staging is back." }] };
  const data = await collectSlack(contextWith(SLACK_LOCAL, { http: fakeHttp(routes), secrets: token }));
  assert.deepEqual(
    data.threads.filter((t) => t.channelId === "C1").map((t) => t.needsYou),
    [undefined, "mentioned you"],
  );
});

test("a direct message is one conversation: answering later clears it, and the newest unanswered run is shown", async () => {
  const dm = (messages: object[]) => {
    const routes = slackRoutes();
    routes[`${API}conversations.history?channel=D1`] = { ok: true, messages };
    return collectSlack(contextWith(SLACK_LOCAL, { http: fakeHttp(routes), secrets: token }));
  };
  // newest first, as Slack sends it
  const answered = await dm([{ ts: "1795561200.000500", user: "ME", text: "Sure, at 3." }, { ts: "1795561000.000400", user: "U2", text: "Do you have ten minutes?" }]);
  assert.deepEqual(answered.threads.filter((t) => t.channelId === "D1").map((t) => [t.needsYou, t.excerpt]), [[undefined, "Sure, at 3."]]);

  const waiting = await dm([
    { ts: "1795561400.000700", user: "U2", text: "Actually make it 4?" },
    { ts: "1795561300.000600", user: "U2", text: "Thanks!" },
    { ts: "1795561200.000500", user: "ME", text: "Sure, at 3." },
    { ts: "1795561000.000400", user: "U2", text: "Do you have ten minutes?" },
  ]);
  const [thread] = waiting.threads.filter((t) => t.channelId === "D1");
  assert.deepEqual([thread!.needsYou, thread!.excerpt, thread!.messageCount, thread!.latestTs], ["waiting on your reply", "Thanks!", 2, "1795561400.000700"]);
  assert.equal(thread!.url, "https://w.slack.com/archives/D1/p1795561300000600");
});
