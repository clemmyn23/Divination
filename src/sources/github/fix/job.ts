import { buildView, collectSource, readEnvelope } from "../../../core/pipeline.ts";
import type { Context, Source } from "../../../core/types.ts";
import { renderSite } from "../../../render/site.ts";
import { openFixable } from "../mine.panel.ts";
import type { GithubData } from "../types.ts";
import { type FixResult, fixOne } from "./run.ts";

/** Which PR a running job is on, and how far through its list. */
export interface FixProgress {
  key: string;
  index: number;
  total: number;
}

export interface FixTotals {
  pushed: number;
  gaveUp: number;
  failed: number;
  refused: number;
  /** Left untouched because the job was asked to stop. */
  skipped: number;
}

const COUNTED: Record<FixResult["outcome"], keyof FixTotals> = { pushed: "pushed", "gave-up": "gaveUp", failed: "failed", refused: "refused" };

/**
 * What the Fix button and the `fix` command run. `key` is one of my PRs, or `all` for
 * every fixable PR in the panel's open groups, taken once, at the press, in the panel's
 * order and fixed one at a time. After each PR, GitHub is collected again and the page
 * redrawn, so the page keeps up. A PR that fails does not stop the rest; a stop request
 * lets the PR in hand finish and skips what is left.
 *
 * A single fix that was not pushed ends the job with its reason, so the page's status
 * line can say why.
 */
export async function fixJob(
  ctx: Context,
  sources: Source<any>[],
  key: string,
  opts: { shouldStop?: () => boolean; onProgress?: (progress: FixProgress) => void; fix?: typeof fixOne } = {},
): Promise<FixTotals> {
  const fix = opts.fix ?? fixOne;
  const source = sources.find((s) => s.id === "github");
  if (!source) throw new Error("the github source is not switched on");
  const mine = (readEnvelope(source, ctx).data as GithubData | null)?.mine ?? [];

  let keys: string[];
  if (key === "all") {
    keys = openFixable(mine, buildView(ctx, sources)).map((pr) => pr.key);
    if (keys.length === 0) throw new Error("nothing to fix");
  } else {
    if (!mine.some((pr) => pr.key === key)) throw new Error(`${key} is not one of your open PRs`);
    keys = [key];
  }

  const totals: FixTotals = { pushed: 0, gaveUp: 0, failed: 0, refused: 0, skipped: 0 };
  let last: FixResult | undefined;
  for (const [i, next] of keys.entries()) {
    if (i > 0 && opts.shouldStop?.()) {
      totals.skipped = keys.length - i;
      break;
    }
    opts.onProgress?.({ key: next, index: i + 1, total: keys.length });
    last = await fix(ctx, next);
    totals[COUNTED[last.outcome]]++;
    await collectSource(source, ctx);
    renderSite(ctx, sources);
  }

  if (key === "all") ctx.log("fix-all", totals);
  else if (last && last.outcome !== "pushed") throw new Error(last.text);
  return totals;
}
