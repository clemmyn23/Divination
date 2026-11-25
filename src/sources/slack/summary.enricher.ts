import { fileURLToPath } from "node:url";
import type { Enricher } from "../../core/types.ts";
import { hashOf } from "../../enrich/cache.ts";
import { runClaude } from "../../enrich/claude.ts";
import { isShown, threadKey } from "./panel.ts";
import type { SlackData } from "./types.ts";

const promptFile = fileURLToPath(new URL("../../../prompts/slack-summary.md", import.meta.url));

const schema = {
  type: "object",
  required: ["summaries"],
  properties: {
    summaries: {
      type: "array",
      items: { type: "object", required: ["key", "summary"], properties: { key: { type: "string" }, summary: { type: "string" } } },
    },
  },
};

/**
 * One-line summaries for the threads on the page that are long enough to be worth it.
 * A summary is cached by the thread's text, so a thread that grows is summarised again.
 * All waiting threads go to the model in a single call, with no tools.
 */
export const slackSummary: Enricher<SlackData> = {
  id: "slack-summary",

  items(data, ctx) {
    const min = ctx.config.slack.summary.minMessages;
    return data.threads
      .filter((t) => t.messageCount >= min && t.text !== "" && !t.summary && isShown(t, ctx.now(), ctx.config.me.timezone))
      .map((t) => ({ key: threadKey(t), hash: hashOf(t.text), input: { text: t.text } }));
  },

  async run(items, ctx) {
    const answer = await runClaude(ctx, {
      promptFile,
      input: JSON.stringify(items.map((item) => ({ key: item.key, text: (item.input as { text: string }).text }))),
      model: ctx.config.slack.summary.model,
      schema,
    });
    const summaries = (answer as { summaries?: unknown }).summaries;
    if (!Array.isArray(summaries)) throw new Error("the summaries came back in the wrong shape");

    const asked = new Set(items.map((item) => item.key));
    const out: Record<string, unknown> = {};
    for (const entry of summaries as { key?: unknown; summary?: unknown }[]) {
      if (typeof entry !== "object" || entry === null) continue;
      if (typeof entry.key !== "string" || !asked.has(entry.key) || typeof entry.summary !== "string") continue;
      const summary = entry.summary.trim();
      if (summary !== "") out[entry.key] = summary;
    }
    return out;
  },
};
