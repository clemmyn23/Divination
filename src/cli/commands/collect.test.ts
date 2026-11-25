import assert from "node:assert/strict";
import { test } from "node:test";
import { captureLog, contextWith, fakeSource } from "../../../test/helpers.ts";
import { collectCommand } from "./collect.ts";
import { doctorCommand } from "./doctor.ts";

const good = fakeSource({ id: "good", title: "Good", collect: async () => ({}) });
const bad = fakeSource({
  id: "bad",
  title: "Bad",
  collect: async () => {
    throw new Error("host unreachable");
  },
});

test("collect prints one line per enabled source and exits 0 even when one fails", async () => {
  const ctx = contextWith({ sources: ["good", "bad"] });
  const out = captureLog();
  let code: number;
  try {
    code = await collectCommand(() => ctx, [good, bad]).run([]);
  } finally {
    out.restore();
  }
  assert.equal(code, 0);
  assert.deepEqual(out.lines, ["good: ok", "bad: failed: host unreachable"]);
});

test("collect <source> runs only that source", async () => {
  const ctx = contextWith({ sources: ["good", "bad"] });
  const out = captureLog();
  try {
    assert.equal(await collectCommand(() => ctx, [good, bad]).run(["good"]), 0);
  } finally {
    out.restore();
  }
  assert.deepEqual(out.lines, ["good: ok"]);
});

test("collect with a source that is not enabled returns 1", async () => {
  const ctx = contextWith({ sources: ["good"] });
  const out = captureLog();
  try {
    assert.equal(await collectCommand(() => ctx, [good, bad]).run(["bad"]), 1);
  } finally {
    out.restore();
  }
  assert.match(out.lines.join("\n"), /bad is not an enabled source/);
});

test("doctor prints every check, with fixes, and exits 1 when any fails", async () => {
  const ctx = contextWith({ sources: ["good", "bad"] });
  const healthy = { ...good, doctor: async () => [{ name: "token", ok: true, detail: "found" }] };
  const sick = {
    ...bad,
    doctor: async () => [
      { name: "token", ok: false, detail: "no token", fix: "run: divination secret set bad" },
      { name: "host", ok: true, detail: "set" },
    ],
  };
  const out = captureLog();
  let code: number;
  try {
    code = await doctorCommand(() => ctx, [healthy, sick]).run([]);
  } finally {
    out.restore();
  }
  assert.equal(code, 1);
  assert.deepEqual(out.lines, [
    "Good",
    "  ✓ token: found",
    "Bad",
    "  ✗ token: no token",
    "    fix: run: divination secret set bad",
    "  ✓ host: set",
  ]);
});

test("doctor exits 0 when everything passes, and a doctor that throws counts as a failed check", async () => {
  const ctx = contextWith({ sources: ["good"] });
  const healthy = { ...good, doctor: async () => [{ name: "token", ok: true, detail: "found" }] };
  const out = captureLog();
  try {
    assert.equal(await doctorCommand(() => ctx, [healthy]).run([]), 0);
    const crashing = { ...good, doctor: async () => { throw new Error("kaboom"); } };
    assert.equal(await doctorCommand(() => ctx, [crashing]).run([]), 1);
  } finally {
    out.restore();
  }
  assert.ok(out.lines.includes("  ✗ doctor: kaboom"));
});
