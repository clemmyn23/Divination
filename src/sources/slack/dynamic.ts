import type { SlackConversation } from "./types.ts";

/** The group that channels I posted in recently are listed under. */
export const POSTED_IN = "Posted in";

/**
 * Channels I posted in lately that are not already followed. `exclude` holds channel ids
 * or names to leave out. Direct messages are left out: they are followed by name, in config.
 */
export function dynamicConversations(found: { id: string; name: string }[], configured: SlackConversation[], exclude: string[]): SlackConversation[] {
  const skip = new Set(configured.map((c) => c.id));
  const out: SlackConversation[] = [];
  for (const { id, name } of found) {
    if (skip.has(id) || id.startsWith("D") || exclude.includes(id) || exclude.includes(name)) continue;
    skip.add(id);
    out.push({ id, name, group: POSTED_IN, kind: "channel" });
  }
  return out;
}
