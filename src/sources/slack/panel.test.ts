import assert from "node:assert/strict";
import { test } from "node:test";
import { NOW, view } from "../../../test/helpers.ts";
import { slack } from "./index.ts";
import { slackPanels } from "./panel.ts";
import type { SlackData, SlackThread } from "./types.ts";

// NOW is Wednesday 10:00 in Sydney; the day started at 2026-11-24T13:00:00Z.
const today = (minutesAfterMidnight: number) => `${Date.parse("2026-11-24T13:00:00Z") / 1000 + minutesAfterMidnight * 60}.000100`;
const OLD = "1795300000.000100"; // Sunday

function thread(channelId: string, ts: string, over: Partial<SlackThread> = {}): SlackThread {
  return {
    channelId,
    ts,
    url: `https://w.slack.com/archives/${channelId}/p${ts.replace(".", "")}`,
    authors: ["Sam", "Ana"],
    excerpt: `excerpt ${ts}`,
    text: "Sam: hi\nAna: hello",
    messageCount: 4,
    latestTs: ts,
    ...over,
  };
}

const DATA: SlackData = {
  conversations: [
    { id: "C1", name: "team-dev", group: "Team", kind: "channel" },
    { id: "D1", name: "Ana", group: "Team", kind: "dm" },
    { id: "C3", name: "ui-guild", group: "Starred", kind: "channel" },
    { id: "C2", name: "svc-alerts", group: "Alerts", kind: "alerts" },
    { id: "C4", name: "usage-reports", group: "Alerts", kind: "alerts" },
    { id: "C7", name: "deploys", group: "Posted in", kind: "channel" },
  ],
  threads: [
    thread("C1", OLD, { excerpt: "old quiet excerpt" }),
    thread("C1", "300.000100", { latestTs: today(60), excerpt: "Is the <build> broken?" }),
    thread("C1", "200.000100", { latestTs: OLD, needsYou: "mentioned you", excerpt: "Sam, can you confirm?" }),
    thread("C1", "400.000100", { latestTs: today(120), messageCount: 1, authors: ["Rio"], excerpt: "Staging is back." }),
    thread("D1", "500.000100", { latestTs: today(30), needsYou: "waiting on your reply", messageCount: 1, authors: ["Ana"], excerpt: "Ten minutes?" }),
    thread("C7", "600.000100", { latestTs: today(10), messageCount: 2, excerpt: "One message per release now." }),
  ],
  alerts: {
    C2: [
      { title: "Triggered: 5xx <rate>", count: 3, state: "firing", latestTs: today(90), url: "https://w.slack.com/archives/C2/p1" },
      { title: "Recovered: queue depth", count: 1, state: "resolved", latestTs: today(80), url: "https://w.slack.com/archives/C2/p2" },
    ],
    C4: [],
  },
};

const slackHtml = (v = view) => slackPanels(DATA, v).find((p) => p.id === "slack")!.html;

test("there are two panels: Slack in mint and alerts in lilac", () => {
  assert.deepEqual(
    slackPanels(DATA, view).map((p) => [p.id, p.title, p.tint]),
    [
      ["slack", "Slack", "mint"],
      ["alerts", "Alerts", "lilac"],
    ],
  );
});

test("panel shows today's threads, needs-you first, summary over excerpt", () => {
  const v = { ...view, enrich: { "slack-summary": { "C1:300.000100": "Build is fixed." } } };
  const html = slackHtml(v);
  assert.ok(html.indexOf('thread needs-you"') < html.indexOf("Build is fixed."));
  assert.ok(html.indexOf('thread needs-you"') >= 0);
  assert.ok(!html.includes("old quiet excerpt"));
  assert.ok(!html.includes("Is the &lt;build&gt; broken?")); // replaced by its summary
  assert.ok(slackHtml().includes('<button data-enrich="slack-summary" data-key="all">Summarise threads</button>'));
});

test("each thread is a linked title and one meta line that starts with where it is", () => {
  const html = slackHtml();
  assert.ok(
    html.includes(
      '<li class="item thread needs-you"><a href="https://w.slack.com/archives/C1/p200000100" target="_blank" rel="noopener noreferrer">Sam, can you confirm?</a>\n<p class="meta">#team-dev · Sam, Ana · 4 · mentioned you</p><button type="button" class="tick" data-done="slack:C1:200.000100@1795300000.000100" data-state="open"',
    ),
  );
  assert.ok(html.includes('<p class="meta">Ana · 1 · waiting on your reply</p>')); // a direct message has no #, and its name is the author
  assert.ok(html.includes("Is the &lt;build&gt; broken?"));
  assert.ok(html.includes('<p class="meta">#team-dev · Rio · 1</p>'));
});

test("groups come in config order with Posted in last, needs-you first then newest, and empty groups are left out", () => {
  const html = slackHtml();
  const order = ["Team</h3>", "Ten minutes?", "Sam, can you confirm?", "Staging is back.", "Is the &lt;build&gt; broken?", "Posted in</h3>", "One message per release now."];
  const at = order.map((piece) => html.indexOf(piece));
  assert.ok(at.every((i) => i >= 0), JSON.stringify(at));
  assert.deepEqual(at, [...at].sort((a, b) => a - b));
  assert.ok(!html.includes("Starred</h3>"));
  assert.ok(!html.includes("Alerts</h3>"));
});

test("the summarise button is offered only while a long enough thread has no summary", () => {
  const all = { "C1:300.000100": "a", "C1:200.000100": "b" };
  assert.ok(!slackHtml({ ...view, enrich: { "slack-summary": all } }).includes("data-enrich"));
  const none: SlackData = { ...DATA, threads: [thread("C1", "400.000100", { latestTs: today(120), messageCount: 2 })] };
  assert.ok(!slackPanels(none, view).find((p) => p.id === "slack")!.html.includes("data-enrich"));
});

test("a thread that came with its own summary shows it, and needs no button", () => {
  const data: SlackData = { ...DATA, threads: [thread("C1", "300.000100", { latestTs: today(60), summary: "Sam asked about the <build>; Ana fixed it." })] };
  const html = slackPanels(data, view).find((p) => p.id === "slack")!.html;
  assert.ok(html.includes("Sam asked about the &lt;build&gt;; Ana fixed it."));
  assert.ok(!html.includes("excerpt 300.000100"));
  assert.ok(!html.includes("data-enrich"));
});

test("a quiet day says so", () => {
  const html = slackPanels({ ...DATA, threads: [thread("C1", OLD)] }, view).find((p) => p.id === "slack")!.html;
  assert.equal(html, '<p class="quiet">Nothing new in Slack today.</p>');
});

test("when every thread is ticked off the panel says so, above the folded ones", () => {
  const one: SlackData = { ...DATA, threads: [thread("C1", "300.000100", { latestTs: today(60) })] };
  const done = { ...view, done: { [`slack:C1:300.000100@${today(60)}`]: NOW } };
  const html = slackPanels(one, done).find((p) => p.id === "slack")!.html;
  assert.ok(html.startsWith('<p class="quiet">Nothing left in Slack today.</p>\n<details class="stale done">'));

  // While something is still open, the line is not there.
  assert.ok(!slackPanels(one, view).find((p) => p.id === "slack")!.html.includes('class="quiet"'));
  const two: SlackData = { ...DATA, threads: [...one.threads, thread("C1", "400.000100", { latestTs: today(120) })] };
  assert.ok(!slackPanels(two, done).find((p) => p.id === "slack")!.html.includes('class="quiet"'));
});

test("alerts panel shows counts and quiet channels", () => {
  const html = slackPanels(DATA, view).find((p) => p.id === "alerts")!.html;
  assert.ok(html.includes("×3"));
  assert.ok(html.includes("quiet"));
  assert.ok(html.includes('<h4 class="conv">#svc-alerts</h4>'));
  assert.ok(
    html.includes(
      '<li class="alert state-firing"><span class="times">×3</span> <a href="https://w.slack.com/archives/C2/p1" target="_blank" rel="noopener noreferrer">Triggered: 5xx &lt;rate&gt;</a> <span class="state">firing</span><button type="button" class="tick"',
    ),
  );
  assert.ok(html.includes('<p class="quiet">Quiet today: #usage-reports</p>'));
  assert.ok(!html.includes('<h4 class="conv">#usage-reports</h4>'));
});

test("with no alert channels, or none firing, the alerts panel still says something", () => {
  const noChannels = slackPanels({ ...DATA, conversations: DATA.conversations.filter((c) => c.kind !== "alerts"), alerts: {} }, view).find((p) => p.id === "alerts")!.html;
  assert.equal(noChannels, '<p class="quiet">No alert channels are set up.</p>');
  const allQuiet = slackPanels({ ...DATA, alerts: {} }, view).find((p) => p.id === "alerts")!.html;
  assert.equal(allQuiet, '<p class="quiet">Quiet today: #svc-alerts, #usage-reports</p>');
});

test("every thread that needs me is an attention item, dated by its latest message", () => {
  assert.deepEqual(slack.attention(DATA, view), [
    { key: "C1:200.000100", title: "#team-dev", reason: "mentioned you", url: "https://w.slack.com/archives/C1/p200000100", at: 1795300000000, doneKey: "slack:C1:200.000100@1795300000.000100" },
    { key: "D1:500.000100", title: "Ana", reason: "waiting on your reply", url: "https://w.slack.com/archives/D1/p500000100", at: Number(today(30).split(".")[0]) * 1000, doneKey: `slack:D1:500.000100@${today(30)}` },
  ]);
  assert.ok(NOW > 0);
});

test("threads and alert rows carry ticks; done ones fold away and a new reply or a new alert brings them back", () => {
  const key = `slack:C1:300.000100@${today(60)}`;
  const open = slackHtml();
  assert.ok(open.includes(`data-done="${key}" data-state="open"`));

  const v = { ...view, done: { [key]: NOW, [`alert:C2:Recovered: queue depth@${today(80)}`]: NOW } };
  const html = slackHtml(v);
  const fold = html.slice(html.indexOf('<details class="stale done">'));
  assert.ok(fold.startsWith('<details class="stale done">\n<summary>Done · 1</summary>'));
  assert.ok(fold.includes("Is the &lt;build&gt; broken?"));
  assert.ok(!html.slice(0, html.indexOf('<details class="stale done">')).includes("Is the &lt;build&gt; broken?"));

  const alerts = slackPanels(DATA, v).find((p) => p.id === "alerts")!.html;
  const alertFold = alerts.slice(alerts.indexOf('<details class="stale done">'));
  assert.ok(alertFold.includes("Recovered: queue depth") && !alertFold.includes("Triggered: 5xx"));
  assert.ok(alerts.includes('data-done="alert:C2:Triggered: 5xx &lt;rate&gt;@' + today(90) + '" data-state="open"'));

  // A new reply moves latestTs, which changes the key.
  const replied: SlackData = { ...DATA, threads: DATA.threads.map((t) => (t.ts === "300.000100" ? { ...t, latestTs: today(200) } : t)) };
  assert.ok(!slackPanels(replied, v).find((p) => p.id === "slack")!.html.includes("Done ·"));
});

test("a done thread needs no summary button, and its needs-you item carries the same key", () => {
  const long: SlackData = { ...DATA, threads: [thread("C1", "300.000100", { latestTs: today(60), needsYou: "mentioned you" })] };
  const key = `slack:C1:300.000100@${today(60)}`;
  assert.ok(slackPanels(long, view).find((p) => p.id === "slack")!.html.includes("data-enrich"));
  assert.ok(!slackPanels(long, { ...view, done: { [key]: NOW } }).find((p) => p.id === "slack")!.html.includes("data-enrich"));
  assert.equal(slack.attention(long, view)[0]!.doneKey, key);
});

test("with a team id set, thread, alert and needs-you links open the Slack app; without one they stay web links", () => {
  const v = { ...view, config: { ...view.config, slack: { ...view.config.slack, teamId: "T02ABC" } } };
  const [slackPanel, alertsPanel] = slackPanels(DATA, v);
  assert.ok(slackPanel!.html.includes('<a href="slack://channel?team=T02ABC&amp;id=C1&amp;message=200.000100">Sam, can you confirm?</a>'));
  assert.ok(!slackPanel!.html.includes("https://w.slack.com"));
  // The alert links in this fixture are not real message links, so they stay as they are.
  assert.ok(alertsPanel!.html.includes('href="https://w.slack.com/archives/C2/p1"'));
  assert.equal(slack.attention(DATA, v)[0]!.url, "slack://channel?team=T02ABC&id=C1&message=200.000100");

  assert.ok(slackHtml().includes('href="https://w.slack.com/archives/C1/p200000100" target="_blank"'));
  assert.equal(slack.attention(DATA, view)[0]!.url, "https://w.slack.com/archives/C1/p200000100");
});
