import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { realExec } from "./exec.ts";
import { createHttp } from "./http.ts";
import { createPaths } from "./paths.ts";
import { createSecrets } from "./secrets.ts";
import type { Context } from "./types.ts";

/** Build what every stage receives. Anything in `overrides` replaces the real service. */
export function createContext(root: string, overrides: Partial<Context> = {}): Context {
  const config = overrides.config ?? loadConfig(root);
  const paths = overrides.paths ?? createPaths(root);
  const exec = overrides.exec ?? realExec;
  const now = overrides.now ?? (() => Date.now());

  const log = (event: string, fields: object = {}) => {
    mkdirSync(paths.logs, { recursive: true });
    appendFileSync(join(paths.logs, "events.jsonl"), JSON.stringify({ at: now(), event, ...fields }) + "\n");
  };

  return {
    root,
    config,
    paths,
    now,
    http: createHttp(),
    exec,
    secrets: createSecrets(process.env, exec),
    log,
    ...overrides,
  };
}
