import assert from "node:assert/strict";
import { test } from "node:test";
import { dynamicConversations } from "./dynamic.ts";
import type { SlackConversation } from "./types.ts";

const CONV: SlackConversation = { id: "C1", name: "team-dev", group: "Team", kind: "channel" };

test("recent channels skip configured and excluded ones", () => {
  const out = dynamicConversations([{ id: "C1", name: "team-dev" }, { id: "C9", name: "social" }, { id: "C7", name: "deploys" }, { id: "C7", name: "deploys" }], [CONV], ["C9"]);
  assert.deepEqual(out, [{ id: "C7", name: "deploys", group: "Posted in", kind: "channel" }]);
});

test("a channel can be excluded by name, and direct messages are left out", () => {
  const out = dynamicConversations([{ id: "C9", name: "social" }, { id: "D4", name: "U123" }, { id: "C8", name: "random" }], [], ["social"]);
  assert.deepEqual(out, [{ id: "C8", name: "random", group: "Posted in", kind: "channel" }]);
});
