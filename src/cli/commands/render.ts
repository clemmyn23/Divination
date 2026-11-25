import { enabledSources } from "../../core/pipeline.ts";
import type { Context, Source } from "../../core/types.ts";
import { renderSite } from "../../render/site.ts";
import type { Command } from "../main.ts";

/** `render` rebuilds the page from whatever was last collected. */
export function renderCommand(getCtx: () => Context, all: Source<any>[]): Command {
  return {
    summary: "render: rebuild the page from the last collected data",
    async run() {
      const ctx = getCtx();
      console.log(renderSite(ctx, enabledSources(ctx.config, all)));
      return 0;
    },
  };
}
