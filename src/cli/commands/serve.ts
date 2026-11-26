import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, watch } from "node:fs";
import { join } from "node:path";
import { enabledSources } from "../../core/pipeline.ts";
import type { Context, Source } from "../../core/types.ts";
import { renderSite } from "../../render/site.ts";
import type { Timers } from "../../server/live.ts";
import { createApp, listen } from "../../server/server.ts";
import { type Child, supervise, whenIdle } from "../../server/supervise.ts";
import type { Command } from "../main.ts";

/** The folders whose contents the running server depends on. */
const WATCHED_DIRS = ["src", "bin", "config", "prompts"];

/**
 * Start the page server in this process: redraw the page from the last collected data
 * (so it reflects the code and config that are running now), listen on 127.0.0.1, and
 * run the live-update timer if it was left on.
 */
export async function startServer(ctx: Context, sources: Source<any>[], timers?: Timers) {
  const port = ctx.config.server.port;
  renderSite(ctx, sources);

  // A fresh token on every start. Only a page this server served can know it.
  const app = createApp(ctx, sources, randomBytes(24).toString("hex"), timers);
  let close: () => void;
  try {
    close = await listen(app, port);
  } catch (e) {
    throw new Error(`could not listen on 127.0.0.1:${port}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (app.live.state().live) app.live.start();
  return { app, close };
}

/** The server as a child process running this same program with `serve --no-watch`. */
function spawnServer(): Child {
  const proc = spawn(process.execPath, [...process.execArgv, process.argv[1]!, "serve", "--no-watch"], { stdio: "inherit" });
  return {
    kill: (signal) => proc.kill(signal),
    onExit: (fn) => proc.once("exit", (code, signal) => fn(code ?? (signal ? 1 : 0))),
  };
}

/** Report every file that changes under the watched folders, as a path from the repo root. */
function watchTree(root: string, onChange: (path: string) => void): () => void {
  const watchers = WATCHED_DIRS.filter((dir) => existsSync(join(root, dir))).map((dir) => {
    const watcher = watch(join(root, dir), { recursive: true }, (_event, file) => {
      if (file) onChange(`${dir}/${file}`);
    });
    watcher.on("error", () => {});
    return watcher;
  });
  return () => {
    for (const watcher of watchers) watcher.close();
  };
}

/**
 * `serve` runs the local page server until it is stopped. It serves the page on
 * 127.0.0.1, runs the live-update timer if it was left on, and handles the page's buttons.
 *
 * By default the server runs as a child process that is replaced whenever the code or
 * config changes, so the page is never drawn by out-of-date code. `--no-watch` runs
 * the server directly in this process instead.
 */
export function serveCommand(getCtx: () => Context, all: Source<any>[]): Command {
  return {
    summary: "serve [--no-watch]: run the page on 127.0.0.1; restarts itself when the code or config changes",
    async run(args) {
      const ctx = getCtx();

      if (!args.includes("--no-watch")) {
        const { done, stop } = supervise({
          spawn: spawnServer,
          watch: (onChange) => watchTree(ctx.root, onChange),
          log: (line) => console.log(line),
          setTimeout,
          clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
        });
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        return done;
      }

      let server: Awaited<ReturnType<typeof startServer>>;
      try {
        server = await startServer(ctx, enabledSources(ctx.config, all));
      } catch (e) {
        console.log(e instanceof Error ? e.message : String(e));
        return 1;
      }
      console.log(`http://127.0.0.1:${ctx.config.server.port}`);
      if (!server.app.live.state().live) console.log("live updates are paused; press Start on the page to resume");

      // Asked to stop (a restart, or `kill`): let a running update, Claude call or review
      // on its way to GitHub finish first.
      process.once("SIGTERM", () => {
        server.close();
        whenIdle(
          () => server.app.busy(),
          () => process.exit(0),
        );
      });
      return new Promise<number>(() => {}); // runs until the process is stopped
    },
  };
}
