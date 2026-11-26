import type { Context } from "../../../core/types.ts";
import type { FailingCheck } from "./checks.ts";
import { buildIdOf, cutLog } from "./rules.ts";

/** A failing check and what could be learned about why: its log, cut to fit, or a note that there is none. */
export interface CheckLog {
  name: string;
  log?: string;
  note?: "no log" | "log not read";
}

/** The most logs one fix reads. The rest are named to Claude as failing, with no log. */
export const MAX_LOGS = 5;

const LOG_TIMEOUT_MS = 120_000;

/**
 * The logs of a PR's failing builds, read with the `teamcity` tool, one at a time. A
 * failing status links to its build; the build's number is the last part of the link.
 * What a log says goes to Claude and nowhere else: it is never passed to `ctx.log`.
 */
export async function readLogs(ctx: Context, failing: FailingCheck[], key = ""): Promise<CheckLog[]> {
  const out: CheckLog[] = [];
  let read = 0;
  for (const check of failing) {
    const id = buildIdOf(check.url);
    if (id === undefined) {
      out.push({ name: check.name, note: "no log" });
      continue;
    }
    if (read >= MAX_LOGS) {
      out.push({ name: check.name, note: "log not read" });
      continue;
    }
    read++;
    ctx.log("fix-step", { key, step: `reading the log of ${check.name}` });
    const res = await ctx.exec("teamcity", ["run", "log", id, "--raw", "--no-color", "--no-input"], { timeoutMs: LOG_TIMEOUT_MS });
    if (res.code !== 0 || res.stdout.trim() === "") out.push({ name: check.name, note: "no log" });
    else out.push({ name: check.name, log: cutLog(res.stdout) });
  }
  return out;
}
