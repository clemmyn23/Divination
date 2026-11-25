import assert from "node:assert/strict";
import { test } from "node:test";
import { settle } from "../../test/helpers.ts";
import { needsRestart, supervise, whenIdle } from "./supervise.ts";

/** A stand-in for the outside world: children that are started, a file watcher and a timer. */
function world() {
  const children: { kills: string[]; exit(code: number): void }[] = [];
  const logs: string[] = [];
  const pending: (() => void)[] = [];
  let change: (path: string) => void = () => {};
  let watching = false;

  return {
    children,
    logs,
    get watching() {
      return watching;
    },
    /** A file changed. */
    touch(path = "src/core/time.ts") {
      change(path);
    },
    /** Let the quiet period after a change pass. */
    quiet() {
      for (const fn of pending.splice(0)) fn();
    },
    deps: {
      spawn() {
        let onExit: (code: number) => void = () => {};
        const child = { kills: [] as string[], exit: (code: number) => onExit(code) };
        children.push(child);
        return {
          kill: (signal: string = "SIGTERM") => child.kills.push(signal),
          onExit: (fn: (code: number) => void) => {
            onExit = fn;
          },
        };
      },
      watch(onChange: (path: string) => void) {
        change = onChange;
        watching = true;
        return () => {
          watching = false;
        };
      },
      log: (line: string) => logs.push(line),
      setTimeout: (fn: () => void) => {
        pending.push(fn);
        return fn;
      },
      clearTimeout: (handle: unknown) => {
        const i = pending.indexOf(handle as () => void);
        if (i >= 0) pending.splice(i, 1);
      },
    },
  };
}

test("it starts one server straight away and watches for changes", () => {
  const w = world();
  supervise(w.deps);
  assert.equal(w.children.length, 1);
  assert.equal(w.watching, true);
});

test("a change stops the server, and the new one starts only once the old one has gone", () => {
  const w = world();
  supervise(w.deps);
  w.touch();
  w.quiet();
  assert.deepEqual(w.children[0]!.kills, ["SIGTERM"]);
  assert.equal(w.children.length, 1); // the port is still taken

  w.children[0]!.exit(0);
  assert.equal(w.children.length, 2);
  assert.deepEqual(w.children[1]!.kills, []);
  assert.ok(w.logs.some((line) => /src\/core\/time\.ts/.test(line)));
});

test("a burst of changes restarts once", () => {
  const w = world();
  supervise(w.deps);
  w.touch("src/a.ts");
  w.touch("src/b.ts");
  w.touch("src/c.ts");
  assert.deepEqual(w.children[0]!.kills, []); // still waiting for the burst to end
  w.quiet();
  assert.deepEqual(w.children[0]!.kills, ["SIGTERM"]);

  w.touch("src/d.ts"); // arrives while the old server is still finishing
  w.quiet();
  assert.deepEqual(w.children[0]!.kills, ["SIGTERM"]);
  w.children[0]!.exit(0);
  assert.equal(w.children.length, 2);
});

test("changes to tests, output and editor leftovers do not restart anything", () => {
  const w = world();
  supervise(w.deps);
  for (const path of ["src/core/time.test.ts", "src/.time.ts.swp", "src/core/time.ts~", "docs/notes.md"]) w.touch(path);
  w.quiet();
  assert.deepEqual(w.children[0]!.kills, []);
});

test("what counts as a change worth restarting for", () => {
  for (const path of ["src/core/time.ts", "bin/divination.ts", "config/local.json", "config/defaults.json", "src/render/theme/base.css", "src/render/client/app.js", "prompts/pr-review.md"]) {
    assert.equal(needsRestart(path), true, path);
  }
  for (const path of ["src/core/time.test.ts", "src/render/client/app.test.ts", "src/core/.time.ts.swp", "src/core/time.ts~", "src/core/4913", "README.md", "config/local.example.json"]) {
    assert.equal(needsRestart(path), false, path);
  }
});

test("if the first server stops by itself, so does the supervisor, with the same exit code", async () => {
  const w = world();
  const { done } = supervise(w.deps);
  w.children[0]!.exit(1); // for example: the port was already taken
  assert.equal(await done, 1);
  assert.equal(w.children.length, 1);
  assert.equal(w.watching, false);
});

test("a server that dies after a restart waits for the next change instead of looping", async () => {
  const w = world();
  const { done } = supervise(w.deps);
  w.touch();
  w.quiet();
  w.children[0]!.exit(0);
  w.children[1]!.exit(1); // the half-saved code did not start
  await settle();
  assert.equal(w.children.length, 2);
  assert.equal(w.watching, true);
  assert.ok(w.logs.some((line) => /waiting for a change/.test(line)));

  w.touch();
  w.quiet();
  assert.equal(w.children.length, 3); // nothing to stop first
  let finished = false;
  void done.then(() => {
    finished = true;
  });
  await settle();
  assert.equal(finished, false);
});

test("stop ends the server and the watching, and nothing restarts afterwards", async () => {
  const w = world();
  const { done, stop } = supervise(w.deps);
  w.touch();
  stop();
  assert.deepEqual(w.children[0]!.kills, ["SIGTERM"]);
  assert.equal(w.watching, false);
  w.quiet();
  w.children[0]!.exit(0);
  assert.equal(await done, 0);
  assert.equal(w.children.length, 1);
});

test("whenIdle waits for the running job before going on", () => {
  let busy = true;
  let went = 0;
  const waits: (() => void)[] = [];
  whenIdle(() => busy, () => went++, (fn) => waits.push(fn));
  assert.equal(went, 0);
  waits.shift()!();
  assert.equal(went, 0); // still busy
  busy = false;
  waits.shift()!();
  assert.equal(went, 1);
  assert.equal(waits.length, 0);

  whenIdle(() => false, () => went++, (fn) => waits.push(fn));
  assert.equal(went, 2); // nothing running: straight away
});
