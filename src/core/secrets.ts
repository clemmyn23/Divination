import { type SecretStore, isSecretName, storeFor } from "./secret-store.ts";
import type { Exec, Secrets } from "./types.ts";

/**
 * Secrets come from `DIVINATION_<NAME>` in the environment first, then the platform's own
 * token store (see secret-store.ts). They are never read from, or written to, config or
 * output files. On a platform with no store, the environment is the only place.
 */
export function createSecrets(
  env: Record<string, string | undefined>,
  exec: Exec,
  store: SecretStore | null = storeFor(process.platform),
): Secrets {
  return {
    async get(name) {
      if (!isSecretName(name)) throw new Error(`invalid secret name: ${JSON.stringify(name)}`);

      const fromEnv = env[`DIVINATION_${name.toUpperCase()}`];
      if (fromEnv) return fromEnv;
      if (!store) return undefined;

      const { cmd, args } = store.read(name);
      const res = await exec(cmd, args);
      if (res.code !== 0) return undefined;
      return res.stdout.trim() || undefined;
    },
  };
}
