import assert from "node:assert/strict";
import { test } from "node:test";
import { terrainPath } from "./terrain.ts";
import type { CalEvent } from "./types.ts";

const wed = Date.parse("2026-11-24T13:00:00Z"); // Sydney midnight
const at = (hour: number) => wed + hour * 3_600_000;
const opts = { dayStart: at(8), dayEnd: at(18) };

function mins(start: number, length: number, over: Partial<CalEvent> = {}): CalEvent {
  return {
    start: wed + start * 60_000,
    end: wed + (start + length) * 60_000,
    title: "Meeting",
    allDay: false,
    optional: false,
    weight: 2,
    ...over,
  };
}

/** Every `x,y` pair in a path, control points included. */
function pairs(d: string): [number, number][] {
  return [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
}

test("terrain", () => {
  assert.equal(terrainPath([], opts), "M0,150 L840,150");
  const d = terrainPath([{ ...mins(720, 120), weight: 3 }], opts);
  assert.ok(d.startsWith("M0,150"));
  assert.ok(d.endsWith("840,150"));
  const p = pairs(d);
  assert.ok(Math.abs(Math.min(...p.map((q) => q[1])) - 30) <= 1);
  assert.ok(p.every((q) => q[0] >= 0 && q[0] <= 840));
  const clamped = terrainPath([{ ...mins(360, 60), weight: 1 }, { ...mins(1050, 150), weight: 2 }], opts);
  assert.ok(pairs(clamped).every((q) => q[0] >= 0 && q[0] <= 840));
});

test("a meeting lifts the line over its own span and nowhere else", () => {
  // 12:00 to 14:00 of an 08:00 to 18:00 day is x 336 to 504.
  const p = pairs(terrainPath([{ ...mins(720, 120), weight: 1 }], opts));
  const lifted = p.filter((q) => q[1] < 150);
  assert.ok(lifted.length > 0);
  assert.ok(lifted.every((q) => q[0] >= 336 && q[0] <= 504));
  assert.equal(Math.min(...p.map((q) => q[1])), 110); // weight 1 peaks 40 above the baseline
});

test("the line never doubles back, even when meetings overlap or arrive out of order", () => {
  const d = terrainPath([mins(780, 60), { ...mins(600, 120), weight: 3 }, mins(660, 30, { weight: 1 }), mins(720, 30)], opts);
  const xs = pairs(d).map((q) => q[0]);
  assert.deepEqual(xs, [...xs].sort((a, b) => a - b));
  assert.ok(Math.abs(Math.min(...pairs(d).map((q) => q[1])) - 30) <= 1); // the tallest of an overlapping group wins
});

test("all-day events and meetings wholly outside the day draw nothing", () => {
  assert.equal(terrainPath([mins(0, 1440, { allDay: true }), mins(360, 60), mins(1090, 30)], opts), "M0,150 L840,150");
});

test("width and height can be changed", () => {
  const d = terrainPath([{ ...mins(480, 600), weight: 2 }], { ...opts, width: 100, height: 120 });
  assert.ok(d.startsWith("M0,100"));
  assert.ok(d.endsWith("100,100"));
  assert.equal(Math.min(...pairs(d).map((q) => q[1])), 20);
});
