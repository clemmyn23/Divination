import { spawn } from "node:child_process";
import { type SecretStore, isSecretName, storeFor } from "../../core/secret-store.ts";
import type { Command } from "../main.ts";

/** Runs a program attached to this terminal and resolves with its exit code. */
export type TerminalRun = (cmd: string, args: string[]) => Promise<number>;

const COULD_NOT_START = 127;

const attached: TerminalRun = (cmd, args) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("error", () => resolve(COULD_NOT_START));
    child.on("close", (code) => resolve(code ?? 1));
  });

/**
 * `secret set <name>` stores a token in the platform's own token store: the macOS
 * Keychain, the Linux desktop keyring or the Windows Credential Manager. The store's tool
 * asks for the value itself, so the value never passes through this program.
 */
export function secretCommand(run: TerminalRun = attached, store: SecretStore | null = storeFor(process.platform)): Command {
  return {
    summary: "secret set <name>: store a token in this computer's token store",
    async run(args) {
      const [action, name] = args;
      if (action !== "set" || name === undefined || !isSecretName(name)) {
        console.log("Usage: divination secret set <name>   (letters, digits and underscores, for example: slack)");
        return 1;
      }
      const variable = `DIVINATION_${name.toUpperCase()}`;
      if (!store) {
        console.log(`There is no token store for this platform. Set ${variable} in the environment instead.`);
        return 1;
      }

      const { cmd, args: its } = store.write(name);
      const code = await run(cmd, its);
      if (code === COULD_NOT_START) {
        console.log(`${cmd} could not be started, so nothing was stored in ${store.label}. ${store.missing}`);
        console.log(`Or set ${variable} in the environment instead.`);
      }
      return code;
    },
  };
}
