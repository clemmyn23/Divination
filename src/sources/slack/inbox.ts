import { startOfDay } from "../../core/time.ts";
import type { Context } from "../../core/types.ts";
import { countAlerts } from "./alerts.ts";
import { conversationsFromConfig, cut, isMuted, permalink } from "./normalise.ts";
import type { SlackData, SlackMessage, SlackThread } from "./types.ts";

// What a Slack sweep drops in `out/inbox/slack.json`. It is written by an LLM reading
// Slack through a connector, so it holds plain facts and nothing is trusted to be worked
// out already. See `prompts/slack-sweep.md`.
//
//   { "conversations": [
//       { "id": "C1",                      // as given in the plan
//         "channelId": "D03…",             // the real channel id, when it differs (direct messages)
//         "threads": [
//           { "ts": "1795503542.966719",   // the first message
//             "latestTs": "1795578529.080049",
//             "authors": ["Sam", "Ana"],
//             "messageCount": 3,
//             "excerpt": "the first message, up to 200 characters",
//             "summary": "one sentence, for threads of three or more messages",
//             "fromApp": false,            // the first message was posted by an app
//             "iPosted": false,            // I have a message in the thread
//             "lastFromMe": false,         // the last message is mine
//             "mentionsMe": false,         // a person's message after my last one mentions me
//             "lastIsQuestion": false } ], // the last message ends with a question mark
//         "alerts": [ { "ts": "…", "title": "the first line of the alert" } ] } ] }

const TS = /^\d+\.\d+$/;
const EXCERPT_MAX = 200;

/** What a sweep is told to read. Computed here so the reader does no date sums and parses no config. */
export interface SweepPlan {
  me: { id: string };
  /** Epoch seconds: read threads and direct messages from here. */
  windowOldest: string;
  /** Epoch seconds: read alert channels from here (the start of today). */
  todayOldest: string;
  /** Where to write the result, from the repo root. */
  file: string;
  conversations: { id: string; name: string; read: "threads" | "dm" | "alerts" }[];
}

export function sweepPlan(ctx: Context): SweepPlan {
  const now = ctx.now();
  return {
    me: { id: ctx.config.slack.userId },
    windowOldest: String(Math.floor(now / 1000 - ctx.config.slack.windowHours * 3600)),
    todayOldest: String(startOfDay(now, ctx.config.me.timezone) / 1000),
    file: "out/inbox/slack.json",
    conversations: conversationsFromConfig(ctx.config).map((c) => ({
      id: c.id,
      name: c.name,
      read: c.kind === "alerts" ? "alerts" : c.kind === "dm" ? "dm" : "threads",
    })),
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Turn the facts a sweep dropped into Slack data. Code, not the reader, decides what
 * needs me, which app posts are noise, and how alerts are counted. Conversations that
 * are not followed in config are ignored.
 */
export function fromInbox(dropped: unknown, ctx: Context): SlackData {
  if (!isObject(dropped)) throw new Error("slack inbox must be an object");
  if (!Array.isArray(dropped.conversations)) throw new Error("slack inbox: conversations must be a list");

  const { workspaceUrl, muteAuthors, alerts: patterns } = ctx.config.slack;
  const since = startOfDay(ctx.now(), ctx.config.me.timezone);
  const conversations = conversationsFromConfig(ctx.config);
  const followed = new Map(conversations.map((c) => [c.id, c]));

  const threads: SlackThread[] = [];
  const alerts: SlackData["alerts"] = {};
  for (const c of conversations) if (c.kind === "alerts") alerts[c.id] = [];

  dropped.conversations.forEach((raw: unknown, i: number) => {
    const at = `slack inbox: conversations[${i}]`;
    if (!isObject(raw) || typeof raw.id !== "string" || raw.id === "") throw new Error(`${at} needs an id`);
    const conversation = followed.get(raw.id);
    const linkId = typeof raw.channelId === "string" && raw.channelId !== "" ? raw.channelId : raw.id;

    const alertMessages: SlackMessage[] = (Array.isArray(raw.alerts) ? raw.alerts : []).map((a: unknown, j: number) => {
      if (!isObject(a) || typeof a.ts !== "string" || !TS.test(a.ts)) throw new Error(`${at}.alerts[${j}] needs a ts`);
      return { ts: a.ts, text: typeof a.title === "string" ? a.title : "" };
    });

    const read = (Array.isArray(raw.threads) ? raw.threads : []).map((t: unknown, j: number) => {
      if (!isObject(t) || typeof t.ts !== "string" || !TS.test(t.ts)) throw new Error(`${at}.threads[${j}] needs a ts`);
      return t as Record<string, unknown> & { ts: string };
    });

    if (!conversation) return;
    if (conversation.kind === "alerts") {
      alerts[conversation.id] = countAlerts(alertMessages, patterns, workspaceUrl, linkId, since);
      return;
    }

    for (const t of read) {
      const messageCount = typeof t.messageCount === "number" && t.messageCount >= 1 ? Math.floor(t.messageCount) : 1;
      const lastFromMe = t.lastFromMe === true;
      const mentionsMe = t.mentionsMe === true && !lastFromMe;
      if (t.fromApp === true && messageCount === 1) continue; // a lone app post is noise, even when it names me

      const reason = mentionsMe
        ? "mentioned you"
        : conversation.kind === "dm" && !lastFromMe
          ? "waiting on your reply"
          : t.iPosted === true && !lastFromMe && t.lastIsQuestion === true
            ? "question in a thread you're in"
            : undefined;
      const authors = Array.isArray(t.authors) ? t.authors.filter((a): a is string => typeof a === "string" && a !== "") : [];
      if (isMuted(authors, muteAuthors) && !reason) continue;
      const summary = typeof t.summary === "string" ? t.summary.replace(/\s+/g, " ").trim() : "";

      threads.push({
        channelId: conversation.id,
        ts: t.ts,
        url: permalink(workspaceUrl, linkId, t.ts),
        authors,
        excerpt: cut(typeof t.excerpt === "string" ? t.excerpt.replace(/\s+/g, " ").trim() : "", EXCERPT_MAX),
        text: "",
        messageCount,
        latestTs: typeof t.latestTs === "string" && TS.test(t.latestTs) ? t.latestTs : t.ts,
        ...(reason ? { needsYou: reason } : {}),
        ...(summary ? { summary } : {}),
      });
    }
  });

  return { conversations, threads, alerts };
}
