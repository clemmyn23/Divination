import { enabledSources } from "../../core/pipeline.ts";
import type { Context, Source } from "../../core/types.ts";
import { enrichOnDemand } from "../../enrich/on-demand.ts";
import { renderSite } from "../../render/site.ts";
import type { Command } from "../main.ts";

/**
 * `enrich <enricher> <key | all>` calls Claude for one item, or for everything that
 * enricher has not done yet, then rebuilds the page. This is the typed-by-hand twin
 * of the page's sparkle buttons; nothing runs it automatically.
 */
export function enrichCommand(getCtx: () => Context, all: Source<any>[]): Command {
  return {
    summary: "enrich <enricher> <key | all>: call Claude for one item (this is an LLM call)",
    async run(args) {
      const [enricherId, key] = args;
      if (enricherId === undefined || key === undefined) {
        console.log("Usage: divination enrich <enricher> <key | all>");
        return 1;
      }
      const ctx = getCtx();
      const sources = enabledSources(ctx.config, all);
      try {
        const { ran, cached } = await enrichOnDemand(ctx, sources, enricherId, key);
        renderSite(ctx, sources);
        console.log(`ran ${ran}, cached ${cached}`);
        return 0;
      } catch (e) {
        console.log(`enrich failed: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    },
  };
}
