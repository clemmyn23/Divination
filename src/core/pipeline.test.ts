import assert from "node:assert/strict";
import { test } from "node:test";
import { NOW, contextWith, fakeSource } from "../../test/helpers.ts";
import { ConfigError } from "./config.ts";
import { collectAll, collectSource, enabledSources, readEnvelope } from "./pipeline.ts";
import { readJson, writeJson } from "./store.ts";

test("successful collect writes an ok envelope", async () => {
  const ctx = contextWith();
  const env = await collectSource(fakeSource({ collect: async () => ({ n: 1 }) }), ctx);
  assert.deepEqual([env.ok, env.data, env.collectedAt], [true, { n: 1 }, NOW]);
  assert.deepEqual(readJson(ctx.paths.data("fake"), null), env);
  assert.equal("error" in env, false);
});

test("failed collect keeps last good data", async () => {
  const ctx = contextWith();
  await collectSource(fakeSource({ collect: async () => ({ n: 1 }) }), ctx);
  const later = { ...ctx, now: () => NOW + 60_000 };
  const failing = fakeSource({
    collect: async () => {
      throw new Error("host unreachable");
    },
  });
  const env = await collectSource(failing, later);
  assert.deepEqual(
    [env.ok, env.error, env.data, env.collectedAt, env.attemptedAt],
    [false, "host unreachable", { n: 1 }, NOW, NOW + 60_000],
  );
  assert.deepEqual(readJson(ctx.paths.data("fake"), null), env);
});

test("a later success clears the error", async () => {
  const ctx = contextWith();
  await collectSource(fakeSource({ collect: async () => { throw new Error("boom"); } }), ctx);
  const env = await collectSource(fakeSource({ collect: async () => ({ n: 2 }) }), ctx);
  assert.deepEqual([env.ok, env.error, env.data], [true, undefined, { n: 2 }]);
});

test("invalid data is rejected like a failure", async () => {
  const ctx = contextWith();
  const source = fakeSource({ collect: async () => ({}), validate: () => ["prs missing", "login missing"] });
  const env = await collectSource(source, ctx);
  assert.deepEqual([env.ok, env.error, env.data], [false, "prs missing; login missing", null]);
});

test("inbox transport reads the dropped file and still validates", async () => {
  const ctx = contextWith({ fake: { transport: "inbox" } });
  assert.equal((await collectSource(fakeSource(), ctx)).error, "inbox file missing");

  writeJson(ctx.paths.inbox("fake"), { n: 2 });
  const neverCollects = fakeSource({
    collect: async () => {
      throw new Error("must not be called");
    },
  });
  assert.deepEqual((await collectSource(neverCollects, ctx)).data, { n: 2 });

  const strict = fakeSource({ validate: () => ["bad shape"] });
  assert.equal((await collectSource(strict, ctx)).error, "bad shape");
});

test("one failing source does not stop the others", async () => {
  const ctx = contextWith();
  const a = fakeSource({ id: "a", collect: async () => { throw new Error("boom"); } });
  const b = fakeSource({ id: "b", collect: async () => 1 });
  assert.deepEqual((await collectAll([a, b], ctx)).map((e) => e.ok), [false, true]);
});

test("something thrown that is not an Error still gives a readable message", async () => {
  const ctx = contextWith();
  const env = await collectSource(fakeSource({ collect: async () => { throw "plain string"; } }), ctx);
  assert.equal(env.error, "plain string");
});

test("a source that was never collected reads as such", () => {
  const ctx = contextWith();
  assert.deepEqual(readEnvelope(fakeSource(), ctx), {
    source: "fake",
    ok: false,
    error: "never collected",
    collectedAt: 0,
    attemptedAt: 0,
    data: null,
  });
});

test("enabled sources follow the config order", () => {
  const ctx = contextWith({ sources: ["b", "a"] });
  const a = fakeSource({ id: "a" });
  const b = fakeSource({ id: "b" });
  const c = fakeSource({ id: "c" });
  assert.deepEqual(enabledSources(ctx.config, [a, b, c]).map((s) => s.id), ["b", "a"]);
});

test("unknown source id in config is a config error", () => {
  const ctx = contextWith();
  assert.throws(
    () => enabledSources({ ...ctx.config, sources: ["nope"] }, [fakeSource()]),
    (e: Error) => e instanceof ConfigError && /nope/.test(e.message),
  );
});
