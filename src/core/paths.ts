import { join } from "node:path";
import type { Paths } from "./types.ts";

/** Everything generated lives under `<root>/out`, which is gitignored. */
export function createPaths(root: string): Paths {
  const out = join(root, "out");
  return {
    out,
    data: (id) => join(out, "data", `${id}.json`),
    inbox: (id) => join(out, "inbox", `${id}.json`),
    cache: (...parts) => join(out, "cache", ...parts),
    site: join(out, "site", "index.html"),
    logs: join(out, "logs"),
    lock: join(out, "tick.lock"),
  };
}
