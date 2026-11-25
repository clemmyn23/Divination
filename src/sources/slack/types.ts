/** A message as the Slack Web API returns it; only the fields this tool reads. */
export interface SlackMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
  reactions?: { name: string; users: string[] }[];
  attachments?: { title?: string; color?: string }[];
  blocks?: unknown[];
}

/** A channel or direct message the dashboard follows, with the config group it belongs to. */
export interface SlackConversation {
  id: string;
  name: string;
  group: string;
  kind: "channel" | "dm" | "alerts";
}

/** One top-level message and its replies. */
export interface SlackThread {
  channelId: string;
  ts: string;
  url: string;
  /** Display names, in order of first appearance. */
  authors: string[];
  /** The first message as plain text, at most 200 characters. */
  excerpt: string;
  /** Every message as `Name: text` lines, at most 4000 characters. Input for a summary. */
  text: string;
  messageCount: number;
  latestTs: string;
  /** Why this thread is waiting on me, when it is. */
  needsYou?: string;
}

export interface AlertCount {
  title: string;
  count: number;
  state: "firing" | "resolved" | "info";
  latestTs: string;
  url: string;
}

export interface SlackData {
  conversations: SlackConversation[];
  threads: SlackThread[];
  /** channel id -> today's alerts, counted by title */
  alerts: Record<string, AlertCount[]>;
}
