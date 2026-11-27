import type { Config } from "./types.ts";

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  second: number;
  weekday: number; // 0 is Sunday, as in JavaScript
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** The wall-clock reading of an instant in a timezone. */
export function zoned(ms: number, tz: string): ZonedParts {
  const got: Record<string, string> = {};
  for (const part of formatterFor(tz).formatToParts(new Date(ms))) got[part.type] = part.value;
  return {
    year: Number(got.year),
    month: Number(got.month),
    day: Number(got.day),
    hour: Number(got.hour) % 24,
    minute: Number(got.minute),
    second: Number(got.second),
    weekday: WEEKDAYS.indexOf(got.weekday ?? ""),
  };
}

/** How far the timezone's wall clock is ahead of UTC at an instant, in milliseconds. */
export function offsetAt(ms: number, tz: string): number {
  const p = zoned(ms, tz);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - Math.floor(ms / 1000) * 1000;
}

/** The instant a wall-clock reading in a timezone refers to. */
export function fromZoned(
  wall: { year: number; month: number; day: number; hour?: number; minute?: number; second?: number },
  tz: string,
): number {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour ?? 0, wall.minute ?? 0, wall.second ?? 0);
  // The offset can differ between the guess and the answer on a daylight-saving day, so settle it twice.
  const guess = asUtc - offsetAt(asUtc, tz);
  return asUtc - offsetAt(guess, tz);
}

/** Midnight at the start of the local day that contains `now`. */
export function startOfDay(now: number, tz: string): number {
  const p = zoned(now, tz);
  return fromZoned({ year: p.year, month: p.month, day: p.day }, tz);
}

/** Midnight at the end of the local day that starts at `dayStart`. A day is not always 24 hours long. */
export function endOfDay(dayStart: number, tz: string): number {
  return startOfDay(dayStart + 36 * 3_600_000, tz);
}

const two = (n: number) => String(n).padStart(2, "0");

/** The local date as `YYYY-MM-DD`. */
export function isoDate(ms: number, tz: string): string {
  const p = zoned(ms, tz);
  return `${p.year}-${two(p.month)}-${two(p.day)}`;
}

/** `HH:MM` on the 24-hour clock in a timezone. */
export function hhmm(ms: number, tz: string): string {
  const p = zoned(ms, tz);
  return `${two(p.hour)}:${two(p.minute)}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * When something happened, for a line of small print: the clock alone if it was today in
 * that timezone, otherwise the day as well ("Thu 26 Nov 14:05"), so that yesterday's time
 * does not read as today's.
 */
export function when(ms: number, now: number, tz: string): string {
  const clock = hhmm(ms, tz);
  if (isoDate(ms, tz) === isoDate(now, tz)) return clock;
  const p = zoned(ms, tz);
  return `${WEEKDAYS[p.weekday]} ${p.day} ${MONTHS[p.month - 1]} ${clock}`;
}

/** Minutes since midnight for an `HH:MM` string. */
export function parseHhmm(s: string): number {
  const [h, m] = s.split(":");
  return Number(h) * 60 + Number(m);
}

/** True on a configured weekday, from the start time up to but not including the end time. */
export function withinActiveHours(now: number, tick: Config["tick"], tz: string): boolean {
  const p = zoned(now, tz);
  if (!tick.days.includes(p.weekday)) return false;
  const minutes = p.hour * 60 + p.minute;
  return minutes >= parseHhmm(tick.start) && minutes < parseHhmm(tick.end);
}
