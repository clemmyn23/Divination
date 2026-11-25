import { ConfigError } from "./config.ts";
import { readJson, writeJson } from "./store.ts";
import type { Config, Context, Envelope, Source } from "./types.ts";

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

function transportOf(config: Config, id: string): string | undefined {
  const block = (config as unknown as Record<string, { transport?: string } | undefined>)[id];
  return block?.transport;
}

async function gather(source: Source<any>, ctx: Context): Promise<unknown> {
  if (transportOf(ctx.config, source.id) !== "inbox") return source.collect(ctx);
  const dropped = readJson<unknown>(ctx.paths.inbox(source.id), null);
  if (dropped === null) throw new Error("inbox file missing");
  return dropped;
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
    const data = await gather(source, ctx);
    const problems = source.validate(data);
    if (problems.length > 0) throw new Error(problems.join("; "));
    envelope = { source: source.id, ok: true, collectedAt: now, attemptedAt: now, data };
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

/** Collect every source. One failing source does not stop the others. */
export function collectAll(sources: Source<any>[], ctx: Context): Promise<Envelope<unknown>[]> {
  return Promise.all(sources.map((source) => collectSource(source, ctx)));
}
