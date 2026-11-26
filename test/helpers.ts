import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/core/config.ts";
import { createContext } from "../src/core/context.ts";
import { createSecrets } from "../src/core/secrets.ts";
import { writeJson } from "../src/core/store.ts";
import type { AttentionItem, Context, Enricher, Envelope, Exec, Http, Source, View } from "../src/core/types.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Wednesday 25 November 2026, 10:00 in Sydney. */
export const NOW = Date.parse("2026-11-24T23:00:00Z");

/**
 * A throwaway repo root holding the committed defaults and, optionally, a local config.
 * An object is written as JSON, which is also YAML; a string is written as it is.
 */
export function tempRoot(local?: object | string): string {
  const root = mkdtempSync(join(tmpdir(), "divination-"));
  mkdirSync(join(root, "config"));
  cpSync(join(repoRoot, "config", "defaults.yaml"), join(root, "config", "defaults.yaml"));
  if (local !== undefined) writeFileSync(join(root, "config", "local.yaml"), typeof local === "string" ? local : JSON.stringify(local));
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

/** Let promises that are already on their way finish. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Stand-ins for setInterval and clearInterval that record what was asked and fire on demand. */
export function fakeTimers() {
  const callbacks = new Map<number, () => void>();
  let nextId = 1;
  const timers = {
    intervals: [] as number[],
    cleared: 0,
    setInterval: ((fn: () => void, ms: number) => {
      timers.intervals.push(ms);
      const id = nextId++;
      callbacks.set(id, fn);
      return id;
    }) as unknown as typeof setInterval,
    clearInterval: ((id: number) => {
      if (callbacks.delete(id)) timers.cleared++;
    }) as unknown as typeof clearInterval,
    /** Run every interval that is still scheduled, once. */
    fire() {
      for (const fn of [...callbacks.values()]) fn();
    },
  };
  return timers;
}

/** A `fake` source that carries the enricher and already has collected data on disk. */
export function sourceWith(ctx: Context, enricher: Enricher<any>, data: unknown = {}): Source<any> {
  const source = fakeSource({ enrichers: [enricher] });
  writeJson(ctx.paths.data(source.id), ok(data, ctx.now()));
  return source;
}

/** An ok envelope for source `fake`. */
export function ok(data: unknown, collectedAt: number = NOW): Envelope<unknown> {
  return { source: "fake", ok: true, collectedAt, attemptedAt: collectedAt, data };
}

/** An attention item whose only interesting part is its key. */
export function item(key: string): AttentionItem {
  return { key, title: `Item ${key}`, reason: "because" };
}

/** A view at NOW with the default config and nothing enriched. */
export const view: View = { now: NOW, config: loadConfig(tempRoot()), enrich: {}, done: {} };

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

function isWithHeaders(v: unknown): v is { $data: unknown; $headers: Record<string, string> } {
  return typeof v === "object" && v !== null && "$data" in v && "$headers" in v;
}

/**
 * An Http that answers from a table. A request matches the longest route key its URL
 * starts with. A function value is called with the URL. An unknown URL throws.
 * An answer that is an Error is thrown; `{ $data, $headers }` sets response headers.
 */
export function fakeHttp(routes: Record<string, unknown | ((url: string) => unknown)>): Http & { calls: string[] } {
  const calls: string[] = [];
  const keys = Object.keys(routes).sort((a, b) => b.length - a.length);
  async function answerFor<T>(url: string): Promise<{ data: T; headers: Headers }> {
    calls.push(url);
    const key = keys.find((k) => url.startsWith(k));
    if (key === undefined) throw new Error(`fakeHttp: no route for ${url}`);
    const value = routes[key];
    const answer = typeof value === "function" ? (value as (url: string) => unknown)(url) : value;
    if (answer instanceof Error) throw answer;
    if (isWithHeaders(answer)) return { data: answer.$data as T, headers: new Headers(answer.$headers) };
    return { data: answer as T, headers: new Headers() };
  }
  return {
    calls,
    json: <T>(url: string) => answerFor<T>(url),
    text: (url: string) => answerFor<string>(url),
  };
}

/**
 * An Exec that answers from a table. The key is the command and its arguments joined by
 * spaces, matched by prefix (longest first). No match exits 1. A caller watching the
 * output is fed it first: in the pieces given as `chunks`, or else all at once.
 */
export function fakeExec(
  table: Record<string, { code?: number; stdout?: string; stderr?: string; chunks?: string[] }>,
): Exec & { calls: string[][]; opts: (Parameters<Exec>[2] | undefined)[] } {
  const calls: string[][] = [];
  const given: (Parameters<Exec>[2] | undefined)[] = []; // each call's options, in call order
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);
  const exec: Exec = async (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    given.push(opts);
    const line = [cmd, ...args].join(" ");
    const key = keys.find((k) => line.startsWith(k));
    if (key === undefined) return { code: 1, stdout: "", stderr: `fakeExec: no entry for ${line}` };
    const entry = table[key]!;
    const stdout = entry.stdout ?? (entry.chunks ?? []).join("");
    for (const chunk of entry.chunks ?? (stdout === "" ? [] : [stdout])) opts?.onStdout?.(chunk);
    return { code: entry.code ?? 0, stdout, stderr: entry.stderr ?? "" };
  };
  return Object.assign(exec, { calls, opts: given });
}
