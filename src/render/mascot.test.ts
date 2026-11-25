import assert from "node:assert/strict";
import { test } from "node:test";
import { mascotMood, mascotSvg } from "./mascot.ts";

test("mascot moods", () => {
  assert.deepEqual([0, 1, 3, 4, 12].map(mascotMood), ["sleepy", "awake", "awake", "alarmed", "alarmed"]);
});

test("the svg carries its mood on the root element and the number inside the ball", () => {
  assert.match(mascotSvg(0), /^<svg class="mascot mascot-sleepy"[^>]*>[\s\S]*>0<\/text>[\s\S]*<\/svg>$/);
  assert.match(mascotSvg(2), /^<svg class="mascot mascot-awake"[^>]*>[\s\S]*>2<\/text>/);
  assert.match(mascotSvg(12), /^<svg class="mascot mascot-alarmed"[^>]*>[\s\S]*>12<\/text>/);
});

test("each mood draws different eyes", () => {
  const eyes = (n: number) => mascotSvg(n).match(/<g class="eyes">[\s\S]*?<\/g>/)![0];
  assert.notEqual(eyes(0), eyes(2));
  assert.notEqual(eyes(2), eyes(9));
  assert.notEqual(eyes(0), eyes(9));
});

test("the svg is labelled for screen readers and loads nothing from anywhere", () => {
  assert.ok(mascotSvg(1).includes('role="img" aria-label="1 thing needs you"'));
  assert.ok(mascotSvg(3).includes('aria-label="3 things need you"'));
  assert.equal(/href=|url\(|<image|<script/.test(mascotSvg(5)), false);
});
