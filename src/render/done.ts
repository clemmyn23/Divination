import type { View } from "../core/types.ts";
import { esc } from "./html.ts";

/** True when the line with this key has been ticked off. */
export function isDone(key: string | undefined, view: View): boolean {
  return key !== undefined && Object.hasOwn(view.done, key);
}

/** The small button on a line that marks it done, or takes the mark back. */
export function tick(key: string, done: boolean): string {
  const label = done ? "Mark as not done" : "Mark as done";
  return `<button type="button" class="tick" data-done="${esc(key)}" data-state="${done ? "done" : "open"}" title="${label}" aria-label="${label}">✓</button>`;
}

/** Done lines, folded shut at the bottom of a panel. */
export function doneAccordion(count: number, inner: string): string {
  return `<details class="stale done">\n<summary>Done · ${count}</summary>\n${inner}\n</details>`;
}
