import { collectSource, transportOf } from "../core/pipeline.ts";
import { writeJson } from "../core/store.ts";
import type { Context, Source } from "../core/types.ts";
import { renderSite } from "../render/site.ts";

const MINUTE = 60_000;

/**
 * The Claude reads that Refresh now can start. For each source that is fed through its
 * inbox and knows how to ask (`feed`), Claude gathers what would otherwise be dropped by
 * hand; the answer is checked, written to the inbox, collected and drawn.
 *
 * These are LLM calls, so they are throttled: a source Claude read (or failed to read)
 * less than `claudeReads.throttleMinutes` ago is not asked again. The throttle lives here
 * and nowhere else, so it never holds back a plain refresh. It is counted from the end of
 * the last read and kept for as long as the server runs.
 *
 * Returns what went wrong, one line per reason, naming the sources it stopped. A read
 * held back by the throttle is not a failure.
 */
export function createFeeder(): (ctx: Context, sources: Source<any>[]) => Promise<string[]> {
  const finishedAt = new Map<string, number>();

  return async (ctx, sources) => {
    const { onRefresh, throttleMinutes } = ctx.config.claudeReads;
    if (!onRefresh) return [];

    const failed = new Map<string, string[]>(); // what went wrong -> the sources it went wrong for
    for (const source of sources) {
      if (!source.feed || transportOf(ctx.config, source.id) !== "inbox") continue;

      const last = finishedAt.get(source.id);
      const waitMs = last === undefined ? 0 : last + throttleMinutes * MINUTE - ctx.now();
      if (waitMs > 0) {
        ctx.log("feed-skip", { source: source.id, waitMs, throttleMinutes });
        continue;
      }

      const started = performance.now();
      const elapsed = () => Math.round(performance.now() - started);
      ctx.log("feed-start", { source: source.id });
      try {
        const dropped = await source.feed(ctx);
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
