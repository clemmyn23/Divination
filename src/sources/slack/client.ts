import { readJson, writeJson } from "../../core/store.ts";
import type { Context } from "../../core/types.ts";
import type { SlackMessage } from "./types.ts";

const API = "https://slack.com/api/";
const MAX_PAGES = 10;

interface SlackAnswer {
  ok: boolean;
  error?: string;
  response_metadata?: { next_cursor?: string };
}

/**
 * A read-only client for the Slack Web API, using the user token stored as the `slack`
 * secret. Slack answers 200 with `{ ok: false, error }` when a call fails; that becomes
 * `Error("slack: <error>")`. The token travels only in the Authorization header.
 */
export function createSlack(ctx: Context) {
  let token: string | undefined;
  const usersPath = ctx.paths.cache("slack", "users.json");
  let users: Record<string, string> | undefined;

  async function call<T extends SlackAnswer>(method: string, params: [string, string][]): Promise<T> {
    token ??= await ctx.secrets.get("slack");
    if (!token) throw new Error("no Slack token; run: divination secret set slack");
    const query = params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
    const { data } = await ctx.http.json<T>(`${API}${method}?${query}`, { headers: { authorization: `Bearer ${token}` } });
    if (!data.ok) throw new Error(`slack: ${data.error ?? "unknown error"}`);
    return data;
  }

  /** Every page of a call that returns `messages`. */
  async function messages(method: string, params: [string, string][]): Promise<SlackMessage[]> {
    const out: SlackMessage[] = [];
    let cursor = "";
    for (let page = 0; page < MAX_PAGES; page++) {
      const answer = await call<SlackAnswer & { messages?: SlackMessage[] }>(method, cursor ? [...params, ["cursor", cursor]] : params);
      out.push(...(answer.messages ?? []));
      cursor = answer.response_metadata?.next_cursor ?? "";
      if (!cursor) break;
    }
    return out;
  }

  return {
    /** Who the token belongs to. */
    async authTest(): Promise<{ userId: string; user: string; team: string }> {
      const a = await call<SlackAnswer & { user_id?: string; user?: string; team?: string }>("auth.test", []);
      return { userId: a.user_id ?? "", user: a.user ?? "", team: a.team ?? "" };
    },

    /** A conversation's messages since `oldest` (epoch seconds), newest first. */
    history(channel: string, oldest: string, limit = 200): Promise<SlackMessage[]> {
      return messages("conversations.history", [
        ["channel", channel],
        ["oldest", oldest],
        ["limit", String(limit)],
      ]);
    },

    /** A thread: the parent, then its replies in time order. */
    replies(channel: string, ts: string): Promise<SlackMessage[]> {
      return messages("conversations.replies", [
        ["channel", channel],
        ["ts", ts],
        ["limit", "200"],
      ]);
    },

    /** The channels I have posted in since `afterDate` (`YYYY-MM-DD`), each once, most recent first. */
    async searchFromMe(afterDate: string): Promise<{ id: string; name: string }[]> {
      const answer = await call<SlackAnswer & { messages?: { matches?: { channel?: { id?: string; name?: string } }[] } }>("search.messages", [
        ["query", `from:<@${ctx.config.slack.userId}> after:${afterDate}`],
        ["count", "100"],
      ]);
      const found = new Map<string, string>();
      for (const match of answer.messages?.matches ?? []) {
        const { id, name } = match.channel ?? {};
        if (id && !found.has(id)) found.set(id, name ?? id);
      }
      return [...found].map(([id, name]) => ({ id, name }));
    },

    /** A person's display name, remembered in the cache. Falls back to the id if Slack will not say. */
    async userName(id: string): Promise<string> {
      users ??= readJson<Record<string, string>>(usersPath, {});
      const known = users[id];
      if (known) return known;
      try {
        const a = await call<SlackAnswer & { user?: { real_name?: string; profile?: { display_name?: string; real_name?: string } } }>("users.info", [["user", id]]);
        const name = a.user?.profile?.display_name || a.user?.profile?.real_name || a.user?.real_name;
        if (!name) return id;
        users[id] = name;
        writeJson(usersPath, users);
        return name;
      } catch {
        return id;
      }
    },
  };
}
