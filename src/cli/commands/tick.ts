import { appendFileSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { collectAll, enabledSources } from "../../core/pipeline.ts";
import { withinActiveHours } from "../../core/time.ts";
import type { Context, Source } from "../../core/types.ts";
import { renderSite } from "../../render/site.ts";
import type { Command } from "../main.ts";

const LOCK_FRESH_MS = 10 * 60_000;

export type TickResult = "ran" | "outside-hours" | "locked";

/** True when another tick holds the lock. A lock older than ten minutes was left by a run that died. */
function lockIsHeld(ctx: Context): boolean {
  try {
    return ctx.now() - statSync(ctx.paths.lock).mtimeMs < LOCK_FRESH_MS;
  } catch {
    return false;
  }
}

/**
 * One update: collect every source with plain API calls, then rebuild the page.
 * It never calls an LLM. Outside working hours it does nothing unless forced.
 */
export async function tick(ctx: Context, sources: Source<any>[], opts: { force?: boolean } = {}): Promise<TickResult> {
  if (!opts.force && !withinActiveHours(ctx.now(), ctx.config.tick, ctx.config.me.timezone)) return "outside-hours";
  if (lockIsHeld(ctx)) {
    ctx.log("tick", { result: "locked", ms: 0 });
    return "locked";
  }
  ctx.log("tick-start", { forced: opts.force === true });

  mkdirSync(dirname(ctx.paths.lock), { recursive: true });
  writeFileSync(ctx.paths.lock, String(process.pid));
  const started = performance.now();
  try {
    const envelopes = await collectAll(sources, ctx);
    renderSite(ctx, sources);

    mkdirSync(ctx.paths.logs, { recursive: true });
    const line = {
      at: ctx.now(),
      ms: Math.round(performance.now() - started),
      sources: Object.fromEntries(envelopes.map((e) => [e.source, e.ok])),
    };
    appendFileSync(join(ctx.paths.logs, "ticks.jsonl"), JSON.stringify(line) + "\n");
    ctx.log("tick", { result: "ran", ms: line.ms });
    return "ran";
  } finally {
    rmSync(ctx.paths.lock, { force: true });
  }
}

/** `tick [--force]` runs one update now and says what happened. */
export function tickCommand(getCtx: () => Context, all: Source<any>[]): Command {
  return {
    summary: "tick [--force]: collect and render once (no LLM); skipped outside working hours unless forced",
    async run(args) {
      const ctx = getCtx();
      console.log(await tick(ctx, enabledSources(ctx.config, all), { force: args.includes("--force") }));
      return 0;
    },
  };
}
