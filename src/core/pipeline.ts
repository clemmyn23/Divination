import { statSync } from "node:fs";
import { cacheGet } from "../enrich/cache.ts";
import { ConfigError } from "./config.ts";
import { readDone } from "./done.ts";
import { readJson, writeJson } from "./store.ts";
import type { Config, Context, Envelope, Source, View } from "./types.ts";

/** The sources named in `config.sources`, in that order. */
export function enabledSources(config: Config, all: Source<any>[]): Source<any>[] {
  return config.sources.map((id) => {
    const source = all.find((s) => s.id === id);
    if (!source) {
      const known = all.map((s) => s.id).join(", ") || "none";
      throw new ConfigError(`config problems:\n- sources names "${id}", which is not a known source (known: ${known})`);
    }
    return source;
  });
}

/** The last envelope written for a source, or a "never collected" one. */
export function readEnvelope(source: Source<any>, ctx: Context): Envelope<unknown> {
  return readJson<Envelope<unknown>>(ctx.paths.data(source.id), {
    source: source.id,
    ok: false,
    error: "never collected",
    collectedAt: 0,
    attemptedAt: 0,
    data: null,
  });
}

/** How a source gets its data: `api`, `ics`, or `inbox` for a file dropped by hand. */
export function transportOf(config: Config, id: string): string | undefined {
  const block = (config as unknown as Record<string, { transport?: string } | undefined>)[id];
  return block?.transport;
}

/** The source's data and when it was gathered. Inbox data is as old as the file it came from. */
async function gather(source: Source<any>, ctx: Context): Promise<{ data: unknown; at: number }> {
  if (transportOf(ctx.config, source.id) !== "inbox") return { data: await source.collect(ctx), at: ctx.now() };
  const path = ctx.paths.inbox(source.id);
  const dropped = readJson<unknown>(path, null);
  if (dropped === null) throw new Error("inbox file missing");
  return { data: source.fromInbox ? source.fromInbox(dropped, ctx) : dropped, at: Math.round(statSync(path).mtimeMs) };
}

/**
 * Collect one source and write its envelope. This never throws for a source's own
 * failure: the last good data is kept and the error is recorded beside it.
 */
export async function collectSource(source: Source<any>, ctx: Context): Promise<Envelope<unknown>> {
  const previous = readEnvelope(source, ctx);
  const now = ctx.now();

  let envelope: Envelope<unknown>;
  try {
    const { data, at } = await gather(source, ctx);
    const problems = source.validate(data);
    if (problems.length > 0) throw new Error(problems.join("; "));
    envelope = { source: source.id, ok: true, collectedAt: at, attemptedAt: now, data };
  } catch (e) {
    envelope = {
      source: source.id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      collectedAt: previous.collectedAt,
      attemptedAt: now,
      data: previous.data,
    };
  }

  writeJson(ctx.paths.data(source.id), envelope);
  ctx.log("collect", { source: source.id, ok: envelope.ok, ...(envelope.error ? { error: envelope.error } : {}) });
  return envelope;
}

/**
 * What panels are drawn from: the clock, the config, and whatever enrichment is already
 * in the cache for the items each source has right now. Reading the cache never calls
 * an LLM.
 */
export function buildView(ctx: Context, sources: Source<any>[]): View {
  const enrich: View["enrich"] = {};
  for (const source of sources) {
    if (!source.enrichers || source.enrichers.length === 0) continue;
    const envelope = readEnvelope(source, ctx);
    if (envelope.data === null) continue;
    for (const enricher of source.enrichers) {
      for (const item of enricher.items(envelope.data, ctx)) {
        const output = cacheGet(ctx, enricher.id, item.hash);
        if (output !== undefined) (enrich[enricher.id] ??= {})[item.key] = output;
      }
    }
  }
  return { now: ctx.now(), config: ctx.config, enrich, done: readDone(ctx) };
}

/** Collect every source. One failing source does not stop the others. */
export function collectAll(sources: Source<any>[], ctx: Context): Promise<Envelope<unknown>[]> {
  return Promise.all(sources.map((source) => collectSource(source, ctx)));
}
