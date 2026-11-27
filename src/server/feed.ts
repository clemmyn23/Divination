import { statSync } from "node:fs";
import { join } from "node:path";
import { collectSource, isClaudeFed, timerMinutes } from "../core/pipeline.ts";
import { readJson, writeJson } from "../core/store.ts";
import type { Context, Source } from "../core/types.ts";
import { renderSite } from "../render/site.ts";

const MINUTE = 60_000;

/** The sources Claude can read: the ones fed through their inbox that know how to ask. */
export function claudeFed(ctx: Context, sources: Source<any>[]): Source<any>[] {
  return sources.filter((source) => isClaudeFed(ctx.config, source));
}

// My choices from the page are kept in `out/state.json`, beside the live switch.
const statePath = (ctx: Context) => join(ctx.paths.out, "state.json");
const readState = (ctx: Context) => readJson<{ reads?: Record<string, unknown> }>(statePath(ctx), {});

/**
 * Whether Refresh now has Claude read this source: my own choice from the page where I
 * have made one, and `claudeReads.onRefresh` otherwise.
 */
export function readsOnRefresh(ctx: Context, id: string): boolean {
  const reads = readState(ctx).reads ?? {};
  const mine = Object.hasOwn(reads, id) ? reads[id] : undefined;
  return typeof mine === "boolean" ? mine : ctx.config.claudeReads.onRefresh;
}

export function setReadsOnRefresh(ctx: Context, id: string, on: boolean): void {
  const state = readState(ctx);
  writeJson(statePath(ctx), { ...state, reads: { ...(state.reads ?? {}), [id]: on } });
}

/** How often the timer has Claude read this source, in minutes. 0 is never. */
export const everyMinutes = (ctx: Context, id: string): number => timerMinutes(ctx.config, id);

/**
 * What started a round of Claude reads:
 * - `refresh`: Refresh now was pressed. The sources switched on for it are read, unless
 *   they were read less than `claudeReads.throttleMinutes` ago.
 * - `timer`: the live timer ticked. The sources given an interval in
 *   `claudeReads.everyMinutes` are read, each when its interval has passed.
 * - `force`: one source's own button was pressed. It is read now.
 */
export type Reading = { on: "refresh" } | { on: "timer" } | { on: "force"; source: string };

function inboxTime(ctx: Context, id: string): number | undefined {
  try {
    return statSync(ctx.paths.inbox(id)).mtimeMs;
  } catch {
    return undefined; // nothing has been dropped yet
  }
}

/**
 * The Claude reads the server can start. For each source that is fed through its inbox
 * and knows how to ask (`feed`), Claude gathers what would otherwise be dropped by hand;
 * the answer is checked, written to the inbox, collected and drawn.
 *
 * These are LLM calls, so each way of starting them has its own limit, and the limits
 * live here and nowhere else, so none ever holds back a plain refresh:
 * - Refresh now is throttled: a source Claude read (or failed to read) less than
 *   `claudeReads.throttleMinutes` ago is not asked again. It is counted from the end of
 *   the last read and kept for as long as the server runs.
 * - The timer reads a source once per interval, counted from when its last read started,
 *   whoever started it, or from the time of its inbox file if that is later (a sweep run
 *   by hand counts, and so does one from before a restart). A tick rarely lands exactly
 *   on the interval, so the interval is rounded to the nearest tick. A read that failed
 *   waits out the interval like any other. A tick that is not due says nothing.
 *
 * Returns what went wrong, one line per reason, naming the sources it stopped. A read
 * that was held back is not a failure.
 */
export function createFeeder(): (ctx: Context, sources: Source<any>[], reading?: Reading) => Promise<string[]> {
  const startedAt = new Map<string, number>();
  const finishedAt = new Map<string, number>();

  /** True when this source is to be read now. Says why not in the log where that is worth a line. */
  function wanted(ctx: Context, source: Source<any>, reading: Reading): boolean {
    if (reading.on === "force") return source.id === reading.source;

    if (reading.on === "timer") {
      const every = everyMinutes(ctx, source.id);
      if (every === 0) return false;
      const last = Math.max(startedAt.get(source.id) ?? 0, inboxTime(ctx, source.id) ?? 0);
      if (last === 0) return true;
      const halfATick = (ctx.config.tick.minutes * MINUTE) / 2;
      return ctx.now() - last >= every * MINUTE - halfATick;
    }

    if (!readsOnRefresh(ctx, source.id)) return false;
    const { throttleMinutes } = ctx.config.claudeReads;
    const last = finishedAt.get(source.id);
    const waitMs = last === undefined ? 0 : last + throttleMinutes * MINUTE - ctx.now();
    if (waitMs > 0) {
      ctx.log("feed-skip", { source: source.id, waitMs, throttleMinutes });
      return false;
    }
    return true;
  }

  return async (ctx, sources, reading = { on: "refresh" }) => {
    const failed = new Map<string, string[]>(); // what went wrong -> the sources it went wrong for
    for (const source of claudeFed(ctx, sources)) {
      if (!wanted(ctx, source, reading)) continue;

      const started = performance.now();
      const elapsed = () => Math.round(performance.now() - started);
      startedAt.set(source.id, ctx.now());
      ctx.log("feed-start", { source: source.id });
      try {
        const dropped = await source.feed!(ctx);
        source.fromInbox?.(dropped, ctx); // an answer in the wrong shape must not replace a good file
        writeJson(ctx.paths.inbox(source.id), dropped);
        ctx.log("feed", { source: source.id, ok: true, ms: elapsed() });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        ctx.log("feed", { source: source.id, ok: false, ms: elapsed(), error });
        failed.set(error, [...(failed.get(error) ?? []), source.title]);
        continue;
      } finally {
        finishedAt.set(source.id, ctx.now());
      }

      // Show it straight away, rather than after every other source has been read too.
      await collectSource(source, ctx);
      renderSite(ctx, sources);
    }
    return [...failed].map(([error, titles]) => `${titles.join(", ")}: ${error}`);
  };
}
