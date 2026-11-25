import { basename } from "node:path";

/** How long to wait after a change before restarting, so one save or one commit restarts once. */
const QUIET_MS = 300;

export interface Child {
  kill(signal?: NodeJS.Signals): void;
  onExit(fn: (code: number) => void): void;
}

export interface SuperviseDeps {
  /** Start the page server as a separate process. */
  spawn(): Child;
  /** Call `onChange` with the path of each file that changes. Returns a function that stops watching. */
  watch(onChange: (path: string) => void): () => void;
  log(line: string): void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const WATCHED = /^(src|bin|config|prompts)\//;
const KINDS = /\.(ts|js|css|yaml|md)$/;

/**
 * Whether a changed file means the running server is out of date: code, config, styles
 * and prompts do; tests, the example config and editors' scratch files do not.
 */
export function needsRestart(path: string): boolean {
  const p = path.replaceAll("\\", "/");
  const name = basename(p);
  if (!WATCHED.test(p) || !KINDS.test(name)) return false;
  if (name.startsWith(".") || name.endsWith("~")) return false;
  if (/\.test\.[a-z]+$/.test(name) || name === "local.example.yaml") return false;
  return true;
}

/**
 * Keep the page server running on the current code. Node loads a program once, so a
 * server started before an edit keeps running the old code; this starts the server as
 * a child process and replaces it whenever a file it depends on changes.
 *
 * `done` resolves with an exit code when there is nothing left to supervise: the first
 * server stopped by itself (a taken port, a broken config), or `stop` was called. A
 * server that dies after a restart is not retried in a loop; the next change starts it.
 */
export function supervise(deps: SuperviseDeps): { done: Promise<number>; stop(): void } {
  let child: Child | null = null;
  let stopping = false; // the current child was told to go, to make way for a new one
  let ended = false;
  let restarts = 0;
  let timer: unknown;
  let resolve: (code: number) => void = () => {};
  const done = new Promise<number>((r) => {
    resolve = r;
  });

  /** Stop watching and restarting. `done` resolves once no server is left running. */
  const end = () => {
    ended = true;
    deps.clearTimeout(timer);
    stopWatching();
  };

  function start() {
    const mine = deps.spawn();
    child = mine;
    stopping = false;
    mine.onExit((code) => {
      if (child !== mine) return;
      child = null;
      if (ended) {
        resolve(0);
      } else if (stopping) {
        start();
      } else if (restarts === 0) {
        end();
        resolve(code);
      } else {
        deps.log(`divination: the server stopped (exit ${code}); waiting for a change to start it again`);
      }
    });
  }

  function restart(path: string) {
    if (ended || stopping) return;
    restarts++;
    deps.log(`divination: ${path} changed; restarting`);
    if (child === null) {
      start();
      return;
    }
    stopping = true;
    child.kill("SIGTERM");
  }

  const stopWatching = deps.watch((path) => {
    if (ended || !needsRestart(path)) return;
    deps.clearTimeout(timer);
    timer = deps.setTimeout(() => restart(path), QUIET_MS);
  });

  start();

  return {
    done,
    stop() {
      if (ended) return;
      end();
      if (child === null) resolve(0);
      else child.kill("SIGTERM");
    },
  };
}

/** Call `go` once nothing is running, checking again every so often while something is. */
export function whenIdle(
  isBusy: () => boolean,
  go: () => void,
  later: (fn: () => void) => unknown = (fn) => setTimeout(fn, 100),
): void {
  if (isBusy()) later(() => whenIdle(isBusy, go, later));
  else go();
}
