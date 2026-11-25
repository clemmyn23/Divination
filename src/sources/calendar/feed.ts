import { fileURLToPath } from "node:url";
import { endOfDay, isoDate, startOfDay } from "../../core/time.ts";
import type { Context } from "../../core/types.ts";
import { runClaude } from "../../enrich/claude.ts";

// The calendar read that Refresh now can start: the same prompt as `/calendar-read`, run
// headless. It differs from the hand-started read in how it delivers: it is given the day
// rather than working it out, and it answers with the events rather than writing a file,
// so the run needs no tools beyond the calendar connector's read-only ones.

const promptFile = fileURLToPath(new URL("../../../prompts/calendar-read.md", import.meta.url));

const NOTE = `## This run

The dashboard started this run, so three things differ from the steps above:

- DATE and NEXT are given to you. Your input is JSON holding \`date\` (DATE), \`next\` (NEXT) and \`timezone\`. Do not work them out.
- Do not write a file, and do not reply with a count. Your answer is what the file would hold: the JSON object in the shape above.
- If you could not read the calendar (the connector is missing, or its calls failed), answer \`{"error": "<why, in a few words>"}\` instead. Never answer with an empty list because a call failed.`;

const text = { type: "string" };
const flag = { type: "boolean" };
const SCHEMA = {
  type: "object",
  properties: {
    date: text,
    events: {
      type: "array",
      items: {
        type: "object",
        properties: { title: text, start: text, end: text, allDay: flag, response: text, optional: flag, type: text, cancelled: flag, calendar: text },
        required: ["start"],
      },
    },
    error: text,
  },
};

/** Ask Claude for today's events, in the plain shape `fromInbox` takes. Throws if the calendar could not be read. */
export async function feed(ctx: Context): Promise<unknown> {
  const { timezone } = ctx.config.me;
  const dayStart = startOfDay(ctx.now(), timezone);
  const date = isoDate(dayStart, timezone);
  const { model, tools } = ctx.config.calendar.read;

  const answer = (await runClaude(ctx, {
    promptFile,
    note: NOTE,
    input: JSON.stringify({ date, next: isoDate(endOfDay(dayStart, timezone), timezone), timezone }),
    model,
    schema: SCHEMA,
    allowedTools: tools,
    connectors: true,
    timeoutMs: ctx.config.claudeReads.timeoutMinutes * 60_000,
  })) as { events?: unknown; error?: unknown };

  const failed = (why: string) => new Error(`could not read the calendar: ${why}`);
  if (typeof answer.error === "string" && answer.error.trim() !== "") throw failed(answer.error.trim());
  if (!Array.isArray(answer.events)) throw failed("the answer had no events list");
  // The day is the one that was asked for, whatever the answer says.
  return { date, events: answer.events };
}
