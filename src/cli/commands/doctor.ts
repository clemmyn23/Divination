import { enabledSources } from "../../core/pipeline.ts";
import type { Check, Context, Source } from "../../core/types.ts";
import type { Command } from "../main.ts";

/** `doctor` asks every enabled source what it needs and whether it has it. */
export function doctorCommand(getCtx: () => Context, all: Source<any>[]): Command {
  return {
    summary: "doctor: check each source's access and settings",
    async run() {
      const ctx = getCtx();
      let failed = false;
      for (const source of enabledSources(ctx.config, all)) {
        let checks: Check[];
        try {
          checks = await source.doctor(ctx);
        } catch (e) {
          checks = [{ name: "doctor", ok: false, detail: e instanceof Error ? e.message : String(e) }];
        }
        console.log(source.title);
        for (const check of checks) {
          console.log(`  ${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`);
          if (!check.ok) {
            failed = true;
            if (check.fix) console.log(`    fix: ${check.fix}`);
          }
        }
      }
      return failed ? 1 : 0;
    },
  };
}
