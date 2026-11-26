import { join } from "node:path";
import { readJson, writeJson } from "../../../core/store.ts";
import type { Config, Context } from "../../../core/types.ts";
import type { Attempt, Ci, FixState } from "../types.ts";

// The record of what each fix did, and what follows from it: how many tries a PR has
// had in a row, and which commit was the owner's last.

const OUTCOMES = ["pushed", "gave-up", "failed"];

export const attemptsPath = (ctx: Context): string => join(ctx.paths.out, "fix", "attempts.json");

function isAttempt(v: unknown): v is Attempt {
  if (typeof v !== "object" || v === null) return false;
  const t = v as Partial<Attempt>;
  return (
    typeof t.startSha === "string" &&
    OUTCOMES.includes(String(t.outcome)) &&
    (t.pushedSha === undefined || typeof t.pushedSha === "string") &&
    // The page prints these and the count rests on them, so an entry without them is not an attempt.
    typeof t.at === "number" &&
    Number.isFinite(t.at) &&
    typeof t.text === "string" &&
    typeof t.ranClaude === "boolean"
  );
}

/**
 * Every PR's attempts, oldest first. The file can be edited or deleted by hand (that is
 * how a PR's count is reset), so anything in it that is not an attempt is left out
 * rather than trusted.
 */
export function readAttempts(ctx: Context): Record<string, Attempt[]> {
  const raw = readJson<unknown>(attemptsPath(ctx), {});
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, Attempt[]> = {};
  for (const [key, list] of Object.entries(raw)) {
    const attempts = Array.isArray(list) ? list.filter(isAttempt) : [];
    if (attempts.length > 0) out[key] = attempts;
  }
  return out;
}

export function recordAttempt(ctx: Context, key: string, attempt: Attempt): void {
  const all = readAttempts(ctx);
  writeJson(attemptsPath(ctx), { ...all, [key]: [...(all[key] ?? []), attempt] });
}

/**
 * The attempts made in a row up to the PR's current head, oldest first. Walking back from
 * the newest, an attempt belongs when the commit it left the PR on (the one it pushed,
 * or the one it started from if it pushed nothing) is where the chain stands. A commit
 * pushed by the owner is in no attempt, so it breaks the chain.
 */
export function chain(attempts: Attempt[], headSha: string): Attempt[] {
  const out: Attempt[] = [];
  let expected = headSha;
  for (let i = attempts.length - 1; i >= 0; i--) {
    const attempt = attempts[i]!;
    if ((attempt.pushedSha ?? attempt.startSha) !== expected) break;
    out.unshift(attempt);
    expected = attempt.startSha;
  }
  return out;
}

/** The newest commit on the PR that a fix did not push: where the chain started, or the head itself. */
export function ownerSha(attempts: Attempt[], headSha: string): string {
  return chain(attempts, headSha)[0]?.startSha ?? headSha;
}

/** Whether a PR of mine gets a Fix button now, and what the last attempt on it did. */
export function fixState(
  pr: { key: string; repo: string; draft: boolean; ci: Ci; conflicts: boolean; headSha: string },
  fix: Config["github"]["fix"],
  attempts: Attempt[],
): FixState {
  const row = chain(attempts, pr.headSha);
  const fixable = !pr.draft && (pr.ci === "fail" || pr.conflicts) && Object.hasOwn(fix.clones, pr.repo);
  const usedUp = row.filter((attempt) => attempt.ranClaude).length >= fix.maxAttempts;
  const newest = row.at(-1);
  return {
    can: fixable && !usedUp,
    spent: fixable && usedUp,
    ...(newest ? { last: { at: newest.at, outcome: newest.outcome, text: newest.text } } : {}),
  };
}
