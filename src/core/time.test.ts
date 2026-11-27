import assert from "node:assert/strict";
import { test } from "node:test";
import { endOfDay, hhmm, isoDate, parseHhmm, startOfDay, when, withinActiveHours } from "./time.ts";

const at = (iso: string) => Date.parse(iso);
const SYDNEY = "Australia/Sydney"; // UTC+11 in November
const tick = { minutes: 15, days: [1, 2, 3, 4, 5], start: "08:00", end: "18:00" };

test("active hours respect days, times and timezone", () => {
  assert.equal(withinActiveHours(at("2026-11-24T22:00:00Z"), tick, SYDNEY), true); // Wed 09:00
  assert.equal(withinActiveHours(at("2026-11-25T08:00:00Z"), tick, SYDNEY), false); // Wed 19:00
  assert.equal(withinActiveHours(at("2026-11-27T22:00:00Z"), tick, SYDNEY), false); // Sat 09:00
  assert.equal(hhmm(at("2026-11-24T22:05:00Z"), SYDNEY), "09:05");
  assert.equal(startOfDay(at("2026-11-24T22:05:00Z"), SYDNEY), at("2026-11-24T13:00:00Z"));
});

test("the start time is inside the window and the end time is outside", () => {
  assert.equal(withinActiveHours(at("2026-11-24T21:00:00Z"), tick, SYDNEY), true); // Wed 08:00
  assert.equal(withinActiveHours(at("2026-11-24T20:59:00Z"), tick, SYDNEY), false); // Wed 07:59
  assert.equal(withinActiveHours(at("2026-11-25T06:59:00Z"), tick, SYDNEY), true); // Wed 17:59
  assert.equal(withinActiveHours(at("2026-11-25T07:00:00Z"), tick, SYDNEY), false); // Wed 18:00
});

test("the weekday comes from the timezone, not from UTC", () => {
  // Sunday 22:00 UTC is already Monday 09:00 in Sydney.
  assert.equal(withinActiveHours(at("2026-11-22T22:00:00Z"), tick, SYDNEY), true);
  // Friday 22:00 UTC is Saturday 09:00 in Sydney.
  assert.equal(withinActiveHours(at("2026-11-20T22:00:00Z"), tick, SYDNEY), false);
});

test("parseHhmm gives minutes since midnight", () => {
  assert.equal(parseHhmm("00:00"), 0);
  assert.equal(parseHhmm("08:30"), 510);
  assert.equal(parseHhmm("23:59"), 1439);
});

test("midnight is formatted as 00:00, not 24:00", () => {
  assert.equal(hhmm(at("2026-11-24T13:00:00Z"), SYDNEY), "00:00");
});

test("start of day is right on a daylight-saving change day", () => {
  // Sydney clocks go forward on 4 October 2026: midnight is still UTC+10, the afternoon is UTC+11.
  assert.equal(startOfDay(at("2026-10-04T05:00:00Z"), SYDNEY), at("2026-10-03T14:00:00Z"));
  // And back on 5 April 2026: midnight is UTC+11, the afternoon is UTC+10.
  assert.equal(startOfDay(at("2026-04-05T05:00:00Z"), SYDNEY), at("2026-04-04T13:00:00Z"));
});

test("start of day works in UTC too", () => {
  assert.equal(startOfDay(at("2026-11-24T22:05:00Z"), "UTC"), at("2026-11-24T00:00:00Z"));
});

test("the local date and the next local midnight", () => {
  assert.equal(isoDate(at("2026-11-24T22:05:00Z"), SYDNEY), "2026-11-25");
  assert.equal(isoDate(at("2026-01-04T12:59:00Z"), SYDNEY), "2026-01-04");
  assert.equal(endOfDay(at("2026-11-24T13:00:00Z"), SYDNEY), at("2026-11-25T13:00:00Z"));
  // Sydney's clocks go forward on 4 October 2026, so that day is 23 hours long.
  assert.equal(endOfDay(at("2026-10-03T14:00:00Z"), SYDNEY) - at("2026-10-03T14:00:00Z"), 23 * 3_600_000);
});

test("a time today is just the clock; a time on another day says which day", () => {
  const now = at("2026-11-27T03:00:00Z"); // Friday 14:00 in Sydney
  assert.equal(when(at("2026-11-27T01:05:00Z"), now, SYDNEY), "12:05");
  assert.equal(when(at("2026-11-26T03:05:00Z"), now, SYDNEY), "Thu 26 Nov 14:05");
  assert.equal(when(at("2026-11-02T22:00:00Z"), now, SYDNEY), "Tue 3 Nov 09:00");
  // Late on Thursday in UTC is already Friday in Sydney: that is today.
  assert.equal(when(at("2026-11-26T13:30:00Z"), now, SYDNEY), "00:30");
});
