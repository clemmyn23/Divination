import type { Context } from "../../core/types.ts";
import { createSlack } from "./client.ts";
import { conversationsFromConfig, toThread } from "./normalise.ts";
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

/**
 * Read every configured conversation over the last `slack.windowHours` and turn it into
 * threads. Alert conversations produce no threads.
 */
export async function collectSlack(ctx: Context): Promise<SlackData> {
  const slack = createSlack(ctx);
  const { windowHours, workspaceUrl } = ctx.config.slack;
  const conversations = conversationsFromConfig(ctx.config);
  const oldest = String((ctx.now() - windowHours * 3_600_000) / 1000);

  const gathered = await mapLimited(conversations, (c) => gather(slack, c, oldest));

  const names: Record<string, string> = {};
  const threads: SlackThread[] = [];
  for (const { conversation, parents, threads: replies } of gathered) {
    if (conversation.kind === "alerts") continue;
    for (const parent of parents) {
      const messages = replies.get(parent.ts) ?? [parent];
      for (const m of messages) {
        if (m.user && names[m.user] === undefined) names[m.user] = await slack.userName(m.user);
      }
      threads.push(toThread(conversation, messages, names, workspaceUrl));
    }
  }

  return { conversations, threads, alerts: {} };
}
