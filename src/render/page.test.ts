import assert from "node:assert/strict";
import { test } from "node:test";
import { NOW, fakeSource, item, ok, view } from "../../test/helpers.ts";
import { renderPage } from "./page.ts";

test("text is escaped", () => {
  const src = fakeSource({ attention: () => [{ key: "k", title: "<script>alert(1)</script>", reason: "a & b" }] });
  const html = renderPage({ view, entries: [{ source: src, envelope: ok({}) }] });
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("a &amp; b"));
});

test("needs-you count adds every source", () => {
  const two = fakeSource({ id: "a", attention: () => [item("1"), item("2")] });
  const one = fakeSource({ id: "b", attention: () => [item("3")] });
  const html = renderPage({
    view,
    entries: [
      { source: two, envelope: ok({}) },
      { source: one, envelope: ok({}) },
    ],
  });
  assert.ok(html.includes('id="needs-you" data-count="3"'));
});

test("attention items link only to https and a source without data adds none", () => {
  const src = fakeSource({
    attention: () => [
      { key: "1", title: "Safe", reason: "r", url: "https://x.example/1" },
      { key: "2", title: "Unsafe", reason: "r", url: "javascript:alert(1)" },
    ],
  });
  const html = renderPage({ view, entries: [{ source: src, envelope: ok({}) }] });
  assert.ok(html.includes('<a href="https://x.example/1">Safe</a>'));
  assert.ok(!html.includes("javascript:alert(1)"));

  const empty = { source: "fake", ok: false, error: "never collected", collectedAt: 0, attemptedAt: 0, data: null };
  assert.ok(renderPage({ view, entries: [{ source: src, envelope: empty }] }).includes('id="needs-you" data-count="0"'));
});

test("panels keep source order and carry their tint", () => {
  const a = fakeSource({
    id: "a",
    panels: () => [
      { id: "a1", title: "A", tint: "blush", html: "<p>hi</p>" },
      { id: "a2", title: "A2", tint: "mint", html: "" },
    ],
  });
  const b = fakeSource({ id: "b", panels: () => [{ id: "b1", title: "B", tint: "butter", html: "" }] });
  const html = renderPage({
    view,
    entries: [
      { source: a, envelope: ok({}) },
      { source: b, envelope: ok({}) },
    ],
  });
  assert.deepEqual(
    [...html.matchAll(/<section id="(\w+)" class="panel tint-(\w+)" data-source="(\w+)"/g)].map((m) => [m[1], m[2], m[3]]),
    [
      ["a1", "blush", "a"],
      ["a2", "mint", "a"],
      ["b1", "butter", "b"],
    ],
  );
  assert.ok(html.includes("<p>hi</p>"));
});

test("stale source is flagged", () => {
  const fresh = renderPage({ view, entries: [{ source: fakeSource({ panels: () => [panel()] }), envelope: ok({}, NOW - 59 * 60_000) }] });
  const old = renderPage({ view, entries: [{ source: fakeSource({ panels: () => [panel()] }), envelope: ok({}, NOW - 61 * 60_000) }] });
  assert.ok(fresh.includes('data-stale="false"'));
  assert.ok(old.includes('data-stale="true"'));
});

test("a panel shows when its source was last updated, in the configured timezone", () => {
  const html = renderPage({ view, entries: [{ source: fakeSource({ panels: () => [panel()] }), envelope: ok({}, NOW - 5 * 60_000) }] });
  assert.ok(html.includes("updated 09:55")); // NOW is 10:00 in Sydney
});

test("a failed source shows its error and last good panels", () => {
  const env = { ...ok({ n: 1 }), ok: false, error: "host <unreachable>" };
  const src = fakeSource({ panels: () => [{ id: "p", title: "P", tint: "mint", html: "kept" }] });
  const html = renderPage({ view, entries: [{ source: src, envelope: env }] });
  assert.ok(html.includes('<p class="source-error">host &lt;unreachable&gt;</p>'));
  assert.ok(html.includes("kept"));
});

test("a source with no data says so", () => {
  const env = { source: "fake", ok: false, error: "never collected", collectedAt: 0, attemptedAt: 0, data: null };
  const html = renderPage({ view, entries: [{ source: fakeSource(), envelope: env }] });
  assert.ok(html.includes("No data yet"));
  assert.ok(html.includes('<section id="fake" class="panel tint-lilac" data-source="fake" data-stale="true"'));
  assert.ok(html.includes("never collected"));
});

test("controls and the token placeholder are in the header", () => {
  const html = renderPage({ view, entries: [] });
  assert.match(html, /<header>\s*<div id="controls">[\s\S]*id="live-toggle"[\s\S]*id="refresh-now"[\s\S]*id="live-status"/);
  assert.ok(html.includes('<meta name="divination-token" content="__DIVINATION_TOKEN__">'));
});

test("styles and the script are inlined once each", () => {
  const html = renderPage({ view, entries: [] });
  assert.equal((html.match(/<style>/g) ?? []).length, 1);
  assert.equal((html.match(/<script>/g) ?? []).length, 1);
  assert.ok(html.includes("data-copy"));
  assert.ok(html.startsWith("<!doctype html>"));
});

test("no external resources", () => {
  assert.deepEqual(renderPage({ view, entries: [] }).match(/(?:src|<link[^>]+href)="[^"]+"/g), null);
});

function panel() {
  return { id: "p", title: "P", tint: "mint" as const, html: "" };
}
