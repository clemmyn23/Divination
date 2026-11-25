import assert from "node:assert/strict";
import { test } from "node:test";
import { esc, link, safeUrl } from "./html.ts";

test("only https links", () => {
  for (const bad of ["http://x.example/a", "javascript:alert(1)", "file:///etc/passwd", "//x.example", 7, undefined]) {
    assert.equal(safeUrl(bad), undefined);
  }
  assert.equal(safeUrl("https://x.example/a"), "https://x.example/a");
  assert.equal(link("a<b", "javascript:alert(1)"), "a&lt;b");
  assert.equal(link("a<b", 'https://x.example/?q="1"'), '<a href="https://x.example/?q=&quot;1&quot;" target="_blank" rel="noopener noreferrer">a&lt;b</a>');
});

test("every link opens in a new tab and gives the new page no handle on this one", () => {
  const html = link("PR", "https://x.example/pr/1");
  assert.equal(html, '<a href="https://x.example/pr/1" target="_blank" rel="noopener noreferrer">PR</a>');
});

test("https in another case or with leading space is not trusted", () => {
  assert.equal(safeUrl(" https://x.example"), undefined);
  assert.equal(safeUrl("HTTPS://x.example"), undefined);
  assert.equal(safeUrl("https://"), undefined);
});

test("esc covers the five characters and copes with non-strings", () => {
  assert.equal(esc(`<a href="x" title='y'>&</a>`), "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  assert.equal(esc(undefined), "");
  assert.equal(esc(null), "");
  assert.equal(esc(42), "42");
});

test("a Slack app link is allowed, opens in place rather than a new tab, and nothing else gets through that door", () => {
  const app = "slack://channel?team=T02ABC&id=C1&message=1795563588.591749";
  assert.equal(safeUrl(app), app);
  assert.equal(link("thread", app), `<a href="${app.replaceAll("&", "&amp;")}">thread</a>`);
  for (const bad of ["slack://open", "slack://channel?team=T1&id=C1&x=<script>", "slack://channel?team=T1&id=C1 onclick=x", "slack:channel?team=T1&id=C1", "slackx://channel?team=T1&id=C1", "file:///etc/passwd"]) {
    assert.equal(safeUrl(bad), undefined, bad);
  }
});
