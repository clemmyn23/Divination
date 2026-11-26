import { zoned } from "../../core/time.ts";
import type { Context } from "../../core/types.ts";

const MONDAY = 1;

/**
 * The instant Slack is read from: `slack.windowHours` back, or `slack.mondayWindowHours`
 * back on a Monday where I am, so the weekend does not use up the window. A Monday never
 * reads less than another day would.
 */
export function windowStart(ctx: Context): number {
  const now = ctx.now();
  const { windowHours, mondayWindowHours } = ctx.config.slack;
  const monday = zoned(now, ctx.config.me.timezone).weekday === MONDAY;
  return now - (monday ? Math.max(windowHours, mondayWindowHours) : windowHours) * 3_600_000;
}
