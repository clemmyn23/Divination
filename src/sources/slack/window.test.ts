import assert from "node:assert/strict";
import { test } from "node:test";
import { NOW, contextWith } from "../../../test/helpers.ts";
import { SLACK_LOCAL } from "../../../test/fixtures/slack/api.ts";
import { windowStart } from "./window.ts";

const HOUR = 3_600_000;
const at = (iso: string, slack: object = {}) => {
  const now = Date.parse(iso);
  return { now, ctx: contextWith({ ...SLACK_LOCAL, slack: { ...SLACK_LOCAL.slack, ...slack } }, { now: () => now }) };
};

test("Slack is read over the past three days", () => {
  const ctx = contextWith(SLACK_LOCAL); // a Wednesday
  assert.equal(windowStart(ctx), NOW - 72 * HOUR);
});

test("on a Monday it is read over the past five days, so the weekend does not use up the window", () => {
  const { now, ctx } = at("2026-11-22T23:00:00Z"); // Monday 23 November, 10:00 in Sydney
  assert.equal(windowStart(ctx), now - 120 * HOUR);
});

test("Monday is Monday where I am, not in UTC", () => {
  const early = at("2026-11-22T13:30:00Z"); // Monday 00:30 in Sydney, still Sunday in UTC
  assert.equal(windowStart(early.ctx), early.now - 120 * HOUR);
  const late = at("2026-11-23T13:30:00Z"); // Tuesday 00:30 in Sydney, still Monday in UTC
  assert.equal(windowStart(late.ctx), late.now - 72 * HOUR);
});

test("both lengths come from config", () => {
  const weekday = at("2026-11-24T23:00:00Z", { windowHours: 24, mondayWindowHours: 72 });
  assert.equal(windowStart(weekday.ctx), weekday.now - 24 * HOUR);
  const monday = at("2026-11-22T23:00:00Z", { windowHours: 24, mondayWindowHours: 72 });
  assert.equal(windowStart(monday.ctx), monday.now - 72 * HOUR);
});

test("a Monday never reads less than another day would", () => {
  const { now, ctx } = at("2026-11-22T23:00:00Z", { windowHours: 144, mondayWindowHours: 120 });
  assert.equal(windowStart(ctx), now - 144 * HOUR);
});
