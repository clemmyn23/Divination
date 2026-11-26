import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { contextWith, sourceWith } from "../../test/helpers.ts";
import { buildView } from "../core/pipeline.ts";
import type { Context, EnrichItem, Enricher, Source } from "../core/types.ts";
import { cacheGet, cachePut, hashOf } from "./cache.ts";
import { enrichOnDemand } from "./on-demand.ts";

let ctx: Context;
let runs: EnrichItem[][];
let enricher: Enricher<unknown>;
let src: Source<any>;

beforeEach(() => {
  ctx = contextWith({ sources: ["fake"] });
  runs = [];
  enricher = {
    id: "fake-enricher",
    items: () => [
      { key: "a", hash: "hash-a", input: 1 },
      { key: "b", hash: "hash-b", input: 2 },
    ],
    run: async (items) => {
      runs.push(items);
      return Object.fromEntries(items.map((i) => [i.key, `out-${i.key}`]));
    },
  };
  src = sourceWith(ctx, enricher);
});

test("one key sends one item; a second press is a cache hit", async () => {
  assert.deepEqual(await enrichOnDemand(ctx, [src], "fake-enricher", "a"), { ran: 1, cached: 0 });
  assert.deepEqual(runs[0]!.map((i) => i.key), ["a"]);
  assert.equal(cacheGet(ctx, "fake-enricher", "hash-a"), "out-a");

  assert.deepEqual(await enrichOnDemand(ctx, [src], "fake-enricher", "a"), { ran: 0, cached: 1 });
  assert.equal(runs.length, 1);
});

test("asked again, an item already done is sent again and its new answer replaces the old one", async () => {
  cachePut(ctx, "fake-enricher", "hash-a", "old");
  assert.deepEqual(await enrichOnDemand(ctx, [src], "fake-enricher", "a", { again: true }), { ran: 1, cached: 0 });
  assert.deepEqual(runs.map((r) => r.map((i) => i.key)), [["a"]]);
  assert.equal(cacheGet(ctx, "fake-enricher", "hash-a"), "out-a");
});

test("a rerun that fails keeps the answer that was there", async () => {
  cachePut(ctx, "fake-enricher", "hash-a", "old");
  enricher.run = async () => {
    throw new Error("claude failed");
  };
  await assert.rejects(enrichOnDemand(ctx, [src], "fake-enricher", "a", { again: true }), /claude failed/);
  assert.equal(cacheGet(ctx, "fake-enricher", "hash-a"), "old");
});

test("all sends only what is not cached, in one call", async () => {
  cachePut(ctx, "fake-enricher", "hash-a", "out-a");
  assert.deepEqual(await enrichOnDemand(ctx, [src], "fake-enricher", "all"), { ran: 1, cached: 1 });
  assert.deepEqual(runs.map((r) => r.map((i) => i.key)), [["b"]]);
});

test("unknown enricher or key is an error and calls nothing", async () => {
  await assert.rejects(enrichOnDemand(ctx, [src], "nope", "a"), /unknown enricher nope/);
  await assert.rejects(enrichOnDemand(ctx, [src], "fake-enricher", "zzz"), /nothing to enrich for zzz/);
  assert.equal(runs.length, 0);
});

test("a source that was never collected has nothing to enrich", async () => {
  const empty = { ...src, id: "empty" };
  await assert.rejects(enrichOnDemand(ctx, [empty], "fake-enricher", "a"), /no data for empty/);
});

test("bad output is not cached", async () => {
  const broken = sourceWith(ctx, {
    ...enricher,
    run: async () => {
      throw new Error("timeout");
    },
  });
  await assert.rejects(enrichOnDemand(ctx, [broken], "fake-enricher", "a"), /timeout/);
  assert.equal(cacheGet(ctx, "fake-enricher", "hash-a"), undefined);
});

test("an item the enricher skipped is not counted or cached", async () => {
  const partial = sourceWith(ctx, { ...enricher, run: async () => ({ a: "out-a" }) });
  assert.deepEqual(await enrichOnDemand(ctx, [partial], "fake-enricher", "all"), { ran: 1, cached: 0 });
  assert.equal(cacheGet(ctx, "fake-enricher", "hash-b"), undefined);
});

test("view picks up cached outputs for current items only", () => {
  cachePut(ctx, "fake-enricher", "hash-a", "out-a");
  cachePut(ctx, "fake-enricher", "hash-gone", "old");
  assert.deepEqual(buildView(ctx, [src]).enrich["fake-enricher"], { a: "out-a" });
});

test("a source with no data or no enrichers adds nothing to the view", () => {
  const plain = { ...src, id: "plain", enrichers: undefined };
  assert.deepEqual(buildView(ctx, [plain]).enrich, {});
});

test("hashOf is stable, short and changes with the content", () => {
  assert.equal(hashOf({ a: 1 }), hashOf({ a: 1 }));
  assert.notEqual(hashOf({ a: 1 }), hashOf({ a: 2 }));
  assert.match(hashOf("x"), /^[0-9a-f]{16}$/);
});

test("cache keys cannot climb out of the cache folder", () => {
  assert.throws(() => cachePut(ctx, "../evil", "hash", 1), /cache name/);
  assert.throws(() => cacheGet(ctx, "fake-enricher", "../../secret"), /cache name/);
});
