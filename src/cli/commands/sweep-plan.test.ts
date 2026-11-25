import assert from "node:assert/strict";
import { test } from "node:test";
import { captureLog, contextWith } from "../../../test/helpers.ts";
import { SLACK_LOCAL } from "../../../test/fixtures/slack/api.ts";
import { sweepPlanCommand } from "./sweep-plan.ts";

test("sweep-plan prints what a Slack sweep should read, as JSON", async () => {
  const log = captureLog();
  let code: number;
  try {
    code = await sweepPlanCommand(() => contextWith(SLACK_LOCAL)).run([]);
  } finally {
    log.restore();
  }
  assert.equal(code, 0);
  const plan = JSON.parse(log.lines.join("\n"));
  assert.equal(plan.me.id, "ME");
  assert.equal(plan.file, "out/inbox/slack.json");
  assert.deepEqual(
    plan.conversations.map((c: { id: string; read: string }) => [c.id, c.read]),
    [
      ["C1", "threads"],
      ["D1", "dm"],
      ["C2", "alerts"],
    ],
  );
});
