import assert from "node:assert/strict";
import { test } from "node:test";
import { storeFor } from "../../core/secret-store.ts";
import { secretCommand } from "./secret.ts";

const MAC = storeFor("darwin");

/** Runs `fn` with console.log captured, and returns what was printed. */
async function printed(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const real = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    await fn();
  } finally {
    console.log = real;
  }
  return lines;
}

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
  assert.equal(await secretCommand(r.run, MAC).run(["set", "slack"]), 0);
  assert.deepEqual(r.calls, [
    { cmd: "security", args: ["add-generic-password", "-U", "-s", "divination", "-a", "slack", "-w"] },
  ]);
});

test("the keychain tool's exit code is passed on", async () => {
  assert.equal(await secretCommand(recorder(45).run, MAC).run(["set", "slack"]), 45);
});

test("a missing or odd name runs nothing and returns 1", async () => {
  const r = recorder();
  const quiet = console.log;
  console.log = () => {};
  try {
    assert.equal(await secretCommand(r.run, MAC).run([]), 1);
    assert.equal(await secretCommand(r.run, MAC).run(["set"]), 1);
    assert.equal(await secretCommand(r.run, MAC).run(["set", "bad name;"]), 1);
    assert.equal(await secretCommand(r.run, MAC).run(["get", "slack"]), 1);
  } finally {
    console.log = quiet;
  }
  assert.equal(r.calls.length, 0);
});

test("on Linux and Windows it hands the name to that platform's own tool", async () => {
  const linux = recorder();
  assert.equal(await secretCommand(linux.run, storeFor("linux")).run(["set", "slack"]), 0);
  assert.deepEqual(linux.calls, [
    { cmd: "secret-tool", args: ["store", "--label", "divination slack", "service", "divination", "account", "slack"] },
  ]);

  const windows = recorder();
  assert.equal(await secretCommand(windows.run, storeFor("win32")).run(["set", "slack"]), 0);
  assert.equal(windows.calls[0]!.cmd, "powershell.exe");
  assert.match(windows.calls[0]!.args.at(-1)!, /Read-Host -AsSecureString/);
});

test("when the platform's tool cannot be started it says how to get it, and names the environment variable", async () => {
  const r = recorder(127);
  const lines = await printed(async () => {
    assert.equal(await secretCommand(r.run, storeFor("linux")).run(["set", "calendar_ics"]), 127);
  });
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /secret-tool could not be started/);
  assert.match(lines[0]!, /libsecret/);
  assert.equal(lines[1], "Or set DIVINATION_CALENDAR_ICS in the environment instead.");
});

test("on a platform with no store it runs nothing and names the environment variable", async () => {
  const r = recorder();
  const lines = await printed(async () => {
    assert.equal(await secretCommand(r.run, null).run(["set", "slack"]), 1);
  });
  assert.deepEqual(lines, ["There is no token store for this platform. Set DIVINATION_SLACK in the environment instead."]);
  assert.equal(r.calls.length, 0);
});
