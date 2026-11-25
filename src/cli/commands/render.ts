import { dirname, join } from "node:path";
import { buildView, enabledSources } from "../../core/pipeline.ts";
import type { Context, Source } from "../../core/types.ts";
import { type PageEntry, renderPage } from "../../render/page.ts";
import { renderSite, writePage } from "../../render/site.ts";
import type { Command } from "../main.ts";

const sampleModule = new URL("../../../test/fixtures/page/entries.ts", import.meta.url).href;

/**
 * `render` rebuilds the page from whatever was last collected.
 * `render --fixtures` draws a sample page with invented content to `out/site/fixture.html`,
 * for working on the look without touching the real page.
 */
export function renderCommand(getCtx: () => Context, all: Source<any>[]): Command {
  return {
    summary: "render [--fixtures]: rebuild the page from the last collected data",
    async run(args) {
      const ctx = getCtx();

      if (args.includes("--fixtures")) {
        const sample = (await import(sampleModule)) as {
          fixtureEntries(now: number, tz?: string): PageEntry[];
          fixtureEnrich?(): Record<string, Record<string, unknown>>;
        };
        const path = join(dirname(ctx.paths.site), "fixture.html");
        const view = { ...buildView(ctx, []), enrich: sample.fixtureEnrich?.() ?? {} };
        writePage(path, renderPage({ view, entries: sample.fixtureEntries(ctx.now(), ctx.config.me.timezone) }));
        console.log(path);
        return 0;
      }

      console.log(renderSite(ctx, enabledSources(ctx.config, all)));
      return 0;
    },
  };
}
