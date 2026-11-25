import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeExec } from "../../test/helpers.ts";
import { createSecrets } from "./secrets.ts";

test("env wins over keychain, keychain is asked otherwise", async () => {
  const exec = fakeExec({ "security find-generic-password -s divination -a slack -w": { stdout: "from-keychain\n" } });
  assert.equal(await createSecrets({ DIVINATION_SLACK: "from-env" }, exec).get("slack"), "from-env");
  assert.equal(await createSecrets({}, exec).get("slack"), "from-keychain");
  assert.equal(await createSecrets({}, fakeExec({})).get("missing"), undefined);
});

test("the env name is upper-cased and an empty value does not count", async () => {
  const exec = fakeExec({ "security find-generic-password -s divination -a calendar_ics -w": { stdout: "kc\n" } });
  assert.equal(await createSecrets({ DIVINATION_CALENDAR_ICS: "" }, exec).get("calendar_ics"), "kc");
  assert.equal(await createSecrets({ DIVINATION_CALENDAR_ICS: "url" }, exec).get("calendar_ics"), "url");
});

test("an empty keychain answer is undefined", async () => {
  const exec = fakeExec({ "security find-generic-password": { stdout: "\n" } });
  assert.equal(await createSecrets({}, exec).get("slack"), undefined);
});

test("odd secret names are refused before anything runs", async () => {
  const exec = fakeExec({});
  await assert.rejects(createSecrets({}, exec).get("slack -w; rm"), /secret name/);
  assert.equal(exec.calls.length, 0);
});
