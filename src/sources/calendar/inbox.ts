import { endOfDay, fromZoned, isoDate } from "../../core/time.ts";
import type { Context } from "../../core/types.ts";
import { dayClass, headline, weightOf } from "./day.ts";
import type { CalEvent, CalendarData } from "./types.ts";

// What a calendar read drops in `out/inbox/calendar.json`. It is written by an LLM, so it
// is kept as plain as possible and nothing in it is trusted to be worked out already:
//
//   { "date": "2026-11-25",
//     "events": [
//       { "title": "Standup",
//         "start": "2026-11-25T09:30:00+11:00",   // or "2026-11-25" for an all-day event
//         "end": "2026-11-25T09:45:00+11:00",     // all-day: the day after the last day
//         "allDay": false,
//         "response": "accepted",                 // my answer: accepted | declined | tentative | needsAction
//         "optional": false,                      // I was invited as an optional guest
//         "type": "default",                      // default | focusTime | outOfOffice | workingLocation
//         "cancelled": false,
//         "calendar": "primary" } ] }             // "primary" for my own calendar, else the calendar's name
//
// Only `start` is required of an event. See `prompts/calendar-read.md`.

const DAY = 86_400_000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/;

/** `needsAction`, `NEEDS_ACTION` and `needs-action` all read the same. */
const plain = (value: unknown) => (typeof value === "string" ? value.toLowerCase().replace(/[^a-z]/g, "") : "");

/** The instant a date or time in the file refers to, or NaN. A time with no offset is on my clock. */
function instant(value: unknown, tz: string): number {
  if (typeof value !== "string") return Number.NaN;
  const v = value.trim();
  const date = DATE.exec(v);
  if (date) return fromZoned({ year: Number(date[1]), month: Number(date[2]), day: Number(date[3]) }, tz);
  const local = LOCAL_TIME.exec(v);
  if (local) {
    const [year, month, day, hour, minute, second] = local.slice(1).map((n) => Number(n ?? 0));
    return fromZoned({ year: year!, month: month!, day: day!, hour, minute, second }, tz);
  }
  return Date.parse(v);
}

/**
 * Turn the plain events a calendar read dropped into the day's data. Code, not the
 * reader, decides what counts: events that do not touch the day, ones I declined,
 * cancelled ones and working-location markers are left out; focus time and time away
 * are kept as my own blocks; timed events on other people's calendars are optional;
 * the weights, the day's class and the headline are worked out here.
 */
export function fromInbox(dropped: unknown, ctx: Context): CalendarData {
  if (typeof dropped !== "object" || dropped === null) throw new Error("calendar inbox must be an object");
  const file = dropped as { date?: unknown; events?: unknown };
  if (!Array.isArray(file.events)) throw new Error("calendar inbox: events must be a list");

  const { name, timezone: tz } = ctx.config.me;
  const date = typeof file.date === "string" && DATE.test(file.date) ? file.date : isoDate(ctx.now(), tz);
  const dayStart = instant(date, tz);
  const dayEnd = endOfDay(dayStart, tz);

  interface Read {
    start: number;
    end: number;
    allDay: boolean;
    mine: boolean;
    raw: Record<string, unknown>;
  }

  // Check every event first, so a bad one is reported by its place in the file.
  const read: Read[] = file.events.map((raw: unknown, i: number) => {
    if (typeof raw !== "object" || raw === null) throw new Error(`calendar inbox: events[${i}] must be an object`);
    const e = raw as Record<string, unknown>;

    const start = instant(e.start, tz);
    if (Number.isNaN(start)) throw new Error(`calendar inbox: events[${i}] has no readable start`);
    const allDay = e.allDay === true || (typeof e.start === "string" && DATE.test(e.start.trim()));
    const end = e.end === undefined || e.end === null ? start + (allDay ? DAY : 0) : instant(e.end, tz);
    if (Number.isNaN(end)) throw new Error(`calendar inbox: events[${i}] has no readable end`);

    const calendar = plain(e.calendar);
    // A timed entry that runs for a day or more (a week-long roster) is background, not a meeting.
    const wholeDay = allDay || end - start >= DAY;
    return { start, end: Math.max(end, start), allDay: wholeDay, mine: calendar === "" || calendar === "primary", raw: e };
  });

  // My own calendar first: an event that is also on a team calendar is then kept as mine.
  read.sort((a, b) => Number(b.mine) - Number(a.mine));

  const seen = new Set<string>();
  const events: CalEvent[] = [];

  for (const { start, end, allDay, mine, raw: e } of read) {
    const touchesDay = start < dayEnd && (end > dayStart || (end === start && start >= dayStart));
    const response = plain(e.response);
    const type = plain(e.type);
    if (!touchesDay || e.cancelled === true || response === "declined" || type === "workinglocation") continue;

    const title = typeof e.title === "string" && e.title.trim() !== "" ? e.title.trim() : "(no title)";
    const key = `${start}|${end}|${title}`;
    if (seen.has(key)) continue; // the same event on a second calendar
    seen.add(key);

    const block = type === "focustime" ? "focus" : type === "outofoffice" ? "away" : undefined;
    // Optional: I said maybe, I was invited as optional, or it is a timed event on a
    // calendar that is not mine (open to me, but nobody is expecting me).
    const optional = block === undefined && (response === "tentative" || e.optional === true || (!mine && !allDay));
    events.push({
      start,
      end,
      title,
      allDay,
      optional,
      weight: allDay ? 1 : weightOf((end - start) / 60_000),
      ...(block ? { block } : {}),
    });
  }

  events.sort((a, b) => a.start - b.start || a.end - b.end || a.title.localeCompare(b.title));
  const cls = dayClass(events);
  return { date, events, dayClass: cls, headline: headline(cls, events, name, tz), unsupported: [] };
}
