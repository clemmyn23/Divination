import { fromZoned } from "../../core/time.ts";
import type { IcsTime, RawEvent } from "./types.ts";

const DAY = 86_400_000;

interface Line {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** Split on a separator, leaving anything inside double quotes alone. */
function splitOutsideQuotes(text: string, separator: string): string[] {
  const parts: string[] = [];
  let quoted = false;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') quoted = !quoted;
    else if (text[i] === separator && !quoted) {
      parts.push(text.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(text.slice(from));
  return parts;
}

/** `NAME;PARAM=value;PARAM="quoted: value":the value` */
function parseLine(line: string): Line | undefined {
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ":" && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return undefined;

  const [name = "", ...rest] = splitOutsideQuotes(line.slice(0, colon), ";");
  const params: Record<string, string> = {};
  for (const part of rest) {
    const eq = part.indexOf("=");
    if (eq > 0) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

function unescapeText(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

const TIME = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/;

function icsTime(value: string, params: Record<string, string>): IcsTime {
  const v = value.trim();
  return { value: v, ...(params.TZID ? { tzid: params.TZID } : {}), dateOnly: params.VALUE === "DATE" || /^\d{8}$/.test(v) };
}

const zoneKnown = new Map<string, boolean>();

function isKnownZone(tz: string): boolean {
  let known = zoneKnown.get(tz);
  if (known === undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      known = true;
    } catch {
      known = false;
    }
    zoneKnown.set(tz, known);
  }
  return known;
}

/**
 * The timezone a calendar time is written in: UTC for a `Z` time, its own `TZID` when
 * that is a name this machine knows, otherwise mine. All-day dates are always mine.
 */
export function zoneOf(t: IcsTime, fallbackTz: string): string {
  if (t.dateOnly) return fallbackTz;
  if (t.value.endsWith("Z")) return "UTC";
  return t.tzid && isKnownZone(t.tzid) ? t.tzid : fallbackTz;
}

/** The instant a calendar time refers to, or NaN when it cannot be read. */
export function toEpoch(t: IcsTime, fallbackTz: string): number {
  const m = TIME.exec(t.value);
  if (!m) return Number.NaN;
  const wall = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: t.dateOnly ? 0 : Number(m[4] ?? 0),
    minute: t.dateOnly ? 0 : Number(m[5] ?? 0),
    second: t.dateOnly ? 0 : Number(m[6] ?? 0),
  };
  return fromZoned(wall, zoneOf(t, fallbackTz));
}

const DURATION = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

function durationMs(value: string): number | undefined {
  const m = DURATION.exec(value.trim());
  if (!m) return undefined;
  const n = (i: number) => Number(m[i] ?? 0);
  const ms = n(2) * 7 * DAY + n(3) * DAY + n(4) * 3_600_000 + n(5) * 60_000 + n(6) * 1000;
  return m[1] === "-" ? 0 : ms;
}

function parseRule(value: string): Record<string, string> {
  const rule: Record<string, string> = {};
  for (const part of value.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) rule[part.slice(0, eq).trim().toUpperCase()] = part.slice(eq + 1).trim().toUpperCase();
  }
  return rule;
}

interface Draft {
  uid?: string;
  summary?: string;
  start?: IcsTime;
  end?: IcsTime;
  durationMs?: number;
  rrule?: Record<string, string>;
  exdates: IcsTime[];
  recurrenceId?: IcsTime;
  status?: string;
  myPartstat?: string;
}

function finish(draft: Draft): RawEvent | undefined {
  if (!draft.start || !TIME.test(draft.start.value)) return undefined;
  const hasEnd = draft.end !== undefined && TIME.test(draft.end.value);
  const length = hasEnd ? undefined : (draft.durationMs ?? (draft.start.dateOnly ? DAY : 0));
  return {
    uid: draft.uid ?? "",
    summary: draft.summary ?? "",
    start: draft.start,
    end: hasEnd ? draft.end! : draft.start,
    ...(length === undefined ? {} : { durationMs: length }),
    ...(draft.rrule ? { rrule: draft.rrule } : {}),
    exdates: draft.exdates,
    ...(draft.recurrenceId ? { recurrenceId: draft.recurrenceId } : {}),
    ...(draft.status ? { status: draft.status } : {}),
    ...(draft.myPartstat ? { myPartstat: draft.myPartstat } : {}),
  };
}

/**
 * Read the events out of an iCalendar file. Long lines folded across several are
 * joined, text escapes are undone, and anything nested inside an event (a reminder)
 * is skipped. `myEmail` finds my own answer on the attendee list.
 */
export function parseIcs(text: string, myEmail: string): RawEvent[] {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const me = myEmail.trim().toLowerCase();
  const events: RawEvent[] = [];
  let draft: Draft | undefined;
  let nested = 0;

  for (const raw of lines) {
    const line = parseLine(raw);
    if (!line) continue;

    if (line.name === "BEGIN") {
      if (draft) nested++;
      else if (line.value.trim().toUpperCase() === "VEVENT") draft = { exdates: [] };
      continue;
    }
    if (line.name === "END") {
      if (draft && nested > 0) nested--;
      else if (draft && line.value.trim().toUpperCase() === "VEVENT") {
        const event = finish(draft);
        if (event) events.push(event);
        draft = undefined;
      }
      continue;
    }
    if (!draft || nested > 0) continue;

    switch (line.name) {
      case "UID":
        draft.uid = line.value.trim();
        break;
      case "SUMMARY":
        draft.summary = unescapeText(line.value).trim();
        break;
      case "DTSTART":
        draft.start = icsTime(line.value, line.params);
        break;
      case "DTEND":
        draft.end = icsTime(line.value, line.params);
        break;
      case "DURATION":
        draft.durationMs = durationMs(line.value);
        break;
      case "RRULE":
        draft.rrule = parseRule(line.value);
        break;
      case "EXDATE":
        for (const value of line.value.split(",")) {
          if (value.trim()) draft.exdates.push(icsTime(value, line.params));
        }
        break;
      case "RECURRENCE-ID":
        draft.recurrenceId = icsTime(line.value, line.params);
        break;
      case "STATUS":
        draft.status = line.value.trim().toUpperCase();
        break;
      case "ATTENDEE":
        if (me && line.value.trim().toLowerCase().replace(/^mailto:/, "") === me && line.params.PARTSTAT) {
          draft.myPartstat = line.params.PARTSTAT.toUpperCase();
        }
        break;
    }
  }
  return events;
}
