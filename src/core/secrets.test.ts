import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeExec } from "../../test/helpers.ts";
import { storeFor } from "./secret-store.ts";
import { createSecrets } from "./secrets.ts";

const MAC = storeFor("darwin");

test("env wins over keychain, keychain is asked otherwise", async () => {
  const exec = fakeExec({ "security find-generic-password -s divination -a slack -w": { stdout: "from-keychain\n" } });
  assert.equal(await createSecrets({ DIVINATION_SLACK: "from-env" }, exec, MAC).get("slack"), "from-env");
  assert.equal(await createSecrets({}, exec, MAC).get("slack"), "from-keychain");
  assert.equal(await createSecrets({}, fakeExec({}), MAC).get("missing"), undefined);
});

test("the env name is upper-cased and an empty value does not count", async () => {
  const exec = fakeExec({ "security find-generic-password -s divination -a calendar_ics -w": { stdout: "kc\n" } });
  assert.equal(await createSecrets({ DIVINATION_CALENDAR_ICS: "" }, exec, MAC).get("calendar_ics"), "kc");
  assert.equal(await createSecrets({ DIVINATION_CALENDAR_ICS: "url" }, exec, MAC).get("calendar_ics"), "url");
});

test("an empty keychain answer is undefined", async () => {
  const exec = fakeExec({ "security find-generic-password": { stdout: "\n" } });
  assert.equal(await createSecrets({}, exec, MAC).get("slack"), undefined);
});

test("odd secret names are refused before anything runs", async () => {
  const exec = fakeExec({});
  await assert.rejects(createSecrets({}, exec, MAC).get("slack -w; rm"), /secret name/);
  assert.equal(exec.calls.length, 0);
});

test("on Linux the desktop keyring is asked, and on Windows the Credential Manager", async () => {
  const linux = fakeExec({ "secret-tool lookup service divination account slack": { stdout: "from-keyring" } });
  assert.equal(await createSecrets({}, linux, storeFor("linux")).get("slack"), "from-keyring");

  const windows = fakeExec({ "powershell.exe -NoProfile -NonInteractive -Command": { stdout: "from-vault\r\n" } });
  assert.equal(await createSecrets({}, windows, storeFor("win32")).get("slack"), "from-vault");
  assert.match(windows.calls[0]!.at(-1)!, /Retrieve\('divination', 'slack'\)/);
});

test("a store whose tool is missing or has nothing answers undefined", async () => {
  const missing = fakeExec({ "secret-tool": { code: 127 } });
  assert.equal(await createSecrets({}, missing, storeFor("linux")).get("slack"), undefined);
});

test("with no store on this platform only the environment is read, and nothing runs", async () => {
  const exec = fakeExec({});
  assert.equal(await createSecrets({ DIVINATION_SLACK: "from-env" }, exec, null).get("slack"), "from-env");
  assert.equal(await createSecrets({}, exec, null).get("slack"), undefined);
  assert.equal(exec.calls.length, 0);
});
