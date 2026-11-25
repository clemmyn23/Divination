import type { SlackConversation, SlackMessage } from "./types.ts";

const reactedBy = (m: SlackMessage, me: string) => (m.reactions ?? []).some((r) => r.users.includes(me));

/**
 * Why a thread is waiting on me, if it is. `messages` are in time order. Only what came
 * after my last message is looked at, and a message I reacted to counts as answered.
 *
 * 1. A person (not an app) mentioned me.
 * 2. It is a direct message and the last word is not mine.
 * 3. I am in the thread and the last message, not mine, ends with a question mark.
 */
export function needsYou(messages: SlackMessage[], me: string, kind: SlackConversation["kind"]): string | undefined {
  const last = messages[messages.length - 1];
  if (!last) return undefined;

  let myLast = -1;
  messages.forEach((m, i) => {
    if (m.user === me) myLast = i;
  });
  const since = messages.slice(myLast + 1).filter((m) => !reactedBy(m, me));

  const mention = new RegExp(`<@${me}[|>]`);
  // Only a person's mention counts. Apps name people in every notice they post.
  if (since.some((m) => m.bot_id === undefined && mention.test(m.text))) return "mentioned you";

  const open = last.user !== me && !reactedBy(last, me);
  if (kind === "dm" && open) return "waiting on your reply";
  if (myLast >= 0 && open && /\?\s*$/.test(last.text)) return "question in a thread you're in";
  return undefined;
}
