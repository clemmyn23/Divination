import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { contextWith, fakeSource, fakeTimers } from "../../../test/helpers.ts";
import { startServer } from "./serve.ts";

test("starting the server redraws the page with the current code, then listens on loopback", async () => {
  const ctx = contextWith({ sources: ["fake"], server: { port: 48977 } });
  const source = fakeSource({ title: "Fresh panel" });
  assert.equal(existsSync(ctx.paths.site), false);

  const server = await startServer(ctx, [source], fakeTimers());
  try {
    assert.ok(readFileSync(ctx.paths.site, "utf8").includes("Fresh panel"));
    const res = await fetch("http://127.0.0.1:48977/api/status");
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { startedAt: number }).startedAt, ctx.now());
  } finally {
    server.close();
  }
});

test("a taken port is an error that names the port", async () => {
  const ctx = contextWith({ sources: ["fake"], server: { port: 48978 } });
  const first = await startServer(ctx, [fakeSource()], fakeTimers());
  try {
    await assert.rejects(startServer(ctx, [fakeSource()], fakeTimers()), /48978/);
  } finally {
    first.close();
  }
});
