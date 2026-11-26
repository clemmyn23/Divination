import { enabledSources } from "../../core/pipeline.ts";
import type { Context, Source } from "../../core/types.ts";
import { createActivity } from "../../server/activity.ts";
import { fixJob } from "../../sources/github/fix/job.ts";
import type { fixOne } from "../../sources/github/fix/run.ts";
import type { Command } from "../main.ts";

/**
 * `fix <key | all>` fixes one of my PRs, or every one that can be fixed: Claude edits files
 * in a throwaway worktree and this tool pushes the result to that PR's branch. It is the
 * typed-by-hand twin of the page's Fix buttons, and the only other way a fix can start.
 * Each step is printed as it happens, in the words the page's activity log uses.
 */
export function fixCommand(getCtx: () => Context, all: Source<any>[], deps: { fix?: typeof fixOne } = {}): Command {
  return {
    summary: "fix <key | all>: fix one of your PRs, or every one that can be fixed (this calls Claude and pushes)",
    async run(args) {
      const [key] = args;
      if (key === undefined) {
        console.log("Usage: divination fix <key | all>   (a key is owner/repo#number, for example: acme/monolith#501)");
        return 1;
      }
      const base = getCtx();
      const sources = enabledSources(base.config, all);

      const activity = createActivity(base.now, []);
      activity.subscribe((update) => {
        if (update.type === "line") console.log(update.line.text);
      });
      const ctx: Context = {
        ...base,
        log(event, fields) {
          base.log(event, fields);
          activity.record(event, fields);
        },
      };

      try {
        const totals = await fixJob(ctx, sources, key, deps.fix ? { fix: deps.fix } : {});
        const counted = [`pushed ${totals.pushed}`, `gave up ${totals.gaveUp}`, `failed ${totals.failed}`];
        if (totals.refused > 0) counted.push(`not fixed ${totals.refused}`);
        if (totals.skipped > 0) counted.push(`skipped ${totals.skipped}`);
        console.log(counted.join(", "));
        return totals.failed + totals.refused > 0 ? 1 : 0;
      } catch (e) {
        console.log(`not fixed: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    },
  };
}
