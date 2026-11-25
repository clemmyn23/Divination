import { HttpError } from "../../core/http.ts";
import { readDropped } from "../../core/store.ts";
import { isoDate, startOfDay } from "../../core/time.ts";
import type { Check, Context, Source } from "../../core/types.ts";
import { dayClass, eventsForDay, headline } from "./day.ts";
import { parseIcs } from "./ics.ts";
import { fromInbox } from "./inbox.ts";
import { calendarPanels } from "./panel.ts";
import type { CalendarData } from "./types.ts";

/** The secret that holds the calendar's private iCal address. */
const SECRET = "calendar_ics";
const SET_IT = `divination secret set ${SECRET}`;
const CLASSES = ["heavy", "normal", "open"];

/**
 * Fetch the calendar file. The address is itself a secret (anyone holding it can read
 * the calendar), so no error raised here ever contains it.
 */
async function fetchCalendar(ctx: Context): Promise<string> {
  const address = (await ctx.secrets.get(SECRET))?.trim();
  if (!address) throw new Error(`no calendar address; run: ${SET_IT}`);

  const url = address.replace(/^webcals?:\/\//i, "https://");
  if (!url.startsWith("https://")) throw new Error("the calendar address must start with https:// or webcal://");

  let text: string;
  try {
    text = (await ctx.http.text(url)).data;
  } catch (e) {
    if (e instanceof HttpError) throw new Error(`the calendar address answered HTTP ${e.status}`);
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(message.replaceAll(url, "the calendar address").replaceAll(address, "the calendar address"));
  }
  if (!text.includes("BEGIN:VCALENDAR")) throw new Error("the calendar address did not return a calendar");
  return text;
}

async function collect(ctx: Context): Promise<CalendarData> {
  const { name, email, timezone } = ctx.config.me;
  const raw = parseIcs(await fetchCalendar(ctx), email);
  const now = ctx.now();
  const { events, unsupported } = eventsForDay(raw, startOfDay(now, timezone), timezone);
  const cls = dayClass(events);
  return { date: isoDate(now, timezone), events, dayClass: cls, headline: headline(cls, events, name, timezone), unsupported };
}

function validate(data: unknown): string[] {
  if (typeof data !== "object" || data === null) return ["calendar data must be an object"];
  const d = data as Partial<Record<keyof CalendarData, unknown>>;
  const problems: string[] = [];
  if (typeof d.date !== "string") problems.push("date must be a string");
  if (!Array.isArray(d.events)) problems.push("events must be a list");
  if (!CLASSES.includes(d.dayClass as string)) problems.push(`dayClass must be one of ${CLASSES.join(", ")}`);
  if (typeof d.headline !== "string") problems.push("headline must be a string");
  if (!Array.isArray(d.unsupported)) problems.push("unsupported must be a list");
  return problems;
}

/** For the inbox transport: is there a dropped file, and can it be read? */
function inboxCheck(ctx: Context): Check {
  const fix = "run /calendar-read in Claude, in this folder";
  try {
    const dropped = readDropped(ctx.paths.inbox("calendar"), "out/inbox/calendar.json");
    if (dropped === undefined) return { name: "inbox file", ok: false, detail: "nothing has been read into out/inbox/calendar.json yet", fix };
    const data = fromInbox(dropped, ctx);
    const n = data.events.length;
    return { name: "inbox file", ok: true, detail: `${n} ${n === 1 ? "event" : "events"} for ${data.date}` };
  } catch (e) {
    return { name: "inbox file", ok: false, detail: e instanceof Error ? e.message : String(e), fix };
  }
}

async function doctor(ctx: Context): Promise<Check[]> {
  if (ctx.config.calendar.transport === "inbox") return [inboxCheck(ctx)];
  if (!(await ctx.secrets.get(SECRET))) {
    return [{ name: "address", ok: false, detail: "no calendar address is stored", fix: SET_IT }];
  }
  const checks: Check[] = [{ name: "address", ok: true, detail: "a calendar address is stored" }];
  try {
    const count = parseIcs(await fetchCalendar(ctx), ctx.config.me.email).length;
    checks.push({ name: "calendar file", ok: true, detail: `${count} events in the calendar file` });
  } catch (e) {
    checks.push({ name: "calendar file", ok: false, detail: e instanceof Error ? e.message : String(e), fix: SET_IT });
  }
  return checks;
}

/**
 * Today's meetings: fetched from the calendar's private iCal address, or, with the inbox
 * transport, taken from the file a calendar read dropped (see `prompts/calendar-read.md`).
 */
export const calendar: Source<CalendarData> = {
  id: "calendar",
  title: "Today",
  doctor,
  collect,
  fromInbox,
  validate,
  attention: () => [],
  panels: calendarPanels,
};
