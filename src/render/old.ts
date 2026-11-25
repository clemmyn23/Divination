import type { View } from "../core/types.ts";

const DAY = 86_400_000;

/**
 * True when something has been waiting longer than `hideOlderThanDays`. Such things are
 * folded into an accordion instead of being shown and counted. Something with no date is
 * never old, and a limit of 0 switches the folding off.
 */
export function isOld(at: number | undefined, view: View): boolean {
  const days = view.config.hideOlderThanDays;
  return days > 0 && at !== undefined && view.now - at > days * DAY;
}

/** The fold that holds old things. `inner` is already-escaped HTML. */
export function staleAccordion(count: number, inner: string): string {
  return `<details class="stale">
<summary>Expand for stale tasks · ${count}</summary>
${inner}
</details>`;
}
