import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Context } from "../../core/types.ts";
import { LABEL, plist } from "../../schedule/launchd.ts";
import type { Command } from "../main.ts";

export interface ScheduleDeps {
  home: string;
  uid: number;
  node: string;
}

const realDeps = (): ScheduleDeps => ({ home: homedir(), uid: process.getuid?.() ?? 0, node: process.execPath });

/**
 * `schedule install | uninstall | status` manages the launchd agent that keeps
 * `divination serve` running from login. The agent only keeps the server alive; whether
 * updates are live is the page's Start / Pause button.
 */
export function scheduleCommand(getCtx: () => Context, deps: ScheduleDeps = realDeps()): Command {
  const file = join(deps.home, "Library", "LaunchAgents", `${LABEL}.plist`);
  const domain = `gui/${deps.uid}`;

  return {
    summary: "schedule install | uninstall | status: keep the page server running from login",
    async run(args) {
      const ctx = getCtx();
      const action = args[0];

      if (action === "install") {
        const dirs = [dirname(deps.node)];
        for (const tool of ["gh", "claude"]) {
          const found = await ctx.exec("which", [tool]);
          if (found.code === 0 && found.stdout.trim()) dirs.push(dirname(found.stdout.trim()));
        }
        dirs.push("/usr/bin", "/bin");

        mkdirSync(dirname(file), { recursive: true });
        mkdirSync(ctx.paths.logs, { recursive: true });
        writeFileSync(
          file,
          plist({
            label: LABEL,
            node: deps.node,
            script: join(ctx.root, "bin", "divination.ts"),
            root: ctx.root,
            path: [...new Set(dirs)].join(":"),
            logs: ctx.paths.logs,
          }),
        );

        await ctx.exec("launchctl", ["bootout", `${domain}/${LABEL}`]); // fails when it was not loaded; that is fine
        const loaded = await ctx.exec("launchctl", ["bootstrap", domain, file]);
        if (loaded.code !== 0) {
          console.log(`could not load the agent: ${loaded.stderr.trim() || `launchctl exited ${loaded.code}`}`);
          return 1;
        }
        console.log(`installed ${file}`);
        console.log(`the page is at http://127.0.0.1:${ctx.config.server.port}`);
        return 0;
      }

      if (action === "uninstall") {
        await ctx.exec("launchctl", ["bootout", `${domain}/${LABEL}`]);
        rmSync(file, { force: true });
        console.log(`removed ${file}`);
        return 0;
      }

      if (action === "status") {
        const loaded = (await ctx.exec("launchctl", ["print", `${domain}/${LABEL}`])).code === 0;
        console.log(loaded ? `${LABEL} is loaded` : `${LABEL} is not loaded`);
        const ticks = join(ctx.paths.logs, "ticks.jsonl");
        if (existsSync(ticks)) {
          const last = readFileSync(ticks, "utf8").trim().split("\n").at(-1);
          if (last) console.log(`last tick: ${last}`);
        }
        return 0;
      }

      console.log("Usage: divination schedule install | uninstall | status");
      return 1;
    },
  };
}
