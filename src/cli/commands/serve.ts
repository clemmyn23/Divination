import { randomBytes } from "node:crypto";
import { enabledSources } from "../../core/pipeline.ts";
import type { Context, Source } from "../../core/types.ts";
import { createApp, listen } from "../../server/server.ts";
import type { Command } from "../main.ts";

/**
 * `serve` runs the local page server until it is stopped. It serves the page on
 * 127.0.0.1, runs the live-update timer if it was left on, and handles the page's buttons.
 */
export function serveCommand(getCtx: () => Context, all: Source<any>[]): Command {
  return {
    summary: "serve: run the page on 127.0.0.1 with live updates and working buttons",
    async run() {
      const ctx = getCtx();
      const sources = enabledSources(ctx.config, all);
      const port = ctx.config.server.port;

      // A fresh token on every start. Only a page this server served can know it.
      const app = createApp(ctx, sources, randomBytes(24).toString("hex"));
      try {
        await listen(app, port);
      } catch (e) {
        console.log(`could not listen on 127.0.0.1:${port}: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
      console.log(`http://127.0.0.1:${port}`);

      if (app.live.state().live) app.live.start();
      else console.log("live updates are paused; press Start on the page to resume");

      return new Promise<number>(() => {}); // runs until the process is stopped
    },
  };
}
