import assert from "node:assert/strict";
import { test } from "node:test";
import { contextWith, fakeExec } from "../../../test/helpers.ts";
import { feed } from "./feed.ts";
import { fromInbox } from "./inbox.ts";

const result = (answer: object) => JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: answer }) + "\n";
const EVENT = { title: "Standup", start: "2026-11-25T09:30:00+11:00", end: "2026-11-25T09:45:00+11:00", response: "accepted", calendar: "primary" };

function reading(answer: object, local: object = {}) {
  const exec = fakeExec({ "claude -p": { stdout: result(answer) } });
  const inputs: (string | undefined)[] = [];
  const ctx = contextWith(local, {
    exec: Object.assign((cmd: string, args: string[], opts?: Parameters<typeof exec>[2]) => {
      if (args[0] === "-p") inputs.push(opts?.input); // the run itself, not the listing of servers before it
      return exec(cmd, args, opts);
    }, {}),
  });
  return { ctx, exec, inputs };
}

test("a calendar read asks Claude, on the configured model, with only the calendar's read tools", async () => {
  const { ctx, exec, inputs } = reading({ date: "2026-11-25", events: [EVENT] }, { calendar: { read: { model: "sonnet", tools: ["mcp__x__list_events"] } }, claudeReads: { timeoutMinutes: 3 } });
  const dropped = await feed(ctx);
  assert.deepEqual(dropped, { date: "2026-11-25", events: [EVENT] });
  assert.equal(fromInbox(dropped, ctx).events.length, 1); // it is what the inbox reader takes

  const args = exec.calls.find((call) => call[1] === "-p")!;
  assert.equal(args[args.indexOf("--model") + 1], "sonnet");
  assert.ok(!args.includes("--strict-mcp-config"));
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.deepEqual(args.slice(-2), ["--allowedTools", "mcp__x__list_events"]);
  assert.match(args[2]!, /^You are reading one person's Google Calendar/); // the same prompt as /calendar-read
  assert.match(args[2]!, /## This run/);
  // The day is worked out here, in my time zone, not by the model.
  assert.deepEqual(JSON.parse(inputs[0]!), { date: "2026-11-25", next: "2026-11-26", timezone: "Australia/Sydney" });
});

test("the day in the answer is the day that was asked for, whatever the model wrote", async () => {
  const { ctx } = reading({ date: "1999-01-01", events: [] });
  assert.deepEqual(await feed(ctx), { date: "2026-11-25", events: [] });
});

test("a read that could not reach the calendar is an error, not an empty day", async () => {
  await assert.rejects(feed(reading({ error: "the connector is not available" }).ctx), /could not read the calendar: the connector is not available/);
  await assert.rejects(feed(reading({ error: "tool denied", events: [] }).ctx), /could not read the calendar: tool denied/);
  await assert.rejects(feed(reading({ date: "2026-11-25" }).ctx), /could not read the calendar: the answer had no events list/);
});
