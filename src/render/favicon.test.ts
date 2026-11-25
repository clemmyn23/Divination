import assert from "node:assert/strict";
import { test } from "node:test";
import { faviconHref, faviconSvg } from "./favicon.ts";

test("the favicon is a self-contained SVG with its own colours", () => {
  const svg = faviconSvg(0);
  assert.ok(svg.startsWith("<svg xmlns=\"http://www.w3.org/2000/svg\""));
  assert.ok(!svg.includes("var(")); // a favicon cannot see the page's colour tokens
  assert.ok(!svg.includes("<script"));
});

test("it shows a badge only when something needs you", () => {
  assert.ok(!faviconSvg(0).includes('class="badge"'));
  assert.ok(faviconSvg(1).includes('class="badge"'));
  assert.ok(faviconSvg(12).includes('class="badge"'));
});

test("the link is a data address that needs no request", () => {
  const href = faviconHref(2);
  assert.ok(href.startsWith("data:image/svg+xml,"));
  assert.ok(!/["<> ]/.test(href));
  assert.equal(decodeURIComponent(href.slice("data:image/svg+xml,".length)), faviconSvg(2));
});
