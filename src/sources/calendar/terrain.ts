import type { CalEvent } from "./types.ts";

/** How far below the top of the drawing the flat line sits. */
const GROUND_MARGIN = 20;
/** How much higher each step of weight lifts the line. */
const LIFT = 40;

const num = (n: number) => String(Math.round(n * 10) / 10);

/**
 * The day drawn as a line: flat when free, lifted into a hill over each meeting, taller
 * for longer ones. Returns the `d` of an SVG path that runs from the left edge to the
 * right edge and never doubles back. Meetings are clamped to the day; ones that overlap
 * share a hill as tall as the tallest of them.
 */
export function terrainPath(
  events: CalEvent[],
  opts: { dayStart: number; dayEnd: number; width?: number; height?: number },
): string {
  const width = opts.width ?? 840;
  const height = opts.height ?? 170;
  const ground = height - GROUND_MARGIN;
  const span = opts.dayEnd - opts.dayStart;
  const x = (t: number) => ((t - opts.dayStart) / span) * width;

  const hills: { from: number; to: number; weight: number }[] = [];
  const timed = events
    .filter((e) => !e.allDay && !e.block)
    .map((e) => ({ from: Math.max(e.start, opts.dayStart), to: Math.min(e.end, opts.dayEnd), weight: e.weight }))
    .filter((e) => e.to > e.from)
    .sort((a, b) => a.from - b.from);
  for (const e of timed) {
    const last = hills[hills.length - 1];
    if (last && e.from < last.to) {
      last.to = Math.max(last.to, e.to);
      last.weight = Math.max(last.weight, e.weight);
    } else {
      hills.push({ ...e });
    }
  }

  let d = `M0,${num(ground)}`;
  let at = 0;
  for (const hill of hills) {
    const x1 = x(hill.from);
    const x2 = x(hill.to);
    const mid = (x1 + x2) / 2;
    const k = (x2 - x1) / 4;
    const peak = ground - hill.weight * LIFT;
    if (x1 > at) d += ` L${num(x1)},${num(ground)}`;
    d += ` C${num(x1 + k)},${num(ground)} ${num(mid - k)},${num(peak)} ${num(mid)},${num(peak)}`;
    d += ` C${num(mid + k)},${num(peak)} ${num(x2 - k)},${num(ground)} ${num(x2)},${num(ground)}`;
    at = x2;
  }
  if (at < width) d += ` L${num(width)},${num(ground)}`;
  return d;
}
