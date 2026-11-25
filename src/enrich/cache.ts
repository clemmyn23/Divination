import { createHash } from "node:crypto";
import { readJson, writeJson } from "../core/store.ts";
import type { Context } from "../core/types.ts";

const SAFE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

function fileFor(ctx: Context, enricherId: string, hash: string): string {
  for (const name of [enricherId, hash]) {
    if (!SAFE_NAME.test(name) || name.includes("..")) throw new Error(`invalid cache name: ${JSON.stringify(name)}`);
  }
  return ctx.paths.cache("enrich", enricherId, `${hash}.json`);
}

/** A short, stable fingerprint of some content. An item is only sent to the LLM again when this changes. */
export function hashOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

export function cacheGet(ctx: Context, enricherId: string, hash: string): unknown | undefined {
  const entry = readJson<{ value: unknown } | null>(fileFor(ctx, enricherId, hash), null);
  return entry === null ? undefined : entry.value;
}

export function cachePut(ctx: Context, enricherId: string, hash: string, value: unknown): void {
  writeJson(fileFor(ctx, enricherId, hash), { value });
}
