import type { Exec, Secrets } from "./types.ts";

/** The Keychain service every secret is stored under. */
export const KEYCHAIN_SERVICE = "divination";

const NAME = /^[a-z0-9_]+$/;

export function isSecretName(name: string): boolean {
  return NAME.test(name);
}

/**
 * Secrets come from `DIVINATION_<NAME>` in the environment first, then the macOS
 * Keychain. They are never read from, or written to, config or output files.
 */
export function createSecrets(env: Record<string, string | undefined>, exec: Exec): Secrets {
  return {
    async get(name) {
      if (!isSecretName(name)) throw new Error(`invalid secret name: ${JSON.stringify(name)}`);

      const fromEnv = env[`DIVINATION_${name.toUpperCase()}`];
      if (fromEnv) return fromEnv;

      const res = await exec("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name, "-w"]);
      if (res.code !== 0) return undefined;
      return res.stdout.trim() || undefined;
    },
  };
}
