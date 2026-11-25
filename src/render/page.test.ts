import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
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
  assert.ok(html.includes('<a href="https://x.example/1" target="_blank" rel="noopener noreferrer">Safe</a>'));
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

test("mascot is in the header with the count", () => {
  const src = fakeSource({ attention: () => [item("1"), item("2"), item("3"), item("4")] });
  const html = renderPage({ view, entries: [{ source: src, envelope: ok({}) }] });
  assert.match(html, /<header[\s\S]*class="mascot mascot-alarmed"[\s\S]*<\/header>/);
  assert.match(html, /<div id="needs-you" data-count="4">\s*<svg class="mascot/);
});

test("a theme toggle sits with the other controls", () => {
  const html = renderPage({ view, entries: [] });
  const controls = html.match(/<div id="controls">[\s\S]*?<\/div>/)![0];
  assert.match(controls, /<button id="theme-toggle" type="button"[^>]*>/);
});

test("the script runs in the head, so a saved theme applies before anything is drawn", () => {
  const html = renderPage({ view, entries: [] });
  assert.ok(html.indexOf("<script>") < html.indexOf("</head>"));
  assert.ok(html.indexOf("<style>") < html.indexOf("<script>"));
});

test("either theme can be forced, and auto follows the system", () => {
  const themeDir = fileURLToPath(new URL("./theme/", import.meta.url));
  const css = readFileSync(join(themeDir, "tokens.css"), "utf8");
  for (const needle of ["color-scheme: light dark", ':root[data-theme="light"]', ':root[data-theme="dark"]', "light-dark("]) {
    assert.ok(css.includes(needle), needle);
  }
});

test("the needs-you list is its own short panel, not part of the header", () => {
  const src = fakeSource({
    attention: () => [{ key: "1", title: "Reply to Ana", reason: "waiting on your reply", url: "https://x.example/1" }],
    panels: () => [panel()],
  });
  const html = renderPage({ view, entries: [{ source: src, envelope: ok({}) }] });
  const header = html.match(/<header>[\s\S]*?<\/header>/)![0];
  assert.ok(!header.includes("Reply to Ana"));
  assert.ok(header.includes("<strong>1</strong>"));
  const aside = html.match(/<aside id="attention" class="panel tint-accent" data-size="short">[\s\S]*?<\/aside>/)![0];
  assert.ok(aside.includes('<a href="https://x.example/1" target="_blank" rel="noopener noreferrer">Reply to Ana</a>'));
  assert.ok(html.indexOf('<aside id="attention"') < html.indexOf("<section"));
});

test("needs-you items older than the limit are folded away and not counted", () => {
  const DAY = 86_400_000;
  const src = fakeSource({
    attention: () => [
      { key: "1", title: "Fresh one", reason: "r", at: NOW - 2 * DAY },
      { key: "2", title: "Old one", reason: "r", at: NOW - 46 * DAY },
      { key: "3", title: "Ancient one", reason: "r", at: NOW - 300 * DAY },
      { key: "4", title: "Undated one", reason: "r" },
    ],
  });
  const html = renderPage({ view, entries: [{ source: src, envelope: ok({}) }] });

  // Only what is shown counts: in the header, on the mascot and on the panel.
  assert.ok(html.includes('id="needs-you" data-count="2"'));
  assert.ok(html.includes('class="mascot mascot-awake"'));
  const aside = html.match(/<aside id="attention"[\s\S]*?<\/aside>/)![0];
  assert.ok(aside.includes('<p class="updated">2</p>'));

  const [shown, folded] = aside.split('<details class="stale">');
  assert.ok(shown!.includes("Fresh one") && shown!.includes("Undated one"));
  assert.ok(!shown!.includes("Old one") && !shown!.includes("Ancient one"));
  assert.ok(folded!.includes("<summary>Expand for stale tasks · 2</summary>"));
  assert.ok(folded!.includes("Old one") && folded!.includes("Ancient one"));
});

test("when everything waiting is stale the panel stays calm but still offers the accordion", () => {
  const src = fakeSource({ attention: () => [{ key: "1", title: "Old one", reason: "r", at: NOW - 90 * 86_400_000 }] });
  const html = renderPage({ view, entries: [{ source: src, envelope: ok({}) }] });
  assert.ok(html.includes('id="needs-you" data-count="0"'));
  const aside = html.match(/<aside id="attention"[\s\S]*?<\/aside>/)![0];
  assert.ok(aside.includes("Nothing needs you"));
  assert.ok(aside.includes("<summary>Expand for stale tasks · 1</summary>"));
});

test("with nothing to do the needs-you panel says so", () => {
  const html = renderPage({ view, entries: [] });
  const aside = html.match(/<aside id="attention"[\s\S]*?<\/aside>/)![0];
  assert.ok(aside.includes("Nothing needs you"));
  assert.ok(!aside.includes("<ol"));
});

test("a panel can ask to be short; the default is tall", () => {
  const src = fakeSource({
    panels: () => [
      { id: "small", title: "S", tint: "butter", html: "", size: "short" },
      { id: "big", title: "B", tint: "mint", html: "" },
    ],
  });
  const html = renderPage({ view, entries: [{ source: src, envelope: ok({}) }] });
  assert.match(html, /<section id="small" class="panel tint-butter" data-source="fake" data-stale="false" data-size="short">/);
  assert.match(html, /<section id="big" class="panel tint-mint" data-source="fake" data-stale="false" data-size="tall">/);
});

test("the page fits the window and panels scroll inside themselves", () => {
  const themeDir = fileURLToPath(new URL("./theme/", import.meta.url));
  const css = readdirSync(themeDir)
    .map((f) => readFileSync(join(themeDir, f), "utf8"))
    .join("\n");
  for (const needle of ["height: 100dvh", "overflow: hidden", "overflow-y: auto", '[data-size="short"]', "grid-auto-flow: column dense"]) {
    assert.ok(css.includes(needle), needle);
  }
});

test("theme defines tokens, dark mode and the phone breakpoint", () => {
  const themeDir = fileURLToPath(new URL("./theme/", import.meta.url));
  const css = readdirSync(themeDir)
    .map((f) => readFileSync(join(themeDir, f), "utf8"))
    .join("\n");
  for (const needle of [
    "--paper",
    "--accent",
    "light-dark(",
    "max-width: 640px",
    ".tint-butter",
    ".tint-blush",
    ".tint-mint",
    ".tint-lilac",
    '[data-stale="true"]',
    "button[data-enrich]",
    "ui-rounded",
  ]) {
    assert.ok(css.includes(needle), needle);
  }
});

test("no external resources", () => {
  const refs = [...renderPage({ view, entries: [] }).matchAll(/(?:src|<link[^>]+href)="([^"]+)"/g)].map((m) => m[1]!);
  // The favicon is carried inside the page as a data address; nothing is fetched.
  assert.deepEqual(
    refs.filter((ref) => !ref.startsWith("data:")),
    [],
  );
});

function panel() {
  return { id: "p", title: "P", tint: "mint" as const, html: "" };
}

test("the page carries its own favicon, with a badge when something needs you", () => {
  const calm = renderPage({ view, entries: [{ source: fakeSource(), envelope: ok({}) }] });
  assert.match(calm, /<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,[^"]+">/);
  assert.ok(!decodeURIComponent(calm.match(/<link rel="icon"[^>]*href="([^"]+)"/)![1]!).includes('class="badge"'));

  const busy = renderPage({ view, entries: [{ source: fakeSource({ attention: () => [item("1")] }), envelope: ok({}) }] });
  assert.ok(decodeURIComponent(busy.match(/<link rel="icon"[^>]*href="([^"]+)"/)![1]!).includes('class="badge"'));
});

test("a source fed by hand through its inbox stays fresh for longer", () => {
  const twoHoursAgo = NOW - 120 * 60_000;
  const fetched = renderPage({ view, entries: [{ source: fakeSource({ panels: () => [panel()] }), envelope: ok({}, twoHoursAgo) }] });
  assert.ok(fetched.includes('data-stale="true"')); // the usual limit is an hour

  const byHand = { ...view, config: { ...view.config, fake: { transport: "inbox" } } as typeof view.config };
  const dropped = renderPage({ view: byHand, entries: [{ source: fakeSource({ panels: () => [panel()] }), envelope: ok({}, twoHoursAgo) }] });
  assert.ok(dropped.includes('data-stale="false"'));

  const yesterday = renderPage({ view: byHand, entries: [{ source: fakeSource({ panels: () => [panel()] }), envelope: ok({}, NOW - 13 * 3_600_000) }] });
  assert.ok(yesterday.includes('data-stale="true"'));
});

test("a needs-you item that is marked done is neither listed nor counted; the rest carry a tick", () => {
  const source = fakeSource({
    attention: () => [
      { key: "1", title: "First", reason: "because", doneKey: "k:1" },
      { key: "2", title: "Second", reason: "because", doneKey: "k:2" },
      { key: "3", title: "Third", reason: "because" }, // cannot be ticked
    ],
  });
  const html = renderPage({ view: { ...view, done: { "k:1": NOW } }, entries: [{ source, envelope: ok({}) }] });
  assert.ok(html.includes('id="needs-you" data-count="2"'));
  assert.ok(!html.includes("First"));
  assert.ok(html.includes('<li>Second <span class="reason">because</span><button type="button" class="tick" data-done="k:2" data-state="open"'));
  assert.ok(html.includes('<li>Third <span class="reason">because</span></li>'));
});
