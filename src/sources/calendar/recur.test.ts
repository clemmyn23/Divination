import assert from "node:assert/strict";
import { test } from "node:test";
import { isSupported, occurrenceOn } from "./recur.ts";
import type { RawEvent } from "./types.ts";

const SYDNEY = "Australia/Sydney";
// Sydney midnights
const wed = Date.parse("2026-11-24T13:00:00Z");
const sat = Date.parse("2026-11-27T13:00:00Z");

/** A half-hour event; `start` is a floating time unless it ends in Z. */
function ev(over: { start: string; end?: string; rrule?: Record<string, string>; exdates?: string[] }): RawEvent {
  const dateOnly = /^\d{8}$/.test(over.start);
  return {
    uid: "u",
    summary: "Event",
    start: { value: over.start, dateOnly },
    end: { value: over.end ?? over.start, dateOnly },
    ...(over.end ? {} : { durationMs: dateOnly ? 86_400_000 : 30 * 60_000 }),
    ...(over.rrule ? { rrule: over.rrule } : {}),
    exdates: (over.exdates ?? []).map((value) => ({ value, dateOnly: /^\d{8}$/.test(value) })),
  };
}

test("recurrence", () => {
  const weekly = ev({ start: "20261102T093000", rrule: { FREQ: "WEEKLY", BYDAY: "MO,TU,WE,TH,FR" } });
  assert.equal(occurrenceOn(weekly, wed, SYDNEY)!.start, Date.parse("2026-11-24T22:30:00Z"));
  assert.equal(occurrenceOn(weekly, wed, SYDNEY)!.end, Date.parse("2026-11-24T23:00:00Z"));
  assert.equal(occurrenceOn(weekly, sat, SYDNEY), undefined);
  // off week
  assert.equal(occurrenceOn(ev({ start: "20261104T100000", rrule: { FREQ: "WEEKLY", INTERVAL: "2" } }), wed, SYDNEY), undefined);
  assert.equal(
    occurrenceOn(ev({ start: "20261102T093000", rrule: { FREQ: "DAILY", UNTIL: "20261120T000000Z" } }), wed, SYDNEY),
    undefined,
  );
  assert.equal(occurrenceOn(ev({ start: "20261102T093000", rrule: { FREQ: "DAILY", COUNT: "5" } }), wed, SYDNEY), undefined);
  assert.equal(
    occurrenceOn(ev({ start: "20261102T093000", rrule: { FREQ: "DAILY" }, exdates: ["20261125T093000"] }), wed, SYDNEY),
    undefined,
  );
  assert.ok(occurrenceOn(ev({ start: "20261025T140000", rrule: { FREQ: "MONTHLY", BYMONTHDAY: "25" } }), wed, SYDNEY));
});

test("the rules that are understood, and the ones that are not", () => {
  assert.equal(isSupported({ FREQ: "DAILY", INTERVAL: "2", COUNT: "10" }), true);
  assert.equal(isSupported({ FREQ: "WEEKLY", WKST: "MO", BYDAY: "MO,WE", UNTIL: "20270101T000000Z" }), true);
  assert.equal(isSupported({ FREQ: "MONTHLY", BYMONTHDAY: "25" }), true);
  assert.equal(isSupported({ FREQ: "MONTHLY", BYDAY: "2TU" }), true);
  assert.equal(isSupported({ FREQ: "YEARLY" }), true);

  assert.equal(isSupported({ FREQ: "HOURLY" }), false);
  assert.equal(isSupported({ FREQ: "YEARLY", BYMONTH: "11", BYDAY: "-1FR" }), false);
  assert.equal(isSupported({ FREQ: "MONTHLY", BYDAY: "MO,TU,WE,TH,FR", BYSETPOS: "-1" }), false);
  assert.equal(isSupported({ FREQ: "WEEKLY", BYDAY: "2TU" }), false);
  assert.equal(isSupported({ FREQ: "DAILY", INTERVAL: "0" }), false);
  assert.equal(isSupported({}), false);
});

test("a one-off event shows only on its own day", () => {
  const once = ev({ start: "20261125T000000Z" }); // 11:00 Wednesday in Sydney
  assert.equal(occurrenceOn(once, wed, SYDNEY)!.start, Date.parse("2026-11-25T00:00:00Z"));
  assert.equal(occurrenceOn(once, sat, SYDNEY), undefined);
});

test("a series before it starts, on the day it starts, and on its last counted day", () => {
  const daily = ev({ start: "20261125T093000", rrule: { FREQ: "DAILY", COUNT: "4" } }); // Wed to Sat
  assert.equal(occurrenceOn(daily, wed - 86_400_000, SYDNEY), undefined);
  assert.ok(occurrenceOn(daily, wed, SYDNEY));
  assert.ok(occurrenceOn(daily, sat, SYDNEY));
  assert.equal(occurrenceOn(daily, sat + 86_400_000, SYDNEY), undefined);
});

test("every second week lands on the right weeks", () => {
  const fortnightly = ev({ start: "20261111T100000", rrule: { FREQ: "WEEKLY", INTERVAL: "2", BYDAY: "MO,WE" } });
  assert.ok(occurrenceOn(fortnightly, wed, SYDNEY)); // 11th, then 23rd and 25th
  assert.equal(occurrenceOn(fortnightly, wed - 7 * 86_400_000, SYDNEY), undefined); // the 18th
});

test("a series keeps its clock time across a daylight-saving change", () => {
  // Sydney moves its clocks forward on 4 October 2026.
  const weekly = ev({ start: "20260902T093000", rrule: { FREQ: "WEEKLY" } });
  assert.equal(occurrenceOn(weekly, wed, SYDNEY)!.start, Date.parse("2026-11-24T22:30:00Z"));
});

test("a series written in another timezone lands on my day", () => {
  // 17:30 on Tuesday in New York is 09:30 on Wednesday in Sydney.
  const remote: RawEvent = {
    ...ev({ start: "20261103T173000", rrule: { FREQ: "WEEKLY" } }),
    start: { value: "20261103T173000", tzid: "America/New_York", dateOnly: false },
  };
  assert.equal(occurrenceOn(remote, wed, SYDNEY)!.start, Date.parse("2026-11-24T22:30:00Z"));
});

test("monthly on the nth weekday, and yearly on the same date", () => {
  // 25 November 2026 is the fourth, and last, Wednesday of the month.
  assert.ok(occurrenceOn(ev({ start: "20261028T100000", rrule: { FREQ: "MONTHLY", BYDAY: "4WE" } }), wed, SYDNEY));
  assert.ok(occurrenceOn(ev({ start: "20261028T100000", rrule: { FREQ: "MONTHLY", BYDAY: "-1WE" } }), wed, SYDNEY));
  assert.equal(occurrenceOn(ev({ start: "20261014T100000", rrule: { FREQ: "MONTHLY", BYDAY: "2WE" } }), wed, SYDNEY), undefined);
  assert.ok(occurrenceOn(ev({ start: "20261025T100000", rrule: { FREQ: "MONTHLY" } }), wed, SYDNEY));
  assert.equal(occurrenceOn(ev({ start: "20261024T100000", rrule: { FREQ: "MONTHLY" } }), wed, SYDNEY), undefined);
  assert.ok(occurrenceOn(ev({ start: "20241125T100000", rrule: { FREQ: "YEARLY" } }), wed, SYDNEY));
  assert.equal(occurrenceOn(ev({ start: "20241126T100000", rrule: { FREQ: "YEARLY" } }), wed, SYDNEY), undefined);
  assert.equal(
    occurrenceOn(ev({ start: "20251125T100000", rrule: { FREQ: "YEARLY", INTERVAL: "2" } }), wed, SYDNEY),
    undefined,
  );
});

test("an all-day event covers each of its days, repeating or not", () => {
  const leave = ev({ start: "20261123", end: "20261127" }); // Monday to Thursday; the end date is exclusive
  assert.deepEqual(occurrenceOn(leave, wed, SYDNEY), { start: wed - 2 * 86_400_000, end: wed + 2 * 86_400_000 });
  assert.equal(occurrenceOn(leave, sat, SYDNEY), undefined);
  const birthday = ev({ start: "20201125", rrule: { FREQ: "YEARLY" } });
  assert.deepEqual(occurrenceOn(birthday, wed, SYDNEY), { start: wed, end: wed + 86_400_000 });
});

test("a date-only exclusion removes that day, and a rule that is not understood gives nothing", () => {
  assert.equal(
    occurrenceOn(ev({ start: "20261102T093000", rrule: { FREQ: "DAILY" }, exdates: ["20261125"] }), wed, SYDNEY),
    undefined,
  );
  assert.equal(occurrenceOn(ev({ start: "20261102T093000", rrule: { FREQ: "HOURLY" } }), wed, SYDNEY), undefined);
});
