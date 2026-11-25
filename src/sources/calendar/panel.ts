import { fromZoned, hhmm, isoDate, parseHhmm } from "../../core/time.ts";
import type { Panel, View } from "../../core/types.ts";
import { esc } from "../../render/html.ts";
import { terrainPath } from "./terrain.ts";
import type { CalEvent, CalendarData } from "./types.ts";

const WIDTH = 840;
const HEIGHT = 170;

/** The instant of an `HH:MM` clock time on the local day `YYYY-MM-DD`. */
function clockOn(date: string, clock: string, tz: string): number {
  const [year = 1970, month = 1, day = 1] = date.split("-").map(Number);
  const minutes = parseHhmm(clock);
  return fromZoned({ year, month, day, hour: Math.floor(minutes / 60), minute: minutes % 60 }, tz);
}

function row(event: CalEvent, tz: string): string {
  const time = `<span class="time">${hhmm(event.start, tz)}–${hhmm(event.end, tz)}</span>`;
  if (!event.optional) return `<li>${time} ${esc(event.title)}</li>`;
  return `<li class="optional">${time} ${esc(event.title)} <span class="tag">optional</span></li>`;
}

/**
 * Today: one line about the day, its shape as a line of hills, then the meetings.
 * All-day events sit on one line above the list.
 */
export function calendarPanels(data: CalendarData, view: View): Panel[] {
  const tz = view.config.me.timezone;
  const { dayStart, dayEnd } = view.config.calendar;
  const path = terrainPath(data.events, { dayStart: clockOn(data.date, dayStart, tz), dayEnd: clockOn(data.date, dayEnd, tz), width: WIDTH, height: HEIGHT });

  const allDay = data.events.filter((e) => e.allDay);
  const timed = data.events.filter((e) => !e.allDay);

  const parts: string[] = [];
  if (data.date !== isoDate(view.now, tz)) {
    parts.push(`<p class="quiet">These are for ${esc(data.date)}; today has not been read yet.</p>`);
  }
  parts.push(`<p class="headline">${esc(data.headline)}</p>`);
  parts.push(`<svg class="terrain" viewBox="0 0 ${WIDTH} ${HEIGHT}" preserveAspectRatio="none" role="img" aria-label="The shape of the day">
<path d="${path}" />
</svg>`);
  if (allDay.length > 0) parts.push(`<p class="all-day">All day: ${allDay.map((e) => esc(e.title)).join(", ")}</p>`);
  parts.push(
    timed.length > 0
      ? `<ul class="events">\n${timed.map((e) => row(e, tz)).join("\n")}\n</ul>`
      : '<p class="quiet">No meetings today.</p>',
  );
  if (data.unsupported.length > 0) {
    parts.push(`<p class="quiet">Not understood: ${data.unsupported.map((t) => esc(t)).join(", ")}</p>`);
  }

  return [{ id: "today", title: "Today", tint: "butter", size: "short", html: parts.join("\n") }];
}
