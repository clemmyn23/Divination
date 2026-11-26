import { enabledSources } from "../../core/pipeline.ts";
import type { Context, Source } from "../../core/types.ts";
import { enrichOnDemand } from "../../enrich/on-demand.ts";
import { renderSite } from "../../render/site.ts";
import type { Command } from "../main.ts";

/**
 * `enrich <enricher> <key | all> [--again]` calls Claude for one item, or for everything
 * that enricher has not done yet, then rebuilds the page. With `--again` it also redoes
 * what is already done. This is the typed-by-hand twin of the page's sparkle buttons;
 * nothing runs it automatically.
 */
export function enrichCommand(getCtx: () => Context, all: Source<any>[]): Command {
  return {
    summary: "enrich <enricher> <key | all> [--again]: call Claude for one item (this is an LLM call)",
    async run(args) {
      const again = args.includes("--again");
      const [enricherId, key] = args.filter((arg) => arg !== "--again");
      if (enricherId === undefined || key === undefined) {
        console.log("Usage: divination enrich <enricher> <key | all> [--again]");
        return 1;
      }
      const ctx = getCtx();
      const sources = enabledSources(ctx.config, all);
      try {
        const { ran, cached } = await enrichOnDemand(ctx, sources, enricherId, key, { again });
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
