import { join } from "node:path";
import { readJson, writeJson } from "../core/store.ts";
import type { Context } from "../core/types.ts";

export interface Timers {
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
}

export interface LiveState {
  live: boolean;
  /** When the next automatic update is due, or null while paused or not started. */
  nextTickAt: number | null;
}

/**
 * The timer behind the page's Start / Pause button. While live it runs `runTick` every
 * `tick.minutes`. The choice is saved in `out/state.json`, so it survives a restart.
 */
export function createLive(
  ctx: Context,
  runTick: () => unknown,
  timers: Timers = { setInterval, clearInterval },
): { start(): void; pause(): void; state(): LiveState } {
  const statePath = join(ctx.paths.out, "state.json");
  const read = () => readJson<{ live?: boolean }>(statePath, {});

  let live = read().live !== false; // on unless it was paused
  let handle: ReturnType<typeof setInterval> | undefined;
  let nextTickAt: number | null = null;

  const period = () => ctx.config.tick.minutes * 60_000;
  const save = () => writeJson(statePath, { ...read(), live });

  // A failing tick must never stop the timer or crash the server.
  const fire = () => {
    nextTickAt = ctx.now() + period();
    try {
      Promise.resolve(runTick()).catch(() => {});
    } catch {
      // already reported by whoever ran it
    }
  };

  return {
    start() {
      live = true;
      save();
      if (handle !== undefined) return;
      fire();
      handle = timers.setInterval(fire, period());
    },
    pause() {
      live = false;
      save();
      if (handle !== undefined) timers.clearInterval(handle);
      handle = undefined;
      nextTickAt = null;
    },
    state: () => ({ live, nextTickAt }),
  };
}
