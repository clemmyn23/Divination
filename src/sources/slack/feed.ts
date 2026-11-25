import { fileURLToPath } from "node:url";
import type { Context } from "../../core/types.ts";
import { runClaude } from "../../enrich/claude.ts";
import { sweepPlan } from "./inbox.ts";

// The Slack sweep that Refresh now can start: the same prompt as `/slack-sweep`, run
// headless. It differs from the hand-started sweep in how it delivers: it is given the
// plan rather than running a command for it, and it answers with what it read rather
// than writing a file, so the run needs no tools beyond the Slack connector's read-only ones.

const promptFile = fileURLToPath(new URL("../../../prompts/slack-sweep.md", import.meta.url));

const NOTE = `## This run

The dashboard started this run, so three things differ from the steps above:

- Do not run any command. The plan is your input: the JSON you were given.
- Do not write a file, and do not reply with a count. Your answer is what the file would hold: the JSON object in the shape above.
- If you could not read Slack at all (the connector is missing, or every call failed), answer \`{"error": "<why, in a few words>"}\` instead. Never answer with empty lists because calls failed. One conversation that fails is still just left out.`;

const text = { type: "string" };
const flag = { type: "boolean" };
const SCHEMA = {
  type: "object",
  properties: {
    conversations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: text,
          channelId: text,
          threads: {
            type: "array",
            items: {
              type: "object",
              properties: {
                ts: text,
                latestTs: text,
                authors: { type: "array", items: text },
                messageCount: { type: "number" },
                excerpt: text,
                summary: text,
                fromApp: flag,
                iPosted: flag,
                lastFromMe: flag,
                mentionsMe: flag,
                lastIsQuestion: flag,
              },
              required: ["ts"],
            },
          },
          alerts: { type: "array", items: { type: "object", properties: { ts: text, title: text }, required: ["ts"] } },
        },
        required: ["id"],
      },
    },
    error: text,
  },
};

/** Ask Claude to sweep Slack, in the plain shape `fromInbox` takes. Throws if Slack could not be read. */
export async function feed(ctx: Context): Promise<unknown> {
  const plan = sweepPlan(ctx);
  if (plan.conversations.length === 0) return { conversations: [] }; // nothing is followed, so there is nothing to ask
  const { model, tools } = ctx.config.slack.sweep;

  const answer = (await runClaude(ctx, {
    promptFile,
    note: NOTE,
    input: JSON.stringify(plan),
    model,
    schema: SCHEMA,
    allowedTools: tools,
    connectors: true,
    timeoutMs: ctx.config.claudeReads.timeoutMinutes * 60_000,
  })) as { conversations?: unknown; error?: unknown };

  const failed = (why: string) => new Error(`could not read Slack: ${why}`);
  if (typeof answer.error === "string" && answer.error.trim() !== "") throw failed(answer.error.trim());
  if (!Array.isArray(answer.conversations)) throw failed("the answer had no conversations list");
  const planned = new Set(plan.conversations.map((c) => c.id));
  const covered = answer.conversations.some((c) => typeof c === "object" && c !== null && planned.has((c as { id?: unknown }).id as string));
  if (!covered) throw failed(`the answer covered none of the ${planned.size} conversations`);
  return { conversations: answer.conversations };
}
