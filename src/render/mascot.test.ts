import assert from "node:assert/strict";
import { test } from "node:test";
import { mascotMood, mascotSvg } from "./mascot.ts";

test("mascot moods", () => {
  assert.deepEqual([0, 1, 3, 4, 12].map(mascotMood), ["sleepy", "awake", "awake", "alarmed", "alarmed"]);
});

test("the svg carries its mood on the root element", () => {
  assert.match(mascotSvg(0), /^<svg class="mascot mascot-sleepy"[^>]*>[\s\S]*<\/svg>$/);
  assert.match(mascotSvg(2), /^<svg class="mascot mascot-awake"/);
  assert.match(mascotSvg(12), /^<svg class="mascot mascot-alarmed"/);
});

test("each mood draws a different face", () => {
  const face = (n: number) => mascotSvg(n).match(/<g class="face">[\s\S]*?<\/g>/)![0];
  assert.notEqual(face(0), face(2));
  assert.notEqual(face(2), face(9));
  assert.notEqual(face(0), face(9));
});

test("the face stays small and friendly: no eye is drawn larger than a dot", () => {
  for (const n of [0, 2, 9]) {
    const radii = [...mascotSvg(n).matchAll(/<circle class="eye"[^>]* r="([\d.]+)"/g)].map((m) => Number(m[1]));
    assert.ok(radii.every((r) => r <= 4), `eyes for ${n}: ${radii}`);
  }
});

test("the number is not drawn on the ball; the page shows it beside the mascot", () => {
  assert.equal(/<text/.test(mascotSvg(7).replace(/<text class="zzz"[^>]*>z<\/text>/g, "")), false);
});

test("the svg is labelled for screen readers and loads nothing from anywhere", () => {
  assert.ok(mascotSvg(1).includes('role="img" aria-label="1 thing needs you"'));
  assert.ok(mascotSvg(3).includes('aria-label="3 things need you"'));
  assert.equal(/href=|url\(|<image|<script/.test(mascotSvg(5)), false);
});
