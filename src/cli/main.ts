import { secretCommand } from "./commands/secret.ts";

export interface Command {
  summary: string;
  run(args: string[]): Promise<number>;
}

/** Commands are added here as later stages land (collect, render, serve and so on). */
export const commands: Record<string, Command> = {
  secret: secretCommand(),
};

function usage(): string {
  const names = Object.keys(commands);
  const width = Math.max(0, ...names.map((n) => n.length));
  const list = names.length
    ? names.map((n) => `  ${n.padEnd(width)}  ${commands[n]!.summary}`).join("\n")
    : "  (none yet)";
  return `Usage: divination <command>\n\nCommands:\n${list}`;
}

/** Run one command. Returns the process exit code. */
export async function main(argv: string[]): Promise<number> {
  const [name, ...args] = argv;
  if (name === undefined) {
    console.log(usage());
    return 1;
  }
  const command = commands[name];
  if (command === undefined) {
    console.log(`Unknown command: ${name}\n`);
    console.log(usage());
    return 1;
  }
  return command.run(args);
}
