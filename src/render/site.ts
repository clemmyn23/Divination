import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildView, readEnvelope } from "../core/pipeline.ts";
import type { Context, Source } from "../core/types.ts";
import { renderPage } from "./page.ts";

/** Write a page atomically, creating its folder if needed. */
export function writePage(path: string, html: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, html);
  renameSync(tmp, path);
}

/** Render the page from the saved envelopes and write it to `out/site/index.html`. Returns its path. */
export function renderSite(ctx: Context, sources: Source<any>[]): string {
  const html = renderPage({
    view: buildView(ctx, sources),
    entries: sources.map((source) => ({ source, envelope: readEnvelope(source, ctx) })),
  });
  writePage(ctx.paths.site, html);
  return ctx.paths.site;
}
