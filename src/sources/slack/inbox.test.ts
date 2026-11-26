import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { NOW, contextWith, fakeExec, view } from "../../../test/helpers.ts";
import { SLACK_LOCAL } from "../../../test/fixtures/slack/api.ts";
import { collectSource } from "../../core/pipeline.ts";
import { writeJson } from "../../core/store.ts";
import { fromInbox, sweepPlan } from "./inbox.ts";
import { slack } from "./index.ts";

const ctx = () => contextWith({ ...SLACK_LOCAL, slack: { ...SLACK_LOCAL.slack, transport: "inbox" } });
const START_OF_TODAY = Date.parse("2026-11-24T13:00:00Z") / 1000; // Sydney midnight, in seconds
const today = (minutes: number) => `${START_OF_TODAY + minutes * 60}.000100`;
const SUNDAY = "1795300000.000100";

const thread = (ts: string, over: object = {}) => ({ ts, latestTs: ts, authors: ["Sam"], messageCount: 1, excerpt: `about ${ts}`, ...over });
const swept = (conversations: object[]) => ({ conversations });

test("the plan tells the reader exactly what to read, so it does no date sums and parses no config", () => {
  const plan = sweepPlan(ctx());
  assert.deepEqual(plan, {
    me: { id: "ME" },
    windowOldest: String(NOW / 1000 - 72 * 3600),
    todayOldest: String(START_OF_TODAY),
    file: "out/inbox/slack.json",
    conversations: [
      { id: "C1", name: "team-dev", read: "threads" },
      { id: "D1", name: "Ana", read: "dm" },
      { id: "C2", name: "svc-alerts", read: "alerts" },
    ],
  });
});

test("on a Monday the plan reaches back five days, so the weekend does not use up the window", () => {
  const monday = Date.parse("2026-11-22T23:00:00Z"); // Monday 23 November, 10:00 in Sydney
  const plan = sweepPlan(contextWith({ ...SLACK_LOCAL, slack: { ...SLACK_LOCAL.slack, transport: "inbox" } }, { now: () => monday }));
  assert.equal(plan.windowOldest, String(monday / 1000 - 120 * 3600));
});

test("swept threads become Slack data, with the conversations taken from config", () => {
  const data = fromInbox(swept([{ id: "C1", threads: [thread(today(60), { authors: ["Sam", "Ana"], messageCount: 3, excerpt: "Is the build broken?", summary: "Ana fixed the build." })] }]), ctx());
  assert.deepEqual(
    data.conversations.map((c) => [c.id, c.name, c.group, c.kind]),
    [
      ["C1", "team-dev", "Team", "channel"],
      ["D1", "Ana", "Team", "dm"],
      ["C2", "svc-alerts", "Alerts", "alerts"],
    ],
  );
  assert.deepEqual(data.threads, [
    {
      channelId: "C1",
      ts: today(60),
      url: `https://w.slack.com/archives/C1/p${today(60).replace(".", "")}`,
      authors: ["Sam", "Ana"],
      excerpt: "Is the build broken?",
      text: "",
      messageCount: 3,
      latestTs: today(60),
      summary: "Ana fixed the build.",
    },
  ]);
  assert.deepEqual(data.alerts, { C2: [] });
  assert.deepEqual(slack.validate(data), []);
});

test("code, not the reader, decides what needs me, from plain facts about each thread", () => {
  const data = fromInbox(
    swept([
      {
        id: "C1",
        threads: [
          thread(today(1), { mentionsMe: true }),
          thread(today(2), { mentionsMe: true, lastFromMe: true }), // I answered after the mention
          thread(today(3), { iPosted: true, lastIsQuestion: true }),
          thread(today(4), { iPosted: true, lastIsQuestion: true, lastFromMe: true }),
          thread(today(5), { lastIsQuestion: true }), // a question, but not in a thread I am in
        ],
      },
      { id: "D1", threads: [thread(today(6))] },
    ]),
    ctx(),
  );
  assert.deepEqual(
    data.threads.map((t) => t.needsYou),
    ["mentioned you", undefined, "question in a thread you're in", undefined, undefined, "waiting on your reply"],
  );
  const answered = fromInbox(swept([{ id: "D1", threads: [thread(today(6), { lastFromMe: true })] }]), ctx());
  assert.equal(answered.threads[0]!.needsYou, undefined);
});

test("a lone post by an app is noise and is left out, even when it names me, unless someone replied", () => {
  const data = fromInbox(
    swept([
      {
        id: "C1",
        threads: [
          thread(today(1), { fromApp: true, excerpt: "requested a review" }),
          thread(today(2), { fromApp: true, messageCount: 2, excerpt: "deploy failed" }),
          thread(today(3), { fromApp: true, mentionsMe: true, excerpt: "you requested a review" }),
          thread(today(4), { fromApp: true, messageCount: 3, mentionsMe: true, excerpt: "review requested" }),
        ],
      },
    ]),
    ctx(),
  );
  assert.deepEqual(
    data.threads.map((t) => [t.excerpt, t.needsYou]),
    [
      ["deploy failed", undefined],
      ["review requested", "mentioned you"], // a person named me in the replies
    ],
  );
});

test("alert channels are counted by title, today only, with the state read from the title", () => {
  const data = fromInbox(
    swept([
      {
        id: "C2",
        alerts: [
          { ts: today(10), title: "Triggered: 5xx rate on host-12345" },
          { ts: today(20), title: "Triggered: 5xx rate on host-67890" },
          { ts: today(30), title: "Recovered: queue depth" },
          { ts: SUNDAY, title: "Triggered: old news" },
        ],
      },
    ]),
    ctx(),
  );
  assert.deepEqual(
    data.alerts.C2!.map((r) => [r.title, r.count, r.state]),
    [
      ["Triggered: 5xx rate on host-#", 2, "firing"],
      ["Recovered: queue depth", 1, "resolved"],
    ],
  );
  assert.equal(data.threads.length, 0);
});

test("text is tidied and cut; missing pieces get safe defaults; a conversation that is not followed is ignored", () => {
  const data = fromInbox(
    swept([
      { id: "C1", threads: [{ ts: today(1), excerpt: `  spread   over\nlines ${"x".repeat(300)}`, summary: "  " }] },
      { id: "C999", threads: [thread(today(2))] },
    ]),
    ctx(),
  );
  const [t] = data.threads;
  assert.equal(data.threads.length, 1);
  assert.ok(t!.excerpt.startsWith("spread over lines x"));
  assert.equal(t!.excerpt.length, 200);
  assert.deepEqual([t!.authors, t!.messageCount, t!.latestTs, t!.summary], [[], 1, today(1), undefined]);
});

test("a file in the wrong shape is refused with a reason", () => {
  assert.throws(() => fromInbox(null, ctx()), /slack inbox/);
  assert.throws(() => fromInbox({}, ctx()), /conversations must be a list/);
  assert.throws(() => fromInbox(swept([{ threads: [] }]), ctx()), /conversations\[0\] needs an id/);
  assert.throws(() => fromInbox(swept([{ id: "C1", threads: [{ excerpt: "no ts" }] }]), ctx()), /conversations\[0\]\.threads\[0\] needs a ts/);
  assert.throws(() => fromInbox(swept([{ id: "C1", threads: [{ ts: "yesterday" }] }]), ctx()), /threads\[0\] needs a ts/);
  assert.throws(() => fromInbox(swept([{ id: "C2", alerts: [{ title: "no ts" }] }]), ctx()), /conversations\[0\]\.alerts\[0\] needs a ts/);
});

test("with the inbox transport, collect and doctor work from the dropped file", async () => {
  const c = ctx();
  assert.deepEqual(
    (await slack.doctor(c)).map((check) => [check.name, check.ok, check.fix]),
    [["inbox file", false, "run /slack-sweep in Claude, in this folder"]],
  );

  writeJson(c.paths.inbox("slack"), swept([{ id: "C1", threads: [thread(today(1), { mentionsMe: true, excerpt: "Can you <look>?" })] }, { id: "C2", alerts: [{ ts: today(5), title: "Triggered: A" }] }]));
  const good = await slack.doctor(c);
  assert.deepEqual(good.map((check) => [check.name, check.ok]), [["inbox file", true]]);
  assert.match(good[0]!.detail, /1 thread and 1 alert from 2 conversations/);

  const envelope = await collectSource(slack, c);
  assert.equal(envelope.ok, true);
  const panels = slack.panels(envelope.data as never, { ...view, config: c.config });
  assert.ok(panels[0]!.html.includes("Can you &lt;look&gt;?"));
  assert.ok(panels[1]!.html.includes("Triggered: A"));
  assert.equal(slack.attention(envelope.data as never, { ...view, config: c.config }).length, 1);
});

test("threads written only by muted authors (calendar reminders, review bots) are left out", () => {
  const c = contextWith({ ...SLACK_LOCAL, slack: { ...SLACK_LOCAL.slack, transport: "inbox", muteAuthors: ["Google Calendar", "cm github"] } });
  const data = fromInbox(
    swept([
      {
        id: "C1",
        threads: [
          thread(today(1), { authors: ["Google Calendar"], excerpt: "10 minutes until standup" }),
          thread(today(2), { authors: ["CM GitHub", "rusty"], messageCount: 2, excerpt: "review requested" }),
          thread(today(3), { authors: ["Sam"], excerpt: "hello" }),
        ],
      },
    ]),
    c,
  );
  assert.deepEqual(
    data.threads.map((t) => t.excerpt),
    ["review requested", "hello"],
  );
});

test("doctor names a swept file that is not valid JSON, and leaves it for me to fix", async () => {
  const c = ctx();
  const path = c.paths.inbox("slack");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{"conversations": [,]}');
  const [check] = await slack.doctor(c);
  assert.equal(check!.ok, false);
  assert.match(check!.detail, /not valid JSON/);
  assert.equal(readFileSync(path, "utf8"), '{"conversations": [,]}');
});

test("fed by hand, doctor also checks the Claude CLI when Refresh now is set to use it, and only then", async () => {
  const exec = fakeExec({ "claude auth status": { stdout: '{"loggedIn": true}' } });
  const off = await slack.doctor(contextWith({ slack: { transport: "inbox" } }, { exec }));
  assert.deepEqual(off.map((c) => c.name), ["inbox file"]);
  assert.equal(exec.calls.length, 0);

  const on = await slack.doctor(contextWith({ slack: { transport: "inbox" }, claudeReads: { onRefresh: true } }, { exec }));
  assert.deepEqual(on.map((c) => [c.name, c.ok]), [["inbox file", false], ["claude", true]]);
});
