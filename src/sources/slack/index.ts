import { readJson } from "../../core/store.ts";
import type { Check, Context, Source } from "../../core/types.ts";
import { createSlack } from "./client.ts";
import { collectSlack } from "./collect.ts";
import { fromInbox } from "./inbox.ts";
import { appLink, conversationsFromConfig } from "./normalise.ts";
import { slackPanels, threadDoneKey, threadKey, tsMs } from "./panel.ts";
import { slackSummary } from "./summary.enricher.ts";
import type { SlackData } from "./types.ts";

const SET_IT = "create the app from docs/slack-app-manifest.json, install it, then run: divination secret set slack";

function validate(data: unknown): string[] {
  if (typeof data !== "object" || data === null) return ["slack data must be an object"];
  const d = data as Partial<Record<keyof SlackData, unknown>>;
  const problems: string[] = [];
  if (!Array.isArray(d.conversations)) problems.push("conversations must be a list");
  if (!Array.isArray(d.threads)) problems.push("threads must be a list");
  if (typeof d.alerts !== "object" || d.alerts === null || Array.isArray(d.alerts)) problems.push("alerts must be an object");
  return problems;
}

/** For the inbox transport: is there a swept file, and can it be read? */
function inboxCheck(ctx: Context): Check {
  const fix = "run /slack-sweep in Claude, in this folder";
  const dropped = readJson<unknown>(ctx.paths.inbox("slack"), null);
  if (dropped === null) return { name: "inbox file", ok: false, detail: "nothing has been swept into out/inbox/slack.json yet", fix };
  try {
    const data = fromInbox(dropped, ctx);
    const followed = new Set(data.conversations.map((c) => c.id));
    const swept = ((dropped as { conversations: { id: string }[] }).conversations ?? []).filter((c) => followed.has(c.id)).length;
    const alerts = Object.values(data.alerts).reduce((sum, rows) => sum + rows.reduce((n, row) => n + row.count, 0), 0);
    const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
    return { name: "inbox file", ok: true, detail: `${count(data.threads.length, "thread")} and ${count(alerts, "alert")} from ${count(swept, "conversation")}` };
  } catch (e) {
    return { name: "inbox file", ok: false, detail: e instanceof Error ? e.message : String(e), fix };
  }
}

async function doctor(ctx: Context): Promise<Check[]> {
  if (ctx.config.slack.transport === "inbox") return [inboxCheck(ctx)];
  if (!(await ctx.secrets.get("slack"))) {
    return [{ name: "token", ok: false, detail: "no Slack token is stored", fix: SET_IT }];
  }
  const checks: Check[] = [{ name: "token", ok: true, detail: "a Slack token is stored" }];
  const slack = createSlack(ctx);

  try {
    const who = await slack.authTest();
    checks.push({ name: "sign-in", ok: true, detail: `signed in as ${who.user} in ${who.team}` });
  } catch (e) {
    checks.push({ name: "sign-in", ok: false, detail: e instanceof Error ? e.message : String(e), fix: SET_IT });
    return checks;
  }

  const { userId, workspaceUrl } = ctx.config.slack;
  const missing = [...(userId ? [] : ["slack.userId"]), ...(workspaceUrl ? [] : ["slack.workspaceUrl"])];
  checks.push(
    missing.length === 0
      ? { name: "config", ok: true, detail: `${userId} at ${workspaceUrl}` }
      : { name: "config", ok: false, detail: `${missing.join(" and ")} not set`, fix: "set them under \"slack\" in config/local.json" },
  );

  const conversations = conversationsFromConfig(ctx.config);
  const failed: string[] = [];
  for (const c of conversations) {
    try {
      await slack.history(c.id, "0", 1);
    } catch (e) {
      failed.push(`${c.name} (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  checks.push(
    failed.length === 0
      ? { name: "conversations", ok: true, detail: `${conversations.length} conversations can be read` }
      : { name: "conversations", ok: false, detail: `cannot read: ${failed.join(", ")}`, fix: "check the ids under slack.groups in config/local.json" },
  );
  return checks;
}

/**
 * Slack: the channels and direct messages named in `slack.groups`, read through the Web
 * API or, with the inbox transport, from the file a sweep dropped (`prompts/slack-sweep.md`).
 */
export const slack: Source<SlackData> = {
  id: "slack",
  title: "Slack",
  doctor,
  collect: collectSlack,
  fromInbox,
  validate,
  attention: (data, view) => {
    const byId = new Map(data.conversations.map((c) => [c.id, c]));
    return data.threads
      .filter((t) => t.needsYou !== undefined)
      .map((t) => {
        const conversation = byId.get(t.channelId);
        const title = conversation ? (conversation.kind === "dm" ? conversation.name : `#${conversation.name}`) : t.channelId;
        return { key: threadKey(t), title, reason: t.needsYou!, url: appLink(t.url, view.config.slack.teamId), at: tsMs(t.latestTs), doneKey: threadDoneKey(t) };
      });
  },
  panels: slackPanels,
  enrichers: [slackSummary],
};
