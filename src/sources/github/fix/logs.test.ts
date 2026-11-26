import assert from "node:assert/strict";
import { test } from "node:test";
import { contextWith, fakeExec } from "../../../../test/helpers.ts";
import { MAX_LOGS, readLogs } from "./logs.ts";
import { cutLog } from "./rules.ts";

const link = (id: number) => `https://ci.example.com/teamcity/buildConfiguration/Acme_Check/${id}`;
const RAW = ["--raw", "--no-color", "--no-input"];

test("each failing build's raw log is read and cut", async () => {
  const long = `${"noise\n".repeat(20_000)}src/Writer.cs(223,28): [SA1201] error ZEBRAWORD\n`;
  const exec = fakeExec({ "teamcity run log 4090522": { stdout: long }, "teamcity run log 4090523": { stdout: "short log\n" } });
  const logs = await readLogs(contextWith({}, { exec }), [
    { name: "Style check", url: link(4090522) },
    { name: "Unit tests", url: link(4090523) },
  ]);
  assert.deepEqual(exec.calls, [
    ["teamcity", "run", "log", "4090522", ...RAW],
    ["teamcity", "run", "log", "4090523", ...RAW],
  ]);
  assert.deepEqual(logs, [
    { name: "Style check", log: cutLog(long) },
    { name: "Unit tests", log: "short log\n" },
  ]);
  assert.ok(logs[0]!.log!.includes("ZEBRAWORD") && logs[0]!.log!.length < long.length);
});

test("a check with no build link, or whose log cannot be read, is noted", async () => {
  const exec = fakeExec({ "teamcity run log 7": { code: 1, stderr: "not signed in" }, "teamcity run log 8": { stdout: "  \n" } });
  const logs = await readLogs(contextWith({}, { exec }), [
    { name: "No link" },
    { name: "No number", url: "https://ci.example.com/build/latest" },
    { name: "Tool failed", url: link(7) },
    { name: "Empty log", url: link(8) },
  ]);
  assert.deepEqual(logs, [
    { name: "No link", note: "no log" },
    { name: "No number", note: "no log" },
    { name: "Tool failed", note: "no log" },
    { name: "Empty log", note: "no log" },
  ]);
});

test("only five logs are read", async () => {
  assert.equal(MAX_LOGS, 5);
  const exec = fakeExec({ "teamcity run log": { stdout: "a log\n" } });
  const failing = Array.from({ length: 7 }, (_, i) => ({ name: `Check ${i + 1}`, url: link(100 + i) }));
  const logs = await readLogs(contextWith({}, { exec }), failing);
  assert.equal(exec.calls.length, 5);
  assert.deepEqual(logs.map((l) => l.note ?? "read"), ["read", "read", "read", "read", "read", "log not read", "log not read"]);
});

test("a check with no link does not use up one of the five", async () => {
  const exec = fakeExec({ "teamcity run log": { stdout: "a log\n" } });
  const failing = [{ name: "No link" }, ...Array.from({ length: 5 }, (_, i) => ({ name: `Check ${i + 1}`, url: link(100 + i) }))];
  const logs = await readLogs(contextWith({}, { exec }), failing);
  assert.deepEqual(logs.map((l) => l.note ?? "read"), ["no log", "read", "read", "read", "read", "read"]);
});

test("nothing from a log is logged: only which check's log is being read", async () => {
  const logged: [string, unknown][] = [];
  const exec = fakeExec({ "teamcity run log": { stdout: "ZEBRAWORD in the log\n" } });
  const ctx = contextWith({}, { exec, log: (event, fields) => logged.push([event, fields]) });
  await readLogs(ctx, [{ name: "Style check", url: link(1) }], "acme/monolith#501");
  assert.deepEqual(logged, [["fix-step", { key: "acme/monolith#501", step: "reading the log of Style check" }]]);
  assert.ok(!JSON.stringify(logged).includes("ZEBRAWORD"));
});
