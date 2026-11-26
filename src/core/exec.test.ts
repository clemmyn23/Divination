import assert from "node:assert/strict";
import { test } from "node:test";
import { realExec } from "./exec.ts";

const node = process.execPath;

test("runs a program and returns its output and exit code", async () => {
  const ok = await realExec(node, ["-e", "process.stdout.write('out'); process.stderr.write('err')"]);
  assert.deepEqual(ok, { code: 0, stdout: "out", stderr: "err" });
  const bad = await realExec(node, ["-e", "process.exit(3)"]);
  assert.equal(bad.code, 3);
});

test("arguments are passed as they are, never through a shell", async () => {
  const res = await realExec(node, ["-e", "process.stdout.write(process.argv[1])", "a b; echo hi $HOME"]);
  assert.equal(res.stdout, "a b; echo hi $HOME");
});

test("input goes to stdin and env is added to the environment", async () => {
  const script = "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(s+':'+process.env.DIVINATION_TEST_VAR))";
  const res = await realExec(node, ["-e", script], { input: "hello", env: { DIVINATION_TEST_VAR: "yes" } });
  assert.equal(res.stdout, "hello:yes");
});

test("a missing program resolves with exit code 127", async () => {
  const res = await realExec("divination-no-such-program", []);
  assert.equal(res.code, 127);
  assert.match(res.stderr, /ENOENT/);
});

test("a program that exits with an error code and writes nothing has no error output, and its command line is not put there", async () => {
  const res = await realExec(node, ["-e", "process.exit(3)", "a-private-argument"]);
  assert.equal(res.code, 3);
  assert.equal(res.stderr, "");
});

test("a program that runs past its timeout resolves with exit code 124", async () => {
  const res = await realExec(node, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 200 });
  assert.equal(res.code, 124);
});

test("output can be watched as it arrives, and is still returned whole at the end", async () => {
  const seen: string[] = [];
  let finished = false;
  let finishedAtFirstChunk: boolean | undefined;
  const script = "process.stdout.write('one\\n'); setTimeout(() => process.stdout.write('two\\n'), 150)";
  const res = await realExec(process.execPath, ["-e", script], {
    onStdout: (chunk) => {
      if (seen.length === 0) finishedAtFirstChunk = finished;
      seen.push(chunk);
    },
  }).then((r) => {
    finished = true;
    return r;
  });
  assert.equal(res.stdout, "one\ntwo\n");
  assert.deepEqual(seen, ["one\n", "two\n"]);
  assert.equal(finishedAtFirstChunk, false);
});

test("a program runs in the folder it is given", async () => {
  const { mkdtempSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "divination-cwd-")));
  const res = await realExec(node, ["-e", "process.stdout.write(process.cwd())"], { cwd: dir });
  assert.equal(realpathSync(res.stdout), dir);
});
