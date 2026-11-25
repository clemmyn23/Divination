import type { Config } from "../../core/types.ts";
import { cut, permalink, plainText } from "./normalise.ts";
import type { AlertCount, SlackMessage } from "./types.ts";

type Patterns = Config["slack"]["alerts"];

const TITLE_MAX = 80;
const ORDER: Record<AlertCount["state"], number> = { firing: 0, resolved: 1, info: 2 };

const tsMs = (ts: string) => Number(ts) * 1000;

function rawTitle(m: SlackMessage): string {
  const fromAttachment = m.attachments?.find((a) => a.title)?.title;
  return fromAttachment ?? m.text.split("\n").find((line) => line.trim() !== "") ?? "";
}

/**
 * What an alert is called, so that repeats of it count together: the first attachment's
 * title, else the first line of text, with every run of three or more digits replaced
 * by `#` (ids, dates and counts differ between repeats).
 */
export function alertTitle(m: SlackMessage): string {
  const title = plainText(rawTitle(m), {})
    .replace(/\*/g, "")
    .replace(/:[a-z+-][a-z0-9_+-]*:/g, "") // emoji codes such as :red_circle:
    .replace(/\d{3,}/g, "#")
    .replace(/\s+/g, " ")
    .trim();
  return title === "" ? "(no title)" : cut(title, TITLE_MAX);
}

function matches(pattern: string, text: string): boolean {
  try {
    return pattern !== "" && new RegExp(pattern, "i").test(text);
  } catch {
    return false; // a pattern that is not a valid expression matches nothing
  }
}

/** `resolved` when it reads as a recovery; `firing` when it reads as a problem or is coloured red; else `info`. */
export function alertState(m: SlackMessage, patterns: Patterns): AlertCount["state"] {
  const text = `${(m.attachments ?? []).map((a) => a.title ?? "").join(" ")} ${m.text}`;
  if (matches(patterns.resolved, text)) return "resolved";
  const red = (m.attachments ?? []).some((a) => a.color === "danger" || /^#[de]/i.test(a.color ?? ""));
  return matches(patterns.firing, text) || red ? "firing" : "info";
}

/**
 * Today's alerts in one channel, counted by title. `since` is in epoch milliseconds. Each
 * row's state and link come from its newest message; firing rows come first, then the
 * most frequent.
 */
export function countAlerts(messages: SlackMessage[], patterns: Patterns, workspaceUrl: string, channelId: string, since: number): AlertCount[] {
  const rows = new Map<string, { count: number; newest: SlackMessage }>();
  for (const m of messages) {
    if (tsMs(m.ts) < since) continue;
    const title = alertTitle(m);
    const row = rows.get(title);
    if (!row) rows.set(title, { count: 1, newest: m });
    else {
      row.count++;
      if (tsMs(m.ts) > tsMs(row.newest.ts)) row.newest = m;
    }
  }
  return [...rows]
    .map(([title, { count, newest }]) => ({
      title,
      count,
      state: alertState(newest, patterns),
      latestTs: newest.ts,
      url: permalink(workspaceUrl, channelId, newest.ts),
    }))
    .sort((a, b) => ORDER[a.state] - ORDER[b.state] || b.count - a.count || a.title.localeCompare(b.title));
}
