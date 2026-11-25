/** A date or time as the calendar file wrote it, e.g. `20261125T093000`, `20261125T223000Z` or `20261125`. */
export interface IcsTime {
  value: string;
  tzid?: string;
  dateOnly: boolean;
}

/** One `VEVENT` from the calendar file, before recurrence is worked out. */
export interface RawEvent {
  uid: string;
  summary: string;
  start: IcsTime;
  /** The same as `start` when the file gave no `DTEND`; see `durationMs`. */
  end: IcsTime;
  /** Set when the file gave a `DURATION`, or no end at all, instead of `DTEND`. */
  durationMs?: number;
  rrule?: Record<string, string>;
  exdates: IcsTime[];
  recurrenceId?: IcsTime;
  status?: string;
  /** My own answer to the invitation, when I am on the attendee list. */
  myPartstat?: string;
}

/** One thing on the day, in epoch milliseconds. */
export interface CalEvent {
  start: number;
  end: number;
  title: string;
  allDay: boolean;
  /** I have not accepted it yet. */
  optional: boolean;
  /** How much of the day it takes: 1 under half an hour, 2 up to an hour, 3 longer. */
  weight: 1 | 2 | 3;
  /** Time I set aside myself (focus time, being away) rather than a meeting. Shown, but not counted or drawn. */
  block?: "focus" | "away";
}

export type DayClass = "heavy" | "normal" | "open";

export interface CalendarData {
  /** The local day the events are for, as `YYYY-MM-DD`. */
  date: string;
  events: CalEvent[];
  dayClass: DayClass;
  headline: string;
  /** Titles of repeating events whose rule this tool cannot work out. */
  unsupported: string[];
}
