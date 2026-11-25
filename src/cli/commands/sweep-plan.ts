import type { Context } from "../../core/types.ts";
import { sweepPlan } from "../../sources/slack/inbox.ts";
import type { Command } from "../main.ts";

/**
 * `sweep-plan` prints, as JSON, what a hand-started Slack sweep should read: the
 * conversations, the time window and where to write. It reads config and the clock
 * only; it calls nothing.
 */
export function sweepPlanCommand(getCtx: () => Context): Command {
  return {
    summary: "sweep-plan: print what a hand-started Slack sweep should read (used by /slack-sweep)",
    async run() {
      console.log(JSON.stringify(sweepPlan(getCtx()), null, 2));
      return 0;
    },
  };
}
