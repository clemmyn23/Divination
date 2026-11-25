import { execFile } from "node:child_process";
import type { Exec } from "./types.ts";

const TIMED_OUT = 124;
const COULD_NOT_START = 127;

/**
 * Run a program with its arguments passed as they are, never through a shell.
 * Always resolves: a program that cannot start exits 127, one that outlives its
 * timeout exits 124.
 */
export const realExec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      {
        env: { ...process.env, ...opts.env },
        timeout: opts.timeoutMs ?? 0,
        maxBuffer: 64 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const code = typeof error.code === "number" ? error.code : error.killed ? TIMED_OUT : COULD_NOT_START;
        // Node's own message for a failed run is the whole command line, arguments and all:
        // that is never error output. Only a program that could not start has words worth keeping.
        resolve({ code, stdout, stderr: stderr || (code === COULD_NOT_START ? error.message : "") });
      },
    );
    if (opts.onStdout) child.stdout?.on("data", opts.onStdout);
    child.stdin?.on("error", () => {});
    child.stdin?.end(opts.input ?? "");
  });
