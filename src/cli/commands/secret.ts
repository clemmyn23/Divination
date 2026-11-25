import { spawn } from "node:child_process";
import { KEYCHAIN_SERVICE, isSecretName } from "../../core/secrets.ts";
import type { Command } from "../main.ts";

/** Runs a program attached to this terminal and resolves with its exit code. */
export type TerminalRun = (cmd: string, args: string[]) => Promise<number>;

const attached: TerminalRun = (cmd, args) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 1));
  });

/**
 * `secret set <name>` stores a token in the macOS Keychain. The Keychain tool asks for
 * the value itself, so the value never passes through this program.
 */
export function secretCommand(run: TerminalRun = attached): Command {
  return {
    summary: "secret set <name>: store a token in the macOS Keychain",
    async run(args) {
      const [action, name] = args;
      if (action !== "set" || name === undefined || !isSecretName(name)) {
        console.log("Usage: divination secret set <name>   (letters, digits and underscores, for example: slack)");
        return 1;
      }
      return run("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", name, "-w"]);
    },
  };
}
