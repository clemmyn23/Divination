import assert from "node:assert/strict";
import { test } from "node:test";
import { storeFor } from "./secret-store.ts";

test("macOS keeps tokens in the Keychain, through the security tool", () => {
  const store = storeFor("darwin")!;
  assert.equal(store.label, "the macOS Keychain");
  assert.deepEqual(store.read("slack"), { cmd: "security", args: ["find-generic-password", "-s", "divination", "-a", "slack", "-w"] });
  assert.deepEqual(store.write("slack"), { cmd: "security", args: ["add-generic-password", "-U", "-s", "divination", "-a", "slack", "-w"] });
});

test("Linux keeps tokens in the desktop keyring, through secret-tool", () => {
  const store = storeFor("linux")!;
  assert.equal(store.label, "the desktop keyring");
  assert.deepEqual(store.read("slack"), { cmd: "secret-tool", args: ["lookup", "service", "divination", "account", "slack"] });
  assert.deepEqual(store.write("slack"), {
    cmd: "secret-tool",
    args: ["store", "--label", "divination slack", "service", "divination", "account", "slack"],
  });
  assert.match(store.missing, /libsecret/);
});

test("Windows keeps tokens in the Credential Manager, through Windows PowerShell", () => {
  const store = storeFor("win32")!;
  assert.equal(store.label, "the Windows Credential Manager");

  const read = store.read("calendar_ics");
  assert.equal(read.cmd, "powershell.exe");
  assert.deepEqual(read.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.match(read.args[3]!, /PasswordVault/);
  assert.match(read.args[3]!, /\.Retrieve\('divination', 'calendar_ics'\)/);

  const write = store.write("calendar_ics");
  assert.equal(write.cmd, "powershell.exe");
  // It has to ask in the terminal, so it is not run non-interactively.
  assert.deepEqual(write.args.slice(0, 2), ["-NoProfile", "-Command"]);
  assert.match(write.args[2]!, /Read-Host -AsSecureString/);
  assert.match(write.args[2]!, /PasswordCredential\('divination', 'calendar_ics', /);
});

test("the Windows scripts hold no double quotes or line breaks, so they survive being passed as one argument", () => {
  const store = storeFor("win32")!;
  for (const script of [store.read("slack").args.at(-1)!, store.write("slack").args.at(-1)!]) {
    assert.ok(!script.includes('"') && !script.includes("\n"));
  }
});

test("a platform with no known store has none", () => {
  assert.equal(storeFor("freebsd"), null);
  assert.equal(storeFor("aix"), null);
});

test("an odd name never reaches a command line or a script", () => {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    const store = storeFor(platform)!;
    assert.throws(() => store.read("x'); Remove-Item"), /secret name/);
    assert.throws(() => store.write("slack -w; rm"), /secret name/);
  }
});
