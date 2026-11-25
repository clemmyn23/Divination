import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext } from "../src/core/context.ts";
import { createSecrets } from "../src/core/secrets.ts";
import type { Context, Exec, Http, Source } from "../src/core/types.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Wednesday 25 November 2026, 10:00 in Sydney. */
export const NOW = Date.parse("2026-11-24T23:00:00Z");

/** A throwaway repo root holding the committed defaults and, optionally, a local config. */
export function tempRoot(local?: object): string {
  const root = mkdtempSync(join(tmpdir(), "divination-"));
  mkdirSync(join(root, "config"));
  cpSync(join(repoRoot, "config", "defaults.json"), join(root, "config", "defaults.json"));
  if (local) writeFileSync(join(root, "config", "local.json"), JSON.stringify(local));
  return root;
}

/**
 * A context for tests: a temp root, the clock fixed at NOW, and fakes for the network,
 * programs and secrets unless overridden. Nothing in it can reach a real service.
 */
export function contextWith(local?: object, overrides: Partial<Context> = {}): Context {
  const exec = overrides.exec ?? fakeExec({});
  return createContext(tempRoot(local), {
    now: () => NOW,
    http: fakeHttp({}),
    exec,
    secrets: createSecrets({}, exec),
    log: () => {},
    ...overrides,
  });
}

/** A source that does nothing, with id `fake`. Pass any members to replace. */
export function fakeSource(over: Partial<Source<any>> = {}): Source<any> {
  return {
    id: "fake",
    title: "Fake",
    doctor: async () => [],
    collect: async () => ({}),
    validate: () => [],
    attention: () => [],
    panels: () => [],
    ...over,
  };
}

/** Collect what a command prints with console.log. Call `restore()` when done. */
export function captureLog(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(...args.join(" ").split("\n"));
  };
  return {
    lines,
    restore: () => {
      console.log = original;
    },
  };
}

/**
 * An Http that answers from a table. A request matches the longest route key its URL
 * starts with. A function value is called with the URL. An unknown URL throws.
 */
export function fakeHttp(routes: Record<string, unknown | ((url: string) => unknown)>): Http & { calls: string[] } {
  const calls: string[] = [];
  const keys = Object.keys(routes).sort((a, b) => b.length - a.length);
  return {
    calls,
    async json<T>(url: string) {
      calls.push(url);
      const key = keys.find((k) => url.startsWith(k));
      if (key === undefined) throw new Error(`fakeHttp: no route for ${url}`);
      const value = routes[key];
      const data = typeof value === "function" ? (value as (url: string) => unknown)(url) : value;
      return { data: data as T, headers: new Headers() };
    },
  };
}

/**
 * An Exec that answers from a table. The key is the command and its arguments joined by
 * spaces, matched by prefix (longest first). No match exits 1.
 */
export function fakeExec(table: Record<string, { code?: number; stdout?: string }>): Exec & { calls: string[][] } {
  const calls: string[][] = [];
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);
  const exec = async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    const line = [cmd, ...args].join(" ");
    const key = keys.find((k) => line.startsWith(k));
    if (key === undefined) return { code: 1, stdout: "", stderr: `fakeExec: no entry for ${line}` };
    const entry = table[key]!;
    return { code: entry.code ?? 0, stdout: entry.stdout ?? "", stderr: "" };
  };
  return Object.assign(exec, { calls });
}
