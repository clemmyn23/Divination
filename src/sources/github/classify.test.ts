import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyRequest } from "./classify.ts";
import type { TimelineEvent } from "./types.ts";

const req = (at: string, by: string, who: { team?: string; user?: string }): TimelineEvent => ({
  event: "review_requested",
  created_at: at,
  actor: { login: by },
  ...(who.team ? { requested_team: { slug: who.team } } : {}),
  ...(who.user ? { requested_reviewer: { login: who.user } } : {}),
});

test("request tagging", () => {
  assert.equal(classifyRequest([req("t1", "ann", { team: "frontend-crew" }), req("t1", "ann", { user: "me" })], "me", "frontend-crew"), "rotation");
  assert.equal(classifyRequest([req("t1", "ann", { team: "frontend-crew" }), req("t2", "ann", { user: "me" })], "me", "frontend-crew"), "direct");
  assert.equal(classifyRequest([req("t1", "ann", { team: "frontend-crew" }), req("t1", "bob", { user: "me" })], "me", "frontend-crew"), "direct");
  assert.equal(classifyRequest([req("t1", "ann", { team: "other" })], "me", "frontend-crew"), "team");
  assert.equal(classifyRequest([{ event: "commented", created_at: "t1" }], "me", "frontend-crew"), "ambiguous");
});

test("a rotation batch with other reviewers in it still counts", () => {
  // The shape seen on the real host: the crew and several members requested in one go.
  const batch = [
    req("2026-07-03T06:07:11Z", "cal", { team: "frontend-crew" }),
    req("2026-07-03T06:07:11Z", "cal", { user: "sam" }),
    req("2026-07-03T06:07:11Z", "cal", { user: "me" }),
    req("2026-07-03T06:07:11Z", "cal", { user: "sha" }),
  ];
  assert.equal(classifyRequest(batch, "me", "frontend-crew"), "rotation");
});

test("a batch can straddle a second: the real host stamps the team and the people a moment apart", () => {
  // Seen live: team at 05:23:17Z, me at 05:23:18Z, same person asking.
  const straddled = [req("2026-05-11T05:23:17Z", "cal", { team: "frontend-crew" }), req("2026-05-11T05:23:18Z", "cal", { user: "me" })];
  assert.equal(classifyRequest(straddled, "me", "frontend-crew"), "rotation");

  const reversed = [req("2026-05-11T05:23:18Z", "cal", { team: "frontend-crew" }), req("2026-05-11T05:23:17Z", "cal", { user: "me" })];
  assert.equal(classifyRequest(reversed, "me", "frontend-crew"), "rotation");

  // A minute apart is two separate actions, and a different person is a different batch.
  const later = [req("2026-05-11T05:23:17Z", "cal", { team: "frontend-crew" }), req("2026-05-11T05:24:17Z", "cal", { user: "me" })];
  assert.equal(classifyRequest(later, "me", "frontend-crew"), "direct");
  const other = [req("2026-05-11T05:23:17Z", "cal", { team: "frontend-crew" }), req("2026-05-11T05:23:18Z", "dana", { user: "me" })];
  assert.equal(classifyRequest(other, "me", "frontend-crew"), "direct");
});

test("a later re-request does not undo an earlier rotation batch", () => {
  const events = [
    req("t1", "ann", { team: "frontend-crew" }),
    req("t1", "ann", { user: "me" }),
    req("t9", "ann", { user: "me" }),
  ];
  assert.equal(classifyRequest(events, "me", "frontend-crew"), "rotation");
});

test("with no rotation team configured nothing is tagged rotation", () => {
  assert.equal(classifyRequest([req("t1", "ann", { team: "" }), req("t1", "ann", { user: "me" })], "me", ""), "direct");
});

test("no events at all is ambiguous", () => {
  assert.equal(classifyRequest([], "me", "frontend-crew"), "ambiguous");
});
