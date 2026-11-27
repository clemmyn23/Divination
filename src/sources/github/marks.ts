import type { Ci } from "./types.ts";

const CI_TEXT: Record<Ci, string> = { pass: "CI ✓", fail: "CI ✗", pending: "CI …", none: "no CI" };

// Counts and the CI word are checked, not trusted: the data may have come from a dropped file.

/** The coloured CI mark on a PR's meta line. */
export function ciMark(value: Ci): string {
  const ci: Ci = Object.hasOwn(CI_TEXT, value) ? value : "none";
  return `<span class="ci-${ci}">${CI_TEXT[ci]}</span>`;
}

/** A PR's size on its meta line: lines added in green, lines removed in red. */
export function sizeMark(additions: unknown, deletions: unknown): string {
  const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : 0).toLocaleString("en-US");
  return `<span class="adds">+${count(additions)}</span> <span class="dels">−${count(deletions)}</span>`;
}
