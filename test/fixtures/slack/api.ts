// Invented Slack Web API answers, in the shapes the real API returns.
import type { SlackMessage } from "../../../src/sources/slack/types.ts";

export const API = "https://slack.com/api/";

export const SLACK_LOCAL = {
  slack: {
    workspaceUrl: "https://w.slack.com",
    userId: "ME",
    groups: [
      { name: "Team", kind: "digest", conversations: [{ id: "C1", name: "team-dev" }, { id: "D1", name: "Ana", dm: true }] },
      { name: "Alerts", kind: "alerts", conversations: [{ id: "C2", name: "svc-alerts" }] },
    ],
  },
};

const PARENT: SlackMessage = { ts: "1795550000.000200", user: "U1", text: "Is the build broken?", thread_ts: "1795550000.000200", reply_count: 2, latest_reply: "1795560000.000300" };
const REPLY_1: SlackMessage = { ts: "1795555000.000250", user: "U2", text: "Looking", thread_ts: "1795550000.000200" };
const REPLY_2: SlackMessage = { ts: "1795560000.000300", user: "U1", text: "Thanks", thread_ts: "1795550000.000200" };

const user = (id: string, display: string, real = display) => ({ ok: true, user: { id, real_name: real, profile: { display_name: display, real_name: real } } });

/** Routes for `fakeHttp`. History comes newest first, as Slack sends it. */
export function slackRoutes(): Record<string, unknown> {
  return {
    [`${API}auth.test`]: { ok: true, user_id: "ME", user: "me", team: "W" },
    // C1: a plain message, a parent with two replies, and a copy of a reply that was also sent to the channel
    [`${API}conversations.history?channel=C1`]: { ok: true, messages: [{ ...REPLY_2, subtype: "thread_broadcast" }, PARENT, { ts: "1795540000.000100", user: "U2", text: "Staging is back." }] },
    [`${API}conversations.replies?channel=C1&ts=1795550000.000200`]: { ok: true, messages: [PARENT, REPLY_1, REPLY_2] },
    [`${API}conversations.history?channel=D1`]: { ok: true, messages: [{ ts: "1795561000.000400", user: "U2", text: "Do you have ten minutes?" }] },
    [`${API}conversations.history?channel=C2`]: {
      ok: true,
      messages: [
        { ts: "1795562000.000500", bot_id: "B1", text: "", attachments: [{ title: "Triggered: 5xx rate on checkout", color: "danger" }] },
        { ts: "1795300000.000100", bot_id: "B1", text: "Recovered: queue depth" },
      ],
    },
    [`${API}users.info?user=U1`]: user("U1", "Sam"),
    [`${API}users.info?user=U2`]: user("U2", "", "Ana Lopez"),
    [`${API}search.messages`]: { ok: true, messages: { matches: [{ channel: { id: "C7", name: "deploys" } }, { channel: { id: "C1", name: "team-dev" } }, { channel: { id: "C7", name: "deploys" } }] } },
  };
}
