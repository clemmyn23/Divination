import { isoDate, startOfDay } from "../../core/time.ts";
import type { Context } from "../../core/types.ts";
import { countAlerts } from "./alerts.ts";
import { createSlack } from "./client.ts";
import { dynamicConversations } from "./dynamic.ts";
import { needsYou } from "./needs-you.ts";
import { conversationsFromConfig, isMuted, toThread } from "./normalise.ts";
import type { SlackConversation, SlackData, SlackMessage, SlackThread } from "./types.ts";

const AT_ONCE = 4;

/** Run `fn` over `items`, a few at a time, keeping the results in order. */
async function mapLimited<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(AT_ONCE, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/** True for a top-level message; false for a reply that also shows in the channel timeline. */
const isParent = (m: SlackMessage) => m.thread_ts === undefined || m.thread_ts === m.ts;

export interface Gathered {
  conversation: SlackConversation;
  /** Top-level messages, oldest first. */
  parents: SlackMessage[];
  /** parent ts -> the whole thread, for parents that have replies */
  threads: Map<string, SlackMessage[]>;
}

/** Read one conversation's recent history, and the replies of each message that has any. */
async function gather(slack: ReturnType<typeof createSlack>, conversation: SlackConversation, oldest: string): Promise<Gathered> {
  const parents = (await slack.history(conversation.id, oldest)).filter(isParent).reverse();
  const threads = new Map<string, SlackMessage[]>();
  if (conversation.kind !== "alerts") {
    for (const parent of parents) {
      if ((parent.reply_count ?? 0) > 0) threads.set(parent.ts, await slack.replies(conversation.id, parent.ts));
    }
  }
  return { conversation, parents, threads };
}

const DAY = 86_400_000;

/**
 * A direct message is one running conversation, not a set of threads: what matters is
 * whether the last word is mine. It becomes a single thread made of whatever was said
 * since I last spoke (or just my last message, when I spoke last).
 */
function dmThread(conversation: SlackConversation, messages: SlackMessage[], me: string, names: Record<string, string>, workspaceUrl: string): SlackThread {
  let myLast = -1;
  messages.forEach((m, i) => {
    if (m.user === me) myLast = i;
  });
  const unanswered = messages.slice(myLast + 1);
  const thread = toThread(conversation, unanswered.length > 0 ? unanswered : [messages[messages.length - 1]!], names, workspaceUrl);
  const reason = needsYou(messages, me, "dm");
  return reason ? { ...thread, needsYou: reason } : thread;
}

/**
 * Read every configured conversation over the last `slack.windowHours`, plus the channels
 * I posted in lately, and turn them into threads, each checked for whether it is waiting
 * on me. Alert conversations produce no threads; today's alerts are counted by title.
 */
export async function collectSlack(ctx: Context): Promise<SlackData> {
  const slack = createSlack(ctx);
  const { windowHours, workspaceUrl, userId, dynamic, muteAuthors, alerts: patterns } = ctx.config.slack;
  const tz = ctx.config.me.timezone;
  const now = ctx.now();
  const configured = conversationsFromConfig(ctx.config);
  const oldest = String((now - windowHours * 3_600_000) / 1000);

  // Channels I posted in lately. Search needs its own scope; without it, carry on without them.
  let posted: SlackConversation[] = [];
  try {
    const found = await slack.searchFromMe(isoDate(now - dynamic.postedWithinDays * DAY, tz));
    posted = dynamicConversations(found, configured, dynamic.exclude);
  } catch {
    posted = [];
  }

  const gathered = [
    ...(await mapLimited(configured, (c) => gather(slack, c, oldest))),
    // A posted-in channel that cannot be read is left out rather than failing everything.
    ...(await mapLimited(posted, (c) => gather(slack, c, oldest).catch(() => undefined))).filter((g): g is Gathered => g !== undefined),
  ];

  const names: Record<string, string> = {};
  const learn = async (messages: SlackMessage[]) => {
    for (const m of messages) {
      if (m.user && names[m.user] === undefined) names[m.user] = await slack.userName(m.user);
    }
  };

  const threads: SlackThread[] = [];
  const alerts: SlackData["alerts"] = {};
  for (const { conversation, parents, threads: replies } of gathered) {
    if (conversation.kind === "alerts") {
      alerts[conversation.id] = countAlerts(parents, patterns, workspaceUrl, conversation.id, startOfDay(now, tz));
      continue;
    }
    if (conversation.kind === "dm") {
      if (parents.length === 0) continue;
      await learn(parents);
      threads.push(dmThread(conversation, parents, userId, names, workspaceUrl));
      continue;
    }
    for (const parent of parents) {
      const messages = replies.get(parent.ts) ?? [parent];
      const reason = needsYou(messages, userId, conversation.kind);
      // A lone post by an app (a review request, a deploy notice) is noise.
      if (parent.bot_id && messages.length === 1) continue;
      await learn(messages);
      const thread = toThread(conversation, messages, names, workspaceUrl);
      if (isMuted(thread.authors, muteAuthors) && !reason) continue;
      threads.push(reason ? { ...thread, needsYou: reason } : thread);
    }
  }

  return { conversations: gathered.map((g) => g.conversation), threads, alerts };
}
