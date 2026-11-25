import type { Check, Context, Source } from "../../core/types.ts";
import { createSlack } from "./client.ts";
import { collectSlack } from "./collect.ts";
import { conversationsFromConfig } from "./normalise.ts";
import { slackPanels, threadKey, tsMs } from "./panel.ts";
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

async function doctor(ctx: Context): Promise<Check[]> {
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

/** Slack: the channels and direct messages named in `slack.groups`. */
export const slack: Source<SlackData> = {
  id: "slack",
  title: "Slack",
  doctor,
  collect: collectSlack,
  validate,
  attention: (data) => {
    const byId = new Map(data.conversations.map((c) => [c.id, c]));
    return data.threads
      .filter((t) => t.needsYou !== undefined)
      .map((t) => {
        const conversation = byId.get(t.channelId);
        const title = conversation ? (conversation.kind === "dm" ? conversation.name : `#${conversation.name}`) : t.channelId;
        return { key: threadKey(t), title, reason: t.needsYou!, url: t.url, at: tsMs(t.latestTs) };
      });
  },
  panels: slackPanels,
  enrichers: [slackSummary],
};
