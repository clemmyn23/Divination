import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dayClass, eventsForDay, headline } from "./day.ts";
import { parseIcs } from "./ics.ts";
import type { CalEvent } from "./types.ts";

const sample = fileURLToPath(new URL("../../../test/fixtures/calendar/sample.ics", import.meta.url));
const SYDNEY = "Australia/Sydney";
const wed = Date.parse("2026-11-24T13:00:00Z"); // Sydney midnight

/** A meeting that starts `start` minutes after midnight and runs for `length` minutes. */
function mins(start: number, length: number, over: Partial<CalEvent> = {}): CalEvent {
  return {
    start: wed + start * 60_000,
    end: wed + (start + length) * 60_000,
    title: "Meeting",
    allDay: false,
    optional: false,
    weight: 2,
    ...over,
  };
}

function ics(...events: string[][]): string {
  const blocks = events.flatMap((lines) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"]);
  return ["BEGIN:VCALENDAR", ...blocks, "END:VCALENDAR"].join("\n");
}

test("the day drops declined and cancelled events and reports what it cannot read", () => {
  const { events, unsupported } = eventsForDay(parseIcs(readFileSync(sample, "utf8"), "me@example.com"), wed, SYDNEY);
  assert.deepEqual(
    events.map((e) => [e.title, e.optional, e.weight]),
    [
      ["Daily standup, team", false, 1],
      ["Planning", true, 3],
      ["Moved 1:1", false, 2],
    ],
  );
  assert.deepEqual(unsupported, ["Yearly review"]);
});

test("events carry their real times and come out in order", () => {
  const { events } = eventsForDay(parseIcs(readFileSync(sample, "utf8"), "me@example.com"), wed, SYDNEY);
  assert.deepEqual(
    events.map((e) => [e.start, e.end, e.allDay]),
    [
      [Date.parse("2026-11-24T22:30:00Z"), Date.parse("2026-11-24T22:45:00Z"), false],
      [Date.parse("2026-11-25T00:00:00Z"), Date.parse("2026-11-25T01:30:00Z"), false],
      [Date.parse("2026-11-25T04:00:00Z"), Date.parse("2026-11-25T04:45:00Z"), false],
    ],
  );
});

test("a moved occurrence leaves its old day and shows on its new one", () => {
  const raw = parseIcs(
    ics(
      ["UID:s", "SUMMARY:Sync", "DTSTART:20261104T030000Z", "DTEND:20261104T033000Z", "RRULE:FREQ=WEEKLY"],
      ["UID:s", "RECURRENCE-ID:20261125T030000Z", "SUMMARY:Sync (moved)", "DTSTART:20261126T030000Z", "DTEND:20261126T033000Z"],
    ),
    "",
  );
  assert.deepEqual(eventsForDay(raw, wed, SYDNEY).events, []);
  assert.deepEqual(
    eventsForDay(raw, wed + 86_400_000, SYDNEY).events.map((e) => e.title),
    ["Sync (moved)"],
  );
});

test("declining one occurrence of a series removes only that one", () => {
  const raw = parseIcs(
    ics(
      ["UID:s", "SUMMARY:Sync", "DTSTART:20261104T030000Z", "DTEND:20261104T033000Z", "RRULE:FREQ=WEEKLY"],
      [
        "UID:s",
        "RECURRENCE-ID:20261125T030000Z",
        "SUMMARY:Sync",
        "DTSTART:20261125T030000Z",
        "DTEND:20261125T033000Z",
        "ATTENDEE;PARTSTAT=DECLINED:mailto:me@example.com",
      ],
    ),
    "me@example.com",
  );
  assert.deepEqual(eventsForDay(raw, wed, SYDNEY).events, []);
  assert.equal(eventsForDay(raw, wed - 7 * 86_400_000, SYDNEY).events.length, 1);
});

test("all-day events are marked, weigh 1 and come first; a tentative yes is optional", () => {
  const raw = parseIcs(
    ics(
      ["UID:a", "SUMMARY:Release freeze", "DTSTART;VALUE=DATE:20261124", "DTEND;VALUE=DATE:20261127"],
      ["UID:b", "SUMMARY:Maybe", "DTSTART:20261125T000000Z", "DTEND:20261125T003000Z", "ATTENDEE;PARTSTAT=TENTATIVE:mailto:me@example.com"],
      ["UID:c", "DTSTART:20261125T010000Z", "DTEND:20261125T011500Z"],
    ),
    "me@example.com",
  );
  assert.deepEqual(
    eventsForDay(raw, wed, SYDNEY).events.map((e) => [e.title, e.allDay, e.optional, e.weight]),
    [
      ["Release freeze", true, false, 1],
      ["Maybe", false, true, 2],
      ["(no title)", false, false, 1],
    ],
  );
});

test("a rule that is not understood is reported once, and not after it has ended or when declined", () => {
  const rule = "RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1";
  const raw = parseIcs(
    ics(
      ["UID:a", "SUMMARY:Month end", "DTSTART:20260130T000000Z", "DTEND:20260130T010000Z", rule],
      ["UID:b", "SUMMARY:Month end", "DTSTART:20260130T020000Z", "DTEND:20260130T030000Z", rule],
      ["UID:c", "SUMMARY:Finished", "DTSTART:20260130T000000Z", "DTEND:20260130T010000Z", `${rule};UNTIL=20260601T000000Z`],
      ["UID:d", "SUMMARY:Not yet", "DTSTART:20270130T000000Z", "DTEND:20270130T010000Z", rule],
      ["UID:e", "SUMMARY:Said no", "DTSTART:20260130T000000Z", "DTEND:20260130T010000Z", rule, "ATTENDEE;PARTSTAT=DECLINED:mailto:me@example.com"],
    ),
    "me@example.com",
  );
  assert.deepEqual(eventsForDay(raw, wed, SYDNEY).unsupported, ["Month end"]);
});

test("day class and headline", () => {
  assert.equal(dayClass([]), "open");
  assert.equal(dayClass([mins(540, 30)]), "open");
  assert.equal(dayClass([mins(540, 60), mins(660, 60)]), "normal");
  assert.equal(dayClass([mins(540, 30), mins(575, 30), mins(610, 30)]), "heavy"); // back to back
  assert.equal(dayClass([mins(540, 150), mins(780, 150)]), "heavy"); // 300 minutes
  assert.equal(headline("open", [], "Clem", SYDNEY), "The day is yours, Clem.");
  assert.equal(
    headline("heavy", [mins(540, 150), mins(780, 150)], "Clem", SYDNEY),
    "A full one, Clem: 2 meetings, the last ends at 15:30.",
  );
});

test("the day class counts only timed meetings I have accepted", () => {
  const allDay = mins(0, 1440, { allDay: true });
  const optional = mins(540, 300, { optional: true });
  assert.equal(dayClass([allDay, optional]), "open");
  assert.equal(dayClass([allDay, optional, mins(600, 45)]), "normal");
  assert.equal(dayClass([mins(540, 30), mins(585, 30), mins(630, 30)]), "normal"); // gaps of 15 minutes
});

test("the normal headline names the longest gap, and reads properly with one meeting", () => {
  const day = [mins(555, 15), mins(660, 120), mins(840, 30, { optional: true }), mins(900, 60)];
  // gaps: 09:30 to 11:00, then 13:00 to 15:00; the optional meeting does not break a gap
  assert.equal(headline("normal", day, "Clem", SYDNEY), "3 meetings today, Clem; the longest gap starts at 13:00.");
  assert.equal(headline("normal", [mins(600, 90)], "Clem", SYDNEY), "One meeting today, Clem, at 10:00.");
  assert.equal(
    headline("normal", [mins(600, 60), mins(630, 60)], "Clem", SYDNEY),
    "2 meetings today, Clem, with no gap between them.",
  );
});
