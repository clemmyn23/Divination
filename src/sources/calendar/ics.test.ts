import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseIcs, toEpoch } from "./ics.ts";

const sample = fileURLToPath(new URL("../../../test/fixtures/calendar/sample.ics", import.meta.url));
const SYDNEY = "Australia/Sydney";

function wrap(...lines: string[]): string {
  return ["BEGIN:VCALENDAR", "BEGIN:VEVENT", ...lines, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
}

test("parses folded lines, timezones and my attendance", () => {
  const [e] = parseIcs(readFileSync(sample, "utf8"), "me@example.com").filter((x) => x.uid === "standup");
  assert.equal(e!.summary, "Daily standup, team");
  assert.deepEqual(e!.start, { value: "20261102T093000", tzid: "Australia/Sydney", dateOnly: false });
  assert.equal(e!.rrule!.FREQ, "WEEKLY");
  assert.equal(e!.myPartstat, "ACCEPTED");
});

test("reads every event, and a reminder inside an event does not change it", () => {
  const events = parseIcs(readFileSync(sample, "utf8"), "me@example.com");
  assert.deepEqual(
    events.map((e) => e.uid),
    ["standup", "planning", "oneonone", "oneonone", "declined", "cancelled", "yearly", "tomorrow"],
  );
  assert.equal(events[0]!.summary, "Daily standup, team"); // not the reminder's DESCRIPTION
  assert.equal(events[3]!.recurrenceId!.value, "20261125T140000");
  assert.equal(events[5]!.status, "CANCELLED");
  assert.equal(events[4]!.myPartstat, "DECLINED");
});

test("windows line endings, escapes, all-day dates and exclusions", () => {
  const [e] = parseIcs(
    wrap(
      "UID:a",
      "SUMMARY:Lunch\\; then a walk\\nmaybe",
      "DTSTART;VALUE=DATE:20261125",
      "DTEND;VALUE=DATE:20261127",
      "EXDATE;TZID=Australia/Sydney:20261126T093000,20261127T093000",
      "EXDATE:20261201T000000Z",
    ),
    "me@example.com",
  );
  assert.equal(e!.summary, "Lunch; then a walk\nmaybe");
  assert.deepEqual(e!.start, { value: "20261125", dateOnly: true });
  assert.deepEqual(e!.end, { value: "20261127", dateOnly: true });
  assert.deepEqual(
    e!.exdates.map((x) => x.value),
    ["20261126T093000", "20261127T093000", "20261201T000000Z"],
  );
  assert.equal(e!.exdates[0]!.tzid, "Australia/Sydney");
});

test("an event with a duration, or no end at all, still has a length", () => {
  const [timed] = parseIcs(wrap("UID:a", "SUMMARY:A", "DTSTART:20261125T000000Z", "DURATION:PT1H30M"), "");
  assert.equal(timed!.durationMs, 90 * 60_000);
  const [allDay] = parseIcs(wrap("UID:b", "SUMMARY:B", "DTSTART;VALUE=DATE:20261125"), "");
  assert.equal(allDay!.durationMs, 86_400_000);
  const [point] = parseIcs(wrap("UID:c", "SUMMARY:C", "DTSTART:20261125T000000Z"), "");
  assert.equal(point!.durationMs, 0);
});

test("an event without a readable start is left out, and text that is not a calendar gives nothing", () => {
  assert.deepEqual(parseIcs(wrap("UID:a", "SUMMARY:A"), ""), []);
  assert.deepEqual(parseIcs(wrap("UID:a", "SUMMARY:A", "DTSTART:tomorrow"), ""), []);
  assert.deepEqual(parseIcs("<html>Sign in</html>", ""), []);
});

test("epoch conversion handles UTC, a named zone and floating times", () => {
  assert.equal(toEpoch({ value: "20261124T223000Z", dateOnly: false }, SYDNEY), Date.parse("2026-11-24T22:30:00Z"));
  assert.equal(
    toEpoch({ value: "20261125T093000", tzid: "Australia/Sydney", dateOnly: false }, "UTC"),
    Date.parse("2026-11-24T22:30:00Z"),
  );
  assert.equal(toEpoch({ value: "20261125T093000", dateOnly: false }, SYDNEY), Date.parse("2026-11-24T22:30:00Z"));
});

test("an all-day date is midnight in my timezone, and an unknown zone name falls back to mine", () => {
  assert.equal(toEpoch({ value: "20261125", dateOnly: true }, SYDNEY), Date.parse("2026-11-24T13:00:00Z"));
  assert.equal(
    toEpoch({ value: "20261125T093000", tzid: "AUS Eastern Standard Time", dateOnly: false }, SYDNEY),
    Date.parse("2026-11-24T22:30:00Z"),
  );
});
