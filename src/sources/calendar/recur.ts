import { endOfDay, fromZoned, zoned } from "../../core/time.ts";
import { toEpoch, zoneOf } from "./ics.ts";
import type { RawEvent } from "./types.ts";

const DAY = 86_400_000;
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
/** A repeating event that runs longer than this is only looked for this many days back. */
const MAX_LOOKBACK_DAYS = 7;

const COMMON = ["FREQ", "INTERVAL", "UNTIL", "COUNT", "WKST"];
const EXTRA: Record<string, string[]> = {
  DAILY: [],
  WEEKLY: ["BYDAY"],
  MONTHLY: ["BYDAY", "BYMONTHDAY"],
  YEARLY: ["BYMONTH", "BYMONTHDAY"],
};

const PLAIN_DAY = /^(SU|MO|TU|WE|TH|FR|SA)$/;
const NTH_DAY = /^([+-]?[1-5])(SU|MO|TU|WE|TH|FR|SA)$/;
const WHOLE = /^[1-9]\d*$/;

const list = (value: string | undefined): string[] => (value ? value.split(",").map((v) => v.trim()) : []);

/**
 * Whether this tool can work out when a repeating event falls. Understood: daily;
 * weekly, on named weekdays; monthly, on a day of the month or the nth weekday; yearly,
 * on the same date. Each with INTERVAL, UNTIL, COUNT and WKST. Anything else is not.
 */
export function isSupported(rrule: Record<string, string>): boolean {
  const freq = rrule.FREQ ?? "";
  const extra = EXTRA[freq];
  if (!extra) return false;
  if (!Object.keys(rrule).every((key) => COMMON.includes(key) || extra.includes(key))) return false;

  if (rrule.INTERVAL !== undefined && !WHOLE.test(rrule.INTERVAL)) return false;
  if (rrule.COUNT !== undefined && !WHOLE.test(rrule.COUNT)) return false;
  if (rrule.WKST !== undefined && !PLAIN_DAY.test(rrule.WKST)) return false;

  const byDay = list(rrule.BYDAY);
  const byMonthDay = list(rrule.BYMONTHDAY);
  if (freq === "WEEKLY") return byDay.every((d) => PLAIN_DAY.test(d));
  if (freq === "MONTHLY") {
    if (byDay.length > 0 && byMonthDay.length > 0) return false;
    return byDay.every((d) => NTH_DAY.test(d)) && byMonthDay.every((d) => /^-?[1-9]\d?$/.test(d));
  }
  if (freq === "YEARLY") {
    return (rrule.BYMONTH === undefined || WHOLE.test(rrule.BYMONTH)) && byMonthDay.length <= 1 && byMonthDay.every((d) => WHOLE.test(d));
  }
  return true;
}

/** A calendar date with no time or timezone, counted in whole days since 1970. */
interface Civil {
  n: number;
  year: number;
  month: number; // 1-12
  day: number;
  weekday: number; // 0 is Sunday
}

function civil(n: number): Civil {
  const d = new Date(n * DAY);
  return { n, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), weekday: d.getUTCDay() };
}

const dayNumber = (year: number, month: number, day: number) => Math.floor(Date.UTC(year, month - 1, day) / DAY);
const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** Whether the rule lands on date `d`, for a series whose first date is `s`. COUNT, UNTIL and EXDATE are checked elsewhere. */
function lands(rrule: Record<string, string>, s: Civil, d: Civil): boolean {
  if (d.n < s.n) return false;
  const interval = Number(rrule.INTERVAL ?? 1);

  switch (rrule.FREQ) {
    case "DAILY":
      return (d.n - s.n) % interval === 0;

    case "WEEKLY": {
      const days = list(rrule.BYDAY);
      if (days.length > 0 ? !days.includes(WEEKDAYS[d.weekday]!) : d.weekday !== s.weekday) return false;
      // 1 January 1970 was a Thursday, so day n is weekday (n + 4) % 7.
      const weekStart = WEEKDAYS.indexOf(rrule.WKST ?? "MO");
      const week = (c: Civil) => Math.floor((c.n + 4 - weekStart) / 7);
      return (week(d) - week(s)) % interval === 0;
    }

    case "MONTHLY": {
      if ((d.year * 12 + d.month - (s.year * 12 + s.month)) % interval !== 0) return false;
      const fromEnd = d.day - daysInMonth(d.year, d.month) - 1; // -1 on the last day
      const byMonthDay = list(rrule.BYMONTHDAY).map(Number);
      if (byMonthDay.length > 0) return byMonthDay.includes(d.day) || byMonthDay.includes(fromEnd);
      const byDay = list(rrule.BYDAY);
      if (byDay.length > 0) {
        const nth = Math.ceil(d.day / 7);
        const nthFromEnd = -Math.ceil(-fromEnd / 7);
        return byDay.some((entry) => {
          const m = NTH_DAY.exec(entry);
          return m !== null && m[2] === WEEKDAYS[d.weekday] && (Number(m[1]) === nth || Number(m[1]) === nthFromEnd);
        });
      }
      return d.day === s.day;
    }

    case "YEARLY": {
      if ((d.year - s.year) % interval !== 0) return false;
      const month = Number(rrule.BYMONTH ?? s.month);
      const day = Number(list(rrule.BYMONTHDAY)[0] ?? s.day);
      return d.month === month && d.day === day;
    }
  }
  return false;
}

const yyyymmdd = (c: Civil) => `${c.year}${String(c.month).padStart(2, "0")}${String(c.day).padStart(2, "0")}`;

function lengthOf(ev: RawEvent, tz: string): number {
  return Math.max(0, ev.durationMs ?? toEpoch(ev.end, tz) - toEpoch(ev.start, tz));
}

/** The instant a rule's UNTIL allows up to, inclusive. A bare date allows the whole of that day. */
export function untilOf(rrule: Record<string, string>, zone: string): number | undefined {
  if (!rrule.UNTIL) return undefined;
  const dateOnly = /^\d{8}$/.test(rrule.UNTIL);
  const at = toEpoch({ value: rrule.UNTIL, dateOnly }, zone);
  if (Number.isNaN(at)) return undefined;
  return dateOnly ? endOfDay(at, zone) - 1 : at;
}

/**
 * The occurrence of an event that touches the local day starting at `dayStart`, if there
 * is one. A repeating event keeps the clock time it was given in its own timezone, so it
 * does not drift when daylight saving changes. A rule that is not understood gives nothing.
 */
export function occurrenceOn(ev: RawEvent, dayStart: number, tz: string): { start: number; end: number } | undefined {
  const dayEnd = endOfDay(dayStart, tz);
  const first = toEpoch(ev.start, tz);
  const length = lengthOf(ev, tz);
  if (Number.isNaN(first)) return undefined;

  const touches = (start: number) => start < dayEnd && (start + length > dayStart || (length === 0 && start >= dayStart));

  if (!ev.rrule) return touches(first) ? { start: first, end: first + length } : undefined;
  if (!isSupported(ev.rrule)) return undefined;

  const zone = zoneOf(ev.start, tz);
  const wall = zoned(first, zone);
  const s = civil(dayNumber(wall.year, wall.month, wall.day));
  const until = untilOf(ev.rrule, zone);
  const count = ev.rrule.COUNT === undefined ? undefined : Number(ev.rrule.COUNT);

  // The dates, in the event's own timezone, on which an occurrence could touch my day.
  const earliest = zoned(dayStart - Math.min(length, MAX_LOOKBACK_DAYS * DAY), zone);
  const latest = zoned(dayEnd - 1, zone);
  const to = dayNumber(latest.year, latest.month, latest.day);

  for (let n = dayNumber(earliest.year, earliest.month, earliest.day); n <= to; n++) {
    const d = civil(n);
    if (!lands(ev.rrule, s, d)) continue;

    const start = ev.start.dateOnly
      ? fromZoned({ year: d.year, month: d.month, day: d.day }, zone)
      : fromZoned({ year: d.year, month: d.month, day: d.day, hour: wall.hour, minute: wall.minute, second: wall.second }, zone);
    if (!touches(start)) continue;
    if (until !== undefined && start > until) continue;

    if (count !== undefined) {
      let before = 0;
      for (let k = s.n; k < n && before < count; k++) if (lands(ev.rrule, s, civil(k))) before++;
      if (before >= count) continue;
    }

    const excluded = ev.exdates.some((x) => (x.dateOnly ? x.value.slice(0, 8) === yyyymmdd(d) : toEpoch(x, tz) === start));
    if (excluded) continue;

    return { start, end: start + length };
  }
  return undefined;
}
