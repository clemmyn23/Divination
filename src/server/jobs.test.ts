import assert from "node:assert/strict";
import { test } from "node:test";
import { NOW, settle } from "../../test/helpers.ts";
import { createJobs } from "./jobs.ts";

test("one job at a time, and the last result is kept", async () => {
  const jobs = createJobs(() => NOW);
  let release!: () => void;

  assert.equal(jobs.run("a", () => new Promise<void>((resolve) => { release = resolve; })), true);
  assert.equal(jobs.run("b", async () => { throw new Error("must not run"); }), false);
  assert.deepEqual(jobs.current(), { name: "a", startedAt: NOW });

  release();
  await settle();
  assert.equal(jobs.current(), null);
  assert.deepEqual(jobs.last(), { name: "a", ok: true, finishedAt: NOW });

  assert.equal(jobs.run("c", async () => { throw new Error("boom"); }), true);
  await settle();
  assert.deepEqual(jobs.last(), { name: "c", ok: false, error: "boom", finishedAt: NOW });
  assert.equal(jobs.current(), null);
});

test("nothing has run at first", () => {
  const jobs = createJobs(() => NOW);
  assert.equal(jobs.current(), null);
  assert.equal(jobs.last(), null);
});

test("a job that throws straight away is still caught", async () => {
  const jobs = createJobs(() => NOW);
  assert.equal(jobs.run("sync", () => { throw new Error("early"); }), true);
  await settle();
  assert.deepEqual([jobs.last()!.ok, jobs.last()!.error, jobs.current()], [false, "early", null]);
});
