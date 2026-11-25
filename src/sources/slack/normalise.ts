import type { Config } from "../../core/types.ts";
import type { SlackConversation, SlackMessage, SlackThread } from "./types.ts";

const EXCERPT_MAX = 200;
const TEXT_MAX = 4000;

/** A link that opens the message in Slack. `threadTs` is the parent's `ts` when the message is a reply. */
export function permalink(workspaceUrl: string, channelId: string, ts: string, threadTs?: string): string {
  const base = `${workspaceUrl.replace(/\/+$/, "")}/archives/${channelId}/p${ts.replace(".", "")}`;
  return threadTs ? `${base}?thread_ts=${threadTs}&cid=${channelId}` : base;
}

/**
 * The same message as a link that opens the Slack app directly, skipping the browser's
 * "open in Slack?" page. Needs the workspace's team id (`slack.teamId`); without one, or
 * for anything that is not a message link, the URL is returned unchanged.
 */
export function appLink(url: string, teamId: string): string {
  if (!/^[A-Z0-9]+$/.test(teamId)) return url;
  const m = /^https:\/\/[^/]+\/archives\/([A-Z0-9]+)\/p(\d+)(\d{6})(?:\?thread_ts=(\d+\.\d+))?/.exec(url);
  if (!m) return url;
  const [, channel, seconds, micros, thread] = m;
  return `slack://channel?team=${teamId}&id=${channel}&message=${seconds}.${micros}${thread ? `&thread_ts=${thread}` : ""}`;
}

/** Slack's message markup as the text a person would read: mentions, links, channels and entities. */
export function plainText(text: string, names: Record<string, string>): string {
  return text
    .replace(/<@([A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, label?: string) => `@${names[id] ?? (label || id)}`)
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<!(?:subteam\^[A-Z0-9]+\|)?@?([^>|]+)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<((?:https?|mailto):[^>|]+)\|([^>]*)>/g, "$2")
    .replace(/<((?:https?|mailto):[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** At most `max` characters, ending in an ellipsis when something was cut. */
export function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const authorOf = (m: SlackMessage, names: Record<string, string>) => (m.user ? (names[m.user] ?? m.user) : (m.bot_id ?? "unknown"));

/** One thread from its messages: the parent first, then its replies in time order. */
export function toThread(conv: SlackConversation, messages: SlackMessage[], names: Record<string, string>, workspaceUrl: string): SlackThread {
  const parent = messages[0]!;
  const authors: string[] = [];
  for (const m of messages) {
    const name = authorOf(m, names);
    if (!authors.includes(name)) authors.push(name);
  }
  return {
    channelId: conv.id,
    ts: parent.ts,
    url: permalink(workspaceUrl, conv.id, parent.ts),
    authors,
    excerpt: cut(plainText(parent.text, names).replace(/\s+/g, " ").trim(), EXCERPT_MAX),
    text: messages.map((m) => `${authorOf(m, names)}: ${m.text}`).join("\n").slice(0, TEXT_MAX),
    messageCount: messages.length,
    latestTs: messages[messages.length - 1]!.ts,
  };
}

/** True when everyone who wrote in the thread is on the mute list (names compare without case). */
export function isMuted(authors: string[], muteAuthors: string[]): boolean {
  const muted = new Set(muteAuthors.map((name) => name.toLowerCase()));
  return authors.length > 0 && authors.every((name) => muted.has(name.toLowerCase()));
}

/** Every conversation named in `slack.groups`, in config order. One listed twice keeps its first group. */
export function conversationsFromConfig(config: Config): SlackConversation[] {
  const seen = new Set<string>();
  const out: SlackConversation[] = [];
  for (const group of config.slack.groups) {
    for (const c of group.conversations) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push({ id: c.id, name: c.name, group: group.name, kind: group.kind === "alerts" ? "alerts" : c.dm ? "dm" : "channel" });
    }
  }
  return out;
}
