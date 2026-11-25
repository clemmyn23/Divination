import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError, createHttp } from "./http.ts";

test("retries after 429 and honours Retry-After", async () => {
  const waits: number[] = [];
  let n = 0;
  const f = async () =>
    ++n < 3 ? new Response("slow down", { status: 429, headers: { "retry-after": "2" } }) : Response.json({ ok: 1 });
  const http = createHttp(f as typeof fetch, async (ms) => {
    waits.push(ms);
  });
  const { data } = await http.json("https://x.example/a");
  assert.deepEqual(data, { ok: 1 });
  assert.deepEqual(waits, [2000, 2000]);
});

test("a 429 without Retry-After waits one second", async () => {
  const waits: number[] = [];
  let n = 0;
  const f = async () => (++n < 2 ? new Response("", { status: 429 }) : Response.json({}));
  await createHttp(f as typeof fetch, async (ms) => {
    waits.push(ms);
  }).json("https://x.example/a");
  assert.deepEqual(waits, [1000]);
});

test("gives up after three retries", async () => {
  let n = 0;
  const f = async () => {
    n++;
    return new Response("", { status: 429 });
  };
  await assert.rejects(
    createHttp(f as typeof fetch, async () => {}).json("https://x.example/a"),
    (e: HttpError) => e.status === 429,
  );
  assert.equal(n, 4);
});

test("error text never contains the token", async () => {
  const f = async () => new Response("denied", { status: 401 });
  await assert.rejects(
    createHttp(f as typeof fetch).json("https://x.example/a", { headers: { authorization: "Bearer sekrit" } }),
    (e: Error) => !/sekrit/.test(e.message + JSON.stringify(e)) && /401/.test(e.message),
  );
});

test("an error carries the status, the url and at most 200 characters of the body", async () => {
  const f = async () => new Response("x".repeat(500), { status: 500 });
  await assert.rejects(createHttp(f as typeof fetch).json("https://x.example/a"), (e: HttpError) => {
    assert.equal(e.status, 500);
    assert.equal(e.url, "https://x.example/a");
    assert.equal(e.body.length, 200);
    return true;
  });
});

test("method, headers and body are sent, and response headers come back", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const f = async (url: string, init: RequestInit) => {
    seen = { url, init };
    return Response.json({ n: 1 }, { headers: { link: "<next>" } });
  };
  const res = await createHttp(f as unknown as typeof fetch).json<{ n: number }>("https://x.example/a", {
    method: "POST",
    headers: { authorization: "Bearer t" },
    body: "{}",
  });
  assert.equal(res.data.n, 1);
  assert.equal(res.headers.get("link"), "<next>");
  assert.equal(seen!.url, "https://x.example/a");
  assert.equal(seen!.init.method, "POST");
  assert.deepEqual(seen!.init.headers, { authorization: "Bearer t" });
  assert.equal(seen!.init.body, "{}");
});

test("a response that is not JSON is an HttpError, not a crash", async () => {
  const f = async () => new Response("<html>login</html>", { status: 200 });
  await assert.rejects(
    createHttp(f as typeof fetch).json("https://x.example/a"),
    (e: HttpError) => e instanceof HttpError && /not JSON/.test(e.message),
  );
});

test("a host that cannot be reached says so plainly", async () => {
  const f = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(createHttp(f as typeof fetch).json("https://git.example.com/api/v3/user"), /cannot reach git\.example\.com/);
});
