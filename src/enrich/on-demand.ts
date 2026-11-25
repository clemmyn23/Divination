import { readEnvelope } from "../core/pipeline.ts";
import type { Context, Source } from "../core/types.ts";
import { cacheGet, cachePut } from "./cache.ts";

/**
 * Run one enricher because someone asked for it: a button on the page, or the `enrich`
 * command. Nothing else calls this, so nothing else can start an LLM.
 *
 * `key` is one item's key, or `"all"`. Items already in the cache are left alone; the
 * rest go to the enricher in a single call. If that call throws, nothing is cached.
 */
export async function enrichOnDemand(
  ctx: Context,
  sources: Source<any>[],
  enricherId: string,
  key: string,
): Promise<{ ran: number; cached: number }> {
  const source = sources.find((s) => s.enrichers?.some((e) => e.id === enricherId));
  const enricher = source?.enrichers?.find((e) => e.id === enricherId);
  if (!source || !enricher) throw new Error(`unknown enricher ${enricherId}`);

  const envelope = readEnvelope(source, ctx);
  if (envelope.data === null) throw new Error(`no data for ${source.id}`);

  const items = enricher.items(envelope.data, ctx).filter((item) => key === "all" || item.key === key);
  if (items.length === 0) throw new Error(`nothing to enrich for ${key}`);

  const waiting = items.filter((item) => cacheGet(ctx, enricher.id, item.hash) === undefined);
  const cached = items.length - waiting.length;
  if (waiting.length === 0) return { ran: 0, cached };

  ctx.log("enrich", { enricher: enricher.id, key, items: waiting.length });
  const outputs = await enricher.run(waiting, ctx);

  let ran = 0;
  for (const item of waiting) {
    if (!(item.key in outputs)) continue;
    cachePut(ctx, enricher.id, item.hash, outputs[item.key]);
    ran++;
  }
  return { ran, cached };
}
