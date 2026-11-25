import { readJson } from "../../core/store.ts";
import type { Context } from "../../core/types.ts";
import { createSlack } from "../slack/client.ts";
import { permalink } from "../slack/normalise.ts";
import type { SlackMessage } from "../slack/types.ts";
import type { Signal } from "./types.ts";

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Everything in a post a link could be in: apps often put it in an attachment or a block, not the text. */
const haystack = (post: SlackMessage) => `${post.text} ${JSON.stringify(post.attachments ?? [])} ${JSON.stringify(post.blocks ?? [])}`;

/**
 * What the review channel says about a PR. Posts that link to the PR are looked at
 * newest first, and the first one that says something wins:
 *
 * 1. a stop sign means it is not for this crew: skip;
 * 2. eyes from someone other than me means it is already picked up: skip;
 * 3. replies under the post mean there is a discussion worth reading: flag.
 *
 * Only reactions named in `skipReactions` count.
 */
export function findSignal(
  prUrl: string,
  posts: SlackMessage[],
  me: string,
  skipReactions: string[],
  names: Record<string, string>,
  linkFor: (ts: string) => string,
): Signal | undefined {
  // `/pull/1` must not match `/pull/11`.
  const link = new RegExp(`${escapeRegExp(prUrl)}(?!\\d)`);
  const about = posts.filter((post) => link.test(haystack(post))).sort((a, b) => Number(b.ts) - Number(a.ts));

  for (const post of about) {
    const reaction = (name: string) => (skipReactions.includes(name) ? post.reactions?.find((r) => r.name === name) : undefined);
    const url = linkFor(post.ts);

    if (reaction("octagonal_sign")) return { kind: "skip", reason: "not for this crew (:octagonal_sign:)", url };

    const others = (reaction("eyes")?.users ?? []).filter((user) => user !== me);
    if (others.length > 0) return { kind: "skip", reason: `already picked up by ${others.map((user) => names[user] ?? user).join(", ")}`, url };

    const replies = post.reply_count ?? 0;
    if (replies > 0) return { kind: "flag", reason: `${replies} ${replies === 1 ? "reply" : "replies"} in the review thread`, url };
  }
  return undefined;
}

export interface ReviewPosts {
  posts: SlackMessage[];
  names: Record<string, string>;
  linkFor(ts: string): string;
}

/** The review posts a hand-started sweep dropped in Slack's inbox file, under `reviewPosts`. */
function fromSweep(ctx: Context): Pick<ReviewPosts, "posts" | "names"> {
  const file = readJson<{ reviewPosts?: unknown } | null>(ctx.paths.inbox("slack"), null);
  const posts: SlackMessage[] = [];
  const names: Record<string, string> = {};
  for (const raw of Array.isArray(file?.reviewPosts) ? file.reviewPosts : []) {
    if (typeof raw !== "object" || raw === null) continue;
    const p = raw as { ts?: unknown; text?: unknown; replyCount?: unknown; reactions?: unknown };
    if (typeof p.ts !== "string" || typeof p.text !== "string") continue;

    const reactions: NonNullable<SlackMessage["reactions"]> = [];
    for (const r of Array.isArray(p.reactions) ? (p.reactions as { name?: unknown; users?: unknown }[]) : []) {
      if (typeof r?.name !== "string" || !Array.isArray(r.users)) continue;
      const users: string[] = [];
      for (const user of r.users as unknown[]) {
        if (typeof user === "string") users.push(user);
        else if (typeof user === "object" && user !== null && typeof (user as { id?: unknown }).id === "string") {
          const { id, name } = user as { id: string; name?: unknown };
          users.push(id);
          if (typeof name === "string" && name !== "") names[id] = name;
        }
      }
      reactions.push({ name: r.name.replace(/:/g, ""), users });
    }
    posts.push({ ts: p.ts, text: p.text, reply_count: typeof p.replyCount === "number" ? p.replyCount : 0, reactions });
  }
  return { posts, names };
}

/**
 * The recent posts in the review channel, with the names of the people who reacted to
 * them. They come from Slack's inbox file when Slack is fed by hand, otherwise from the
 * Web API. No review channel, no token or a failing call all give no posts: signals are
 * a nicety, and the queue must still load without them.
 */
export async function reviewPosts(ctx: Context): Promise<ReviewPosts> {
  const { channelId } = ctx.config.github.slackSignal;
  const linkFor = (ts: string) => permalink(ctx.config.slack.workspaceUrl, channelId, ts);
  const none: ReviewPosts = { posts: [], names: {}, linkFor };
  if (!channelId) return none;

  try {
    if (ctx.config.slack.transport === "inbox") return { ...fromSweep(ctx), linkFor };
    if (!(await ctx.secrets.get("slack"))) return none;

    const slack = createSlack(ctx);
    const oldest = String((ctx.now() - ctx.config.slack.windowHours * 3_600_000) / 1000);
    const posts = await slack.history(channelId, oldest);
    const names: Record<string, string> = {};
    for (const post of posts) {
      for (const reaction of post.reactions ?? []) {
        for (const user of reaction.users) names[user] ??= await slack.userName(user);
      }
    }
    return { posts, names, linkFor };
  } catch {
    return none;
  }
}
