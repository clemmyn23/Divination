import assert from "node:assert/strict";
import { test } from "node:test";
import { needsYou } from "./needs-you.ts";

const m = (ts: string, user: string, text: string, reactedByMe = false) => ({ ts, user, text, reactions: reactedByMe ? [{ name: "eyes", users: ["ME"] }] : [] });

test("needs-you rules", () => {
  assert.equal(needsYou([m("1", "U1", "hey <@ME> can you look?")], "ME", "channel"), "mentioned you");
  assert.equal(needsYou([m("1", "U1", "hey <@ME> can you look?", true)], "ME", "channel"), undefined);
  assert.equal(needsYou([m("1", "U1", "hey <@ME>"), m("2", "ME", "on it")], "ME", "channel"), undefined);
  assert.equal(needsYou([m("1", "U1", "ping")], "ME", "dm"), "waiting on your reply");
  assert.equal(needsYou([m("1", "U1", "ping"), m("2", "ME", "pong")], "ME", "dm"), undefined);
  assert.equal(needsYou([m("1", "ME", "shipping it"), m("2", "U1", "which env?")], "ME", "channel"), "question in a thread you're in");
  assert.equal(needsYou([m("1", "ME", "shipping it"), m("2", "U1", "nice")], "ME", "channel"), undefined);
  assert.equal(needsYou([m("1", "U1", "anyone seen this?")], "ME", "channel"), undefined);
});

test("a mention only counts after my last message, in either markup form, and never for someone else", () => {
  assert.equal(needsYou([m("1", "U1", "hey <@ME>"), m("2", "ME", "on it"), m("3", "U1", "thanks <@ME|me>, one more thing")], "ME", "channel"), "mentioned you");
  assert.equal(needsYou([m("1", "U1", "hey <@MEL> and <@U2>")], "ME", "channel"), undefined);
  assert.equal(needsYou([], "ME", "dm"), undefined);
});

test("reacting to the last message answers it", () => {
  assert.equal(needsYou([m("1", "U1", "ping", true)], "ME", "dm"), undefined);
  assert.equal(needsYou([m("1", "ME", "shipping it"), m("2", "U1", "which env?", true)], "ME", "channel"), undefined);
  assert.equal(needsYou([m("1", "ME", "shipping it"), m("2", "U1", "which env?  ")], "ME", "channel"), "question in a thread you're in");
});
