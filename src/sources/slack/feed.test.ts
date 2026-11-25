import assert from "node:assert/strict";
import { test } from "node:test";
import { contextWith, fakeExec } from "../../../test/helpers.ts";
import { feed } from "./feed.ts";
import { fromInbox, sweepPlan } from "./inbox.ts";

const result = (answer: object) => JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: answer }) + "\n";
const LOCAL = {
  slack: {
    userId: "U1",
    workspaceUrl: "https://example.slack.com",
    groups: [
      { name: "Team", kind: "digest", conversations: [{ id: "C1", name: "team-dev" }] },
      { name: "Alerts", kind: "alerts", conversations: [{ id: "C2", name: "svc-alerts" }] },
    ],
  },
};
const SWEPT = {
  conversations: [
    { id: "C1", threads: [{ ts: "1795503542.966719", latestTs: "1795503542.966719", authors: ["Ana"], messageCount: 1, excerpt: "Morning" }] },
    { id: "C2", alerts: [] },
  ],
};

function sweeping(answer: object, local: object = LOCAL) {
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

test("a sweep hands Claude the plan and the sweep prompt, with only Slack's read tools", async () => {
  const { ctx, exec, inputs } = sweeping(SWEPT);
  const dropped = await feed(ctx);
  assert.deepEqual(dropped, SWEPT);
  assert.equal(fromInbox(dropped, ctx).threads.length, 1); // it is what the inbox reader takes

  const args = exec.calls.find((call) => call[1] === "-p")!;
  assert.equal(args[args.indexOf("--model") + 1], "haiku");
  assert.ok(!args.includes("--strict-mcp-config"));
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.deepEqual(args.slice(args.indexOf("--allowedTools") + 1), ctx.config.slack.sweep.tools);
  assert.match(args[2]!, /^You are reading one person's Slack/); // the same prompt as /slack-sweep
  assert.match(args[2]!, /## This run/);
  assert.deepEqual(JSON.parse(inputs[0]!), sweepPlan(ctx)); // the plan is worked out here, not by the model
});

test("a sweep that could not reach Slack, or came back with nothing, is an error, not an empty Slack", async () => {
  await assert.rejects(feed(sweeping({ error: "the Slack connector is not available" }).ctx), /could not read Slack: the Slack connector is not available/);
  await assert.rejects(feed(sweeping({ conversations: [] }).ctx), /could not read Slack: the answer covered none of the 2 conversations/);
  await assert.rejects(feed(sweeping({}).ctx), /could not read Slack: the answer had no conversations list/);
});

test("with no conversations to follow, nothing is asked", async () => {
  const { ctx, exec } = sweeping(SWEPT, { slack: { groups: [] } });
  assert.deepEqual(await feed(ctx), { conversations: [] });
  assert.equal(exec.calls.length, 0);
});
