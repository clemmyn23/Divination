import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A throwaway repo root holding the committed defaults and, optionally, a local config. */
export function tempRoot(local?: object): string {
  const root = mkdtempSync(join(tmpdir(), "divination-"));
  mkdirSync(join(root, "config"));
  cpSync(join(repoRoot, "config", "defaults.json"), join(root, "config", "defaults.json"));
  if (local) writeFileSync(join(root, "config", "local.json"), JSON.stringify(local));
  return root;
}
