import { startOfDay } from "../../core/time.ts";
import type { Panel, View } from "../../core/types.ts";
import { esc, link } from "../../render/html.ts";
import type { SlackConversation, SlackData, SlackThread } from "./types.ts";

/** The cache key, attention key and summary key of a thread. */
export const threadKey = (t: SlackThread) => `${t.channelId}:${t.ts}`;

/** A Slack timestamp (`seconds.micros`) in epoch milliseconds. */
export const tsMs = (ts: string) => Number(ts.split(".")[0]) * 1000;

/** A thread is on the page when something happened in it today, or it is waiting on me. */
export function isShown(thread: SlackThread, now: number, tz: string): boolean {
  return thread.needsYou !== undefined || tsMs(thread.latestTs) >= startOfDay(now, tz);
}

const where = (c: SlackConversation) => (c.kind === "dm" ? c.name : `#${c.name}`);

function threadItem(thread: SlackThread, conversation: SlackConversation, view: View): string {
  const summary = view.enrich["slack-summary"]?.[threadKey(thread)];
  const title = (typeof summary === "string" && summary !== "" ? summary : thread.summary) || thread.excerpt || "(no text)";
  // A direct message is named after the other person, so listing the authors would repeat it.
  const authors = conversation.kind === "dm" ? [] : [esc(thread.authors.join(", "))];
  const meta = [esc(where(conversation)), ...authors, String(thread.messageCount), ...(thread.needsYou ? [esc(thread.needsYou)] : [])];
  return `<li class="item thread${thread.needsYou ? " needs-you" : ""}">${link(title, thread.url)}
<p class="meta">${meta.join(" · ")}</p></li>`;
}

function slackPanel(data: SlackData, view: View): string {
  const tz = view.config.me.timezone;
  const byId = new Map(data.conversations.map((c) => [c.id, c]));
  const shown = data.threads.filter((t) => byId.has(t.channelId) && byId.get(t.channelId)!.kind !== "alerts" && isShown(t, view.now, tz));
  if (shown.length === 0) return '<p class="quiet">Nothing new in Slack today.</p>';

  // Groups in the order their conversations are listed, which is config order with "Posted in" last.
  const groups = [...new Set(data.conversations.filter((c) => c.kind !== "alerts").map((c) => c.group))];
  const parts: string[] = [];

  const min = view.config.slack.summary.minMessages;
  const summaries = view.enrich["slack-summary"] ?? {};
  const unsummarised = shown.some((t) => t.messageCount >= min && t.text !== "" && !t.summary && summaries[threadKey(t)] === undefined);
  if (unsummarised) parts.push('<button data-enrich="slack-summary" data-key="all">Summarise threads</button>');

  for (const group of groups) {
    const threads = shown
      .filter((t) => byId.get(t.channelId)!.group === group)
      .sort((a, b) => Number(b.needsYou !== undefined) - Number(a.needsYou !== undefined) || tsMs(b.latestTs) - tsMs(a.latestTs) || b.latestTs.localeCompare(a.latestTs));
    if (threads.length === 0) continue;
    parts.push(`<h3 class="group">${esc(group)}</h3>
<ul class="items">
${threads.map((t) => threadItem(t, byId.get(t.channelId)!, view)).join("\n")}
</ul>`);
  }
  return parts.join("\n");
}

function alertsPanel(data: SlackData): string {
  const channels = data.conversations.filter((c) => c.kind === "alerts");
  if (channels.length === 0) return '<p class="quiet">No alert channels are set up.</p>';

  const parts: string[] = [];
  const quiet: string[] = [];
  for (const channel of channels) {
    const rows = data.alerts[channel.id] ?? [];
    if (rows.length === 0) {
      quiet.push(`#${channel.name}`);
      continue;
    }
    parts.push(`<h4 class="conv">#${esc(channel.name)}</h4>
<ul class="alert-rows">
${rows.map((r) => `<li class="alert state-${r.state}"><span class="times">×${r.count}</span> ${link(r.title, r.url)} <span class="state">${r.state}</span></li>`).join("\n")}
</ul>`);
  }
  if (quiet.length > 0) parts.push(`<p class="quiet">Quiet today: ${esc(quiet.join(", "))}</p>`);
  return parts.join("\n");
}

/**
 * Two panels. Slack: today's threads by group, the ones waiting on me first, each a
 * title and one meta line. Alerts: each alert channel's alerts counted by title, with
 * the channels that had none today named on one closing line.
 */
export function slackPanels(data: SlackData, view: View): Panel[] {
  return [
    { id: "slack", title: "Slack", tint: "mint", html: slackPanel(data, view) },
    { id: "alerts", title: "Alerts", tint: "lilac", html: alertsPanel(data) },
  ];
}
