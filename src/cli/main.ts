import { fileURLToPath } from "node:url";
import { ConfigError } from "../core/config.ts";
import { createContext } from "../core/context.ts";
import type { Context } from "../core/types.ts";
import { sources } from "../sources/index.ts";
import { collectCommand } from "./commands/collect.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { enrichCommand } from "./commands/enrich.ts";
import { renderCommand } from "./commands/render.ts";
import { scheduleCommand } from "./commands/schedule.ts";
import { secretCommand } from "./commands/secret.ts";
import { serveCommand } from "./commands/serve.ts";
import { sweepPlanCommand } from "./commands/sweep-plan.ts";
import { tickCommand } from "./commands/tick.ts";

export interface Command {
  summary: string;
  run(args: string[]): Promise<number>;
}

const root = fileURLToPath(new URL("../..", import.meta.url));

let context: Context | undefined;
/** Built on first use, so commands that need no config still work when config is broken. */
const getCtx = () => (context ??= createContext(root));

export const commands: Record<string, Command> = {
  serve: serveCommand(getCtx, sources),
  doctor: doctorCommand(getCtx, sources),
  collect: collectCommand(getCtx, sources),
  render: renderCommand(getCtx, sources),
  tick: tickCommand(getCtx, sources),
  enrich: enrichCommand(getCtx, sources),
  schedule: scheduleCommand(getCtx),
  secret: secretCommand(),
  "sweep-plan": sweepPlanCommand(getCtx),
};

function usage(table: Record<string, Command>): string {
  const list = Object.values(table)
    .map((command) => `  ${command.summary}`)
    .join("\n");
  return `Usage: divination <command>\n\nCommands:\n${list || "  (none)"}`;
}

/** Run one command. Returns the process exit code. */
export async function main(argv: string[], table: Record<string, Command> = commands): Promise<number> {
  const [name, ...args] = argv;
  if (name === undefined) {
    console.log(usage(table));
    return 1;
  }
  const command = table[name];
  if (command === undefined) {
    console.log(`Unknown command: ${name}\n`);
    console.log(usage(table));
    return 1;
  }
  try {
    return await command.run(args);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.log(e.message);
      return 1;
    }
    throw e;
  }
}
