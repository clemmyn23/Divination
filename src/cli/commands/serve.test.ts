import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { get } from "node:http";
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

test("the activity stream stays open over HTTP and delivers lines as they are logged", async () => {
  const ctx = contextWith({ sources: ["fake"], server: { port: 48979 } });
  const server = await startServer(ctx, [fakeSource()], fakeTimers());
  const chunks: string[] = [];
  let ended = false;
  const waitFor = async (text: string) => {
    for (let i = 0; i < 200 && !chunks.join("").includes(text); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(chunks.join("").includes(text), `never saw: ${text}`);
  };
  const request = get("http://127.0.0.1:48979/api/activity/stream", (res) => {
    assert.equal(res.headers["content-type"], "text/event-stream; charset=utf-8");
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => chunks.push(chunk));
    res.on("end", () => {
      ended = true;
    });
  });
  try {
    // The server's own page redraw happened before anyone was listening, so start something now.
    const page = await (await fetch("http://127.0.0.1:48979/")).text();
    const token = /name="divination-token" content="([^"]+)"/.exec(page)![1]!;
    await fetch("http://127.0.0.1:48979/api/tick", { method: "POST", headers: { "x-divination-token": token } });
    await waitFor("Refresh started (Refresh now)");
    await waitFor("Refresh finished in ");
    assert.equal(ended, false); // still open, waiting for whatever happens next
  } finally {
    request.destroy();
    server.close();
  }
});
