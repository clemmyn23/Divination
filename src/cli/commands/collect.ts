import { collectAll, enabledSources } from "../../core/pipeline.ts";
import type { Context, Source } from "../../core/types.ts";
import type { Command } from "../main.ts";

/** `collect [source]` gathers data for every enabled source, or just the one named. */
export function collectCommand(getCtx: () => Context, all: Source<any>[]): Command {
  return {
    summary: "collect [source]: gather data now, with plain API calls",
    async run(args) {
      const ctx = getCtx();
      let chosen = enabledSources(ctx.config, all);
      const only = args[0];
      if (only !== undefined) {
        chosen = chosen.filter((s) => s.id === only);
        if (chosen.length === 0) {
          console.log(`${only} is not an enabled source (enabled: ${ctx.config.sources.join(", ") || "none"})`);
          return 1;
        }
      }
      for (const envelope of await collectAll(chosen, ctx)) {
        console.log(envelope.ok ? `${envelope.source}: ok` : `${envelope.source}: failed: ${envelope.error}`);
      }
      return 0;
    },
  };
}
