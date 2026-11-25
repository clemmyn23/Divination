import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { NOW, captureLog, contextWith, fakeSource } from "../../../test/helpers.ts";
import { buildView, collectSource } from "../../core/pipeline.ts";
import { renderCommand } from "./render.ts";

const source = fakeSource({
  collect: async () => ({ n: 1 }),
  panels: (data: { n: number }) => [{ id: "p", title: "P", tint: "mint", html: `<p>n is ${data.n}</p>` }],
});

test("render writes the page from the saved envelopes and prints its path", async () => {
  const ctx = contextWith({ sources: ["fake"] });
  await collectSource(source, ctx);

  const out = captureLog();
  try {
    assert.equal(await renderCommand(() => ctx, [source]).run([]), 0);
  } finally {
    out.restore();
  }
  assert.deepEqual(out.lines, [ctx.paths.site]);
  assert.ok(readFileSync(ctx.paths.site, "utf8").includes("<p>n is 1</p>"));
  assert.deepEqual(readdirSync(dirname(ctx.paths.site)), ["index.html"]); // no temp file left
});

test("render works before anything was collected", async () => {
  const ctx = contextWith({ sources: ["fake"] });
  const out = captureLog();
  try {
    assert.equal(await renderCommand(() => ctx, [source]).run([]), 0);
  } finally {
    out.restore();
  }
  assert.ok(existsSync(ctx.paths.site));
  assert.ok(readFileSync(ctx.paths.site, "utf8").includes("No data yet"));
});

test("the view carries the clock and config, with nothing enriched yet", () => {
  const ctx = contextWith({ staleAfterMinutes: 5 });
  const view = buildView(ctx, [source]);
  assert.equal(view.now, NOW);
  assert.equal(view.config.staleAfterMinutes, 5);
  assert.deepEqual(view.enrich, {});
});
