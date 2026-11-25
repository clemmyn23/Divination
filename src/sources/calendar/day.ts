import { endOfDay, hhmm } from "../../core/time.ts";
import { toEpoch, zoneOf } from "./ics.ts";
import { isSupported, occurrenceOn, untilOf } from "./recur.ts";
import type { CalEvent, DayClass, RawEvent } from "./types.ts";

const MINUTE = 60_000;
/** Meetings this close together count as back to back. */
const BACK_TO_BACK_GAP = 10 * MINUTE;
const HEAVY_MINUTES = 300;
const HEAVY_RUN = 3;
const OPEN_MAX_MINUTES = 30;

export function weightOf(minutes: number): 1 | 2 | 3 {
  if (minutes < 30) return 1;
  return minutes <= 60 ? 2 : 3;
}

const isDropped = (ev: RawEvent) => ev.status === "CANCELLED" || ev.myPartstat === "DECLINED";
// Only a "maybe" is optional. An invitation left unanswered is the normal state of a
// team's standing meetings, so it counts as a meeting.
const isOptional = (ev: RawEvent) => ev.myPartstat === "TENTATIVE";

/**
 * What is on the local day that starts at `dayStart`. Cancelled events and ones I
 * declined are left out. A single changed occurrence of a series replaces the one it
 * stands in for. Repeating events whose rule is not understood are named in
 * `unsupported` instead of being guessed at.
 */
export function eventsForDay(raw: RawEvent[], dayStart: number, tz: string): { events: CalEvent[]; unsupported: string[] } {
  const dayEnd = endOfDay(dayStart, tz);

  // uid -> the original start of every occurrence that has its own changed copy
  const replaced = new Map<string, Set<number>>();
  for (const ev of raw) {
    if (!ev.recurrenceId) continue;
    const at = toEpoch(ev.recurrenceId, tz);
    if (!replaced.has(ev.uid)) replaced.set(ev.uid, new Set());
    replaced.get(ev.uid)!.add(at);
  }

  const events: CalEvent[] = [];
  const unsupported = new Set<string>();

  for (const ev of raw) {
    const single = ev.recurrenceId !== undefined;
    const title = ev.summary || "(no title)";

    if (!single && ev.rrule && !isSupported(ev.rrule)) {
      const until = untilOf(ev.rrule, zoneOf(ev.start, tz));
      const running = toEpoch(ev.start, tz) < dayEnd && (until === undefined || until >= dayStart);
      if (running && !isDropped(ev)) unsupported.add(title);
      continue;
    }

    const occurrence = single ? occurrenceOn({ ...ev, rrule: undefined }, dayStart, tz) : occurrenceOn(ev, dayStart, tz);
    if (!occurrence) continue;
    if (!single && replaced.get(ev.uid)?.has(occurrence.start)) continue;
    if (isDropped(ev)) continue;

    // A timed event that runs for a day or more (a week on call) is background, not a meeting.
    const allDay = ev.start.dateOnly || occurrence.end - occurrence.start >= 86_400_000;
    events.push({
      start: occurrence.start,
      end: occurrence.end,
      title,
      allDay,
      optional: isOptional(ev),
      weight: allDay ? 1 : weightOf((occurrence.end - occurrence.start) / MINUTE),
    });
  }

  events.sort((a, b) => a.start - b.start || a.end - b.end || a.title.localeCompare(b.title));
  return { events, unsupported: [...unsupported] };
}

/** The meetings that shape the day: timed, accepted, and not time I blocked out myself. */
function meetings(events: CalEvent[]): CalEvent[] {
  return events.filter((e) => !e.allDay && !e.optional && !e.block).sort((a, b) => a.start - b.start);
}

/**
 * `heavy` with five hours or more of meetings, or three or more back to back; `open`
 * with at most one short meeting; otherwise `normal`.
 */
export function dayClass(events: CalEvent[]): DayClass {
  const day = meetings(events);
  const minutes = day.reduce((sum, e) => sum + (e.end - e.start) / MINUTE, 0);

  let run = 0;
  let longestRun = 0;
  let lastEnd = Number.NEGATIVE_INFINITY;
  for (const e of day) {
    run = e.start - lastEnd <= BACK_TO_BACK_GAP ? run + 1 : 1;
    longestRun = Math.max(longestRun, run);
    lastEnd = Math.max(lastEnd, e.end);
  }

  if (minutes >= HEAVY_MINUTES || longestRun >= HEAVY_RUN) return "heavy";
  if (day.length === 0 || (day.length === 1 && minutes <= OPEN_MAX_MINUTES)) return "open";
  return "normal";
}

/** One line about the day, for the top of the panel. */
export function headline(cls: DayClass, events: CalEvent[], name: string, tz: string): string {
  const day = meetings(events);
  const n = day.length;

  if (cls === "open" || n === 0) return `The day is yours, ${name}.`;
  if (cls === "heavy") {
    const lastEnd = Math.max(...day.map((e) => e.end));
    return `A full one, ${name}: ${n} ${n === 1 ? "meeting" : "meetings"}, the last ends at ${hhmm(lastEnd, tz)}.`;
  }
  if (n === 1) return `One meeting today, ${name}, at ${hhmm(day[0]!.start, tz)}.`;

  let gapStart = 0;
  let gap = 0;
  let lastEnd = day[0]!.end;
  for (const e of day.slice(1)) {
    if (e.start - lastEnd > gap) {
      gap = e.start - lastEnd;
      gapStart = lastEnd;
    }
    lastEnd = Math.max(lastEnd, e.end);
  }
  if (gap === 0) return `${n} meetings today, ${name}, with no gap between them.`;
  return `${n} meetings today, ${name}; the longest gap starts at ${hhmm(gapStart, tz)}.`;
}
