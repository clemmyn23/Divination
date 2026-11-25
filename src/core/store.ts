import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Read a JSON file the tool itself wrote. A missing file gives the fallback.
 * A corrupt file (a write that was cut short) is set aside as `<path>.bad`
 * and also gives the fallback, so one bad file never stops a run.
 */
export function readJson<T>(path: string, fallback: T): T {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw e;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    renameSync(path, path + ".bad");
    return fallback;
  }
}

/**
 * Read a JSON file that someone else dropped for the tool (an inbox file). Unlike
 * `readJson`, a file that will not parse is never moved or changed: it is the only copy
 * of someone's work, so it stays where it is and the error says what is wrong with it.
 * A missing file gives `undefined`.
 */
export function readDropped(path: string, what = "file"): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${what} is not valid JSON: ${(e as Error).message}`);
  }
}

/** Write JSON atomically: a temp file beside the target, then a rename. */
export function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, path);
}
