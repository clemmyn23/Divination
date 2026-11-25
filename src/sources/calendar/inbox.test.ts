import assert from "node:assert/strict";
import { test } from "node:test";
import { contextWith, view } from "../../../test/helpers.ts";
import { collectSource } from "../../core/pipeline.ts";
import { writeJson } from "../../core/store.ts";
import { fromInbox } from "./inbox.ts";
import { calendar } from "./index.ts";

const ctx = () => contextWith({ me: { name: "Clem", email: "me@example.com" }, calendar: { transport: "inbox" } });

/** What a calendar read drops in the inbox: plain events, with nothing worked out. */
function dropped(events: object[], date = "2026-11-25") {
  return { date, events };
}

const timed = (title: string, start: string, end: string, over: object = {}) => ({
  title,
  start: `2026-11-25T${start}:00+11:00`,
  end: `2026-11-25T${end}:00+11:00`,
  ...over,
});

test("raw events become the day: code works out the weights, the class and the headline", () => {
  const data = fromInbox(
    dropped([
      timed("Planning", "11:00", "12:30"),
      timed("Standup", "09:30", "09:45"),
      timed("1:1", "15:00", "15:45", { response: "accepted" }),
    ]),
    ctx(),
  );
  assert.equal(data.date, "2026-11-25");
  assert.deepEqual(
    data.events.map((e) => [e.title, e.weight, e.allDay, e.optional]),
    [
      ["Standup", 1, false, false],
      ["Planning", 3, false, false],
      ["1:1", 2, false, false],
    ],
  );
  assert.equal(data.events[0]!.start, Date.parse("2026-11-24T22:30:00Z"));
  assert.equal(data.dayClass, "normal");
  assert.equal(data.headline, "3 meetings today, Clem; the longest gap starts at 12:30.");
  assert.deepEqual(data.unsupported, []);
  assert.deepEqual(calendar.validate(data), []);
});

test("my answer decides what is kept: declined and cancelled go, a maybe is optional, unanswered still counts", () => {
  const data = fromInbox(
    dropped([
      timed("Said no", "09:00", "10:00", { response: "declined" }),
      timed("Called off", "10:00", "11:00", { cancelled: true }),
      timed("Maybe", "11:00", "12:00", { response: "tentative" }),
      timed("Unanswered", "13:00", "14:00", { response: "needsAction" }),
      timed("Going", "15:00", "16:00", { response: "accepted" }),
    ]),
    ctx(),
  );
  assert.deepEqual(
    data.events.map((e) => [e.title, e.optional]),
    [
      ["Maybe", true],
      ["Unanswered", false],
      ["Going", false],
    ],
  );
});

test("being invited as optional, or the event living on someone else's calendar, makes it optional", () => {
  const data = fromInbox(
    dropped([
      timed("Invited as optional", "09:00", "10:00", { optional: true, response: "accepted" }),
      timed("Open brown bag", "12:00", "13:00", { calendar: "Engineering Wide Meetings" }),
      timed("Mine", "14:00", "15:00", { calendar: "primary" }),
      { title: "Ana on leave", start: "2026-11-25", end: "2026-11-26", allDay: true, calendar: "Team leave" },
    ]),
    ctx(),
  );
  assert.deepEqual(
    data.events.map((e) => [e.title, e.optional]),
    [
      ["Ana on leave", false],
      ["Invited as optional", true],
      ["Open brown bag", true],
      ["Mine", false],
    ],
  );
});

test("a meeting that is on my calendar and a team calendar is mine, whichever is listed first", () => {
  const data = fromInbox(
    dropped([timed("Standup", "12:00", "12:15", { calendar: "Team Mitnick" }), timed("Standup", "12:00", "12:15", { calendar: "primary" })]),
    ctx(),
  );
  assert.deepEqual(
    data.events.map((e) => [e.title, e.optional]),
    [["Standup", false]],
  );
});

test("focus time and out of office are shown as my own blocks, not meetings; working location is dropped", () => {
  const data = fromInbox(
    dropped([
      timed("Focus time", "09:00", "12:00", { type: "focusTime" }),
      timed("Dentist", "14:00", "15:00", { type: "outOfOffice" }),
      timed("Office", "08:00", "18:00", { type: "workingLocation" }),
      timed("Sync", "13:00", "13:30"),
    ]),
    ctx(),
  );
  assert.deepEqual(
    data.events.map((e) => [e.title, e.block ?? null]),
    [
      ["Focus time", "focus"],
      ["Sync", null],
      ["Dentist", "away"],
    ],
  );
  assert.equal(data.dayClass, "open"); // one half-hour meeting
  assert.equal(data.headline, "The day is yours, Clem.");
});

test("all-day events use plain dates, and an event is kept only if it touches the day", () => {
  const data = fromInbox(
    dropped([
      { title: "Release freeze", start: "2026-11-24", end: "2026-11-27", allDay: true },
      { title: "Yesterday", start: "2026-11-24", end: "2026-11-25", allDay: true },
      { title: "Tomorrow's thing", start: "2026-11-26T09:00:00+11:00", end: "2026-11-26T10:00:00+11:00" },
      { title: "From UTC", start: "2026-11-25T03:00:00Z", end: "2026-11-25T03:30:00Z" },
    ]),
    ctx(),
  );
  assert.deepEqual(
    data.events.map((e) => [e.title, e.allDay, e.weight]),
    [
      ["Release freeze", true, 1],
      ["From UTC", false, 2],
    ],
  );
  assert.equal(data.events[0]!.start, Date.parse("2026-11-23T13:00:00Z")); // Sydney midnight on the 24th
});

test("the same meeting on two calendars is listed once, and a missing title is filled in", () => {
  const data = fromInbox(
    dropped([
      timed("Sync", "13:00", "13:30", { calendar: "mine" }),
      timed("Sync", "13:00", "13:30", { calendar: "team" }),
      { start: "2026-11-25T14:00:00+11:00", end: "2026-11-25T14:15:00+11:00" },
    ]),
    ctx(),
  );
  assert.deepEqual(
    data.events.map((e) => e.title),
    ["Sync", "(no title)"],
  );
});

test("a missing or odd date falls back to today", () => {
  assert.equal(fromInbox({ events: [] }, ctx()).date, "2026-11-25");
  assert.equal(fromInbox({ date: "today", events: [] }, ctx()).date, "2026-11-25");
  const other = fromInbox(dropped([{ title: "Old", start: "2026-11-24T09:00:00+11:00", end: "2026-11-24T10:00:00+11:00" }], "2026-11-24"), ctx());
  assert.equal(other.date, "2026-11-24");
  assert.deepEqual(
    other.events.map((e) => e.title),
    ["Old"],
  );
});

test("a file in the wrong shape is refused with a reason", () => {
  assert.throws(() => fromInbox(null, ctx()), /calendar inbox/);
  assert.throws(() => fromInbox({ date: "2026-11-25" }, ctx()), /events/);
  assert.throws(() => fromInbox(dropped([{ title: "No times" }]), ctx()), /events\[0\].*start/);
  assert.throws(() => fromInbox(dropped([timed("Ok", "09:00", "10:00"), { title: "Bad", start: "soon", end: "later" }]), ctx()), /events\[1\]/);
  assert.throws(() => fromInbox(dropped(["nope" as unknown as object]), ctx()), /events\[0\]/);
});

test("with the inbox transport, collect reads the dropped file and draws it", async () => {
  const c = ctx();
  writeJson(c.paths.inbox("calendar"), dropped([timed("Standup <b>", "09:30", "09:45"), timed("Focus", "10:00", "12:00", { type: "focusTime" })]));
  const envelope = await collectSource(calendar, c);
  assert.equal(envelope.ok, true);
  const [panel] = calendar.panels(envelope.data as never, { ...view, config: c.config });
  assert.ok(panel!.html.includes('<li><span class="time">09:30–09:45</span> Standup &lt;b&gt;</li>'));
  assert.ok(panel!.html.includes('<li class="block"><span class="time">10:00–12:00</span> Focus <span class="tag">focus</span></li>'));
  assert.ok(panel!.html.includes("One meeting today, Clem, at 09:30.") || panel!.html.includes("The day is yours, Clem."));
});

test("with the inbox transport, doctor checks the dropped file instead of the calendar address", async () => {
  const c = ctx();
  const missing = await calendar.doctor(c);
  assert.deepEqual(
    missing.map((check) => [check.name, check.ok, check.fix]),
    [["inbox file", false, "run /calendar-read in Claude, in this folder"]],
  );

  writeJson(c.paths.inbox("calendar"), dropped([timed("Standup", "09:30", "09:45"), timed("Sync", "13:00", "13:30")]));
  const good = await calendar.doctor(c);
  assert.deepEqual(
    good.map((check) => [check.name, check.ok]),
    [["inbox file", true]],
  );
  assert.match(good[0]!.detail, /2 events for 2026-11-25/);

  writeJson(c.paths.inbox("calendar"), { events: "none" });
  const bad = await calendar.doctor(c);
  assert.equal(bad[0]!.ok, false);
  assert.match(bad[0]!.detail, /events must be a list/);
});

test("a timed entry that runs for a day or more (a week-long roster) is treated as all-day", () => {
  const data = fromInbox(
    dropped([
      { title: "Chris on roster", start: "2026-11-23T10:00:00+11:00", end: "2026-11-27T17:00:00+11:00", calendar: "Team" },
      timed("Standup", "12:00", "12:15"),
    ]),
    ctx(),
  );
  assert.deepEqual(
    data.events.map((e) => [e.title, e.allDay, e.optional, e.weight]),
    [
      ["Chris on roster", true, false, 1],
      ["Standup", false, false, 1],
    ],
  );
  const [panel] = calendar.panels(data, { ...view, config: ctx().config });
  assert.ok(panel!.html.includes('<p class="all-day">All day: Chris on roster</p>'));
  assert.equal(panel!.html.match(/<li/g)!.length, 1);
});
