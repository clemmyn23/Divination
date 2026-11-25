import { join } from "node:path";
import { readJson, writeJson } from "./store.ts";
import type { Context } from "./types.ts";

/** The longest key a done mark may have. */
export const DONE_KEY_MAX = 400;
/** Marks older than this are forgotten: whatever they were for is long gone from the page. */
const KEEP_MS = 14 * 86_400_000;

const donePath = (ctx: Context) => join(ctx.paths.out, "done.json");

/**
 * The lines I have ticked off by hand: key -> when it was marked. A key names one line
 * in one state (a PR at a commit, a thread at its latest reply), so a line comes back by
 * itself when something new happens on it.
 */
export function readDone(ctx: Context): Record<string, number> {
  const raw = readJson<unknown>(donePath(ctx), {});
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const done: Record<string, number> = {};
  for (const [key, at] of Object.entries(raw)) {
    if (typeof at === "number" && Number.isFinite(at)) done[key] = at;
  }
  return done;
}

/** Mark a line done, or take the mark back. */
export function setDone(ctx: Context, key: string, done: boolean): void {
  if (typeof key !== "string" || key === "" || key.length > DONE_KEY_MAX) throw new Error("a done key must be a short, non-empty string");
  const now = ctx.now();
  const marks: Record<string, number> = {};
  for (const [k, at] of Object.entries(readDone(ctx))) {
    if (now - at <= KEEP_MS && k !== key) marks[k] = at;
  }
  if (done) marks[key] = now;
  writeJson(donePath(ctx), marks);
}
