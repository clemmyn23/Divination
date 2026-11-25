import assert from "node:assert/strict";
import { test } from "node:test";
import { secretCommand } from "./secret.ts";

function recorder(code = 0) {
  const calls: { cmd: string; args: string[] }[] = [];
  const run = async (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return code;
  };
  return { calls, run };
}

test("secret set hands the name to the keychain tool and lets it ask for the value", async () => {
  const r = recorder();
  assert.equal(await secretCommand(r.run).run(["set", "slack"]), 0);
  assert.deepEqual(r.calls, [
    { cmd: "security", args: ["add-generic-password", "-U", "-s", "divination", "-a", "slack", "-w"] },
  ]);
});

test("the keychain tool's exit code is passed on", async () => {
  assert.equal(await secretCommand(recorder(45).run).run(["set", "slack"]), 45);
});

test("a missing or odd name runs nothing and returns 1", async () => {
  const r = recorder();
  const quiet = console.log;
  console.log = () => {};
  try {
    assert.equal(await secretCommand(r.run).run([]), 1);
    assert.equal(await secretCommand(r.run).run(["set"]), 1);
    assert.equal(await secretCommand(r.run).run(["set", "bad name;"]), 1);
    assert.equal(await secretCommand(r.run).run(["get", "slack"]), 1);
  } finally {
    console.log = quiet;
  }
  assert.equal(r.calls.length, 0);
});
