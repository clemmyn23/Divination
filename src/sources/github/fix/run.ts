import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "../../../core/types.ts";
import { type Github, createGithub } from "../client.ts";
import { ciState } from "../collect.ts";
import type { Attempt } from "../types.ts";
import { askForFix } from "./ask.ts";
import { chain, readAttempts, recordAttempt } from "./attempts.ts";
import { failingChecks, whatToFix, whyNot } from "./checks.ts";
import { addWorktree, changedSince, checkClone, commitAll, fetchBranches, markersLeft, push, removeWorktree, snapshot, startMerge, sweepWorktrees } from "./git.ts";
import { type CheckLog, readLogs } from "./logs.ts";
import { commitMessage, touched, tried, worktreeName } from "./rules.ts";

/**
 * How one fix ended. `refused` means it never started (the PR may not be fixed, or there
 * is nothing to fix) and nothing was recorded; the others are recorded as an attempt.
 */
export interface FixResult {
  key: string;
  outcome: "pushed" | "gave-up" | "failed" | "refused";
  text: string;
}

export interface FixDeps {
  ask: typeof askForFix;
  github: (ctx: Context) => Github;
}

/** Where a fix's throwaway worktrees are made. Everything in it is removed when a fix ends. */
export const workRoot = (ctx: Context): string => join(ctx.paths.out, "fix", "work");
/** An empty folder git is pointed at for hooks, so that none run. */
export const noHooksDir = (ctx: Context): string => join(ctx.paths.out, "fix", "no-hooks");

const KEY = /^([\w.-]+\/[\w.-]+)#(\d+)$/;
const TEXT_MAX = 300;

const cut = (text: string) => (text.length <= TEXT_MAX ? text : `${text.slice(0, TEXT_MAX - 1)}…`);
const words = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A fix that ends on purpose, with how and why. Anything else thrown is a failure. */
class Stop extends Error {
  outcome: "gave-up" | "failed";
  constructor(outcome: "gave-up" | "failed", text: string) {
    super(text);
    this.outcome = outcome;
  }
}

/**
 * Fix one of my PRs: one attempt, start to finish. It never throws.
 *
 * What is asked of GitHub is asked fresh, now. Conflicts are fixed before failing CI,
 * and alone. Claude only edits files in a throwaway worktree; this code does the git,
 * with hooks off, and pushes to the PR's own branch and nowhere else, never forced.
 * However it ends, the worktree is removed. Nothing a log or a file says reaches
 * `ctx.log`: only step names, check names and Claude's own summary.
 */
export async function fixOne(ctx: Context, key: string, deps: Partial<FixDeps> = {}): Promise<FixResult> {
  const ask = deps.ask ?? askForFix;
  const fix = ctx.config.github.fix;
  const refuse = (text: string): FixResult => {
    ctx.log("fix-end", { key, outcome: "refused", text: cut(text) });
    return { key, outcome: "refused", text: cut(text) };
  };

  // ---- May it run, and what is there to fix? Nothing is recorded for a refusal. ----
  const named = KEY.exec(key);
  if (!named) return refuse(`${key} is not a PR`);
  const repo = named[1]!;
  const number = Number(named[2]);
  const clone = Object.hasOwn(fix.clones, repo) ? fix.clones[repo] : undefined;
  if (!clone) return refuse(`no clone of ${repo} is named in github.fix.clones`);

  let what: "ci" | "conflicts";
  let title: string;
  let headSha: string;
  let headRef: string;
  let baseRef: string;
  let checks: ReturnType<typeof failingChecks>;
  try {
    const gh = (deps.github ?? createGithub)(ctx);
    const [login, pull] = await Promise.all([gh.login(), gh.pull(repo, number)]);
    const why = whyNot(pull, login, repo);
    if (why) return refuse(why);
    headSha = pull.head.sha;
    headRef = pull.head.ref!;
    baseRef = pull.base!.ref;
    title = pull.title ?? "";

    const { runs, combined } = await gh.ci(repo, headSha);
    const found = whatToFix(pull, ciState(runs, combined));
    if (found === "running") return refuse("CI is still running");
    if (found === "nothing") return refuse("nothing to fix");
    what = found;
    checks = what === "ci" ? failingChecks(runs, combined) : [];

    const used = chain(readAttempts(ctx)[key] ?? [], headSha).filter((attempt) => attempt.ranClaude).length;
    if (used >= fix.maxAttempts) return refuse(tried(fix.maxAttempts));
    await checkClone(ctx.exec, clone, ctx.config.github.host, repo);
  } catch (e) {
    return refuse(words(e));
  }

  // ---- The attempt. From here on, whatever happens is recorded. ----
  ctx.log("fix-start", { key, what });
  const step = (name: string) => ctx.log("fix-step", { key, step: name });
  const attempt: Attempt = { at: ctx.now(), what, checks: checks.map((check) => check.name), startSha: headSha, outcome: "failed", text: "", ranClaude: false };
  const dir = join(workRoot(ctx), worktreeName(key));
  const noHooks = noHooksDir(ctx);
  let made = false;

  try {
    await sweepWorktrees(ctx.exec, Object.values(fix.clones), workRoot(ctx));

    let logs: CheckLog[] = [];
    if (what === "ci") {
      logs = await readLogs(ctx, checks, key);
      if (!logs.some((entry) => entry.log !== undefined)) throw new Stop("failed", "could not read any failing log");
    }

    step("making the worktree");
    const fetched = await fetchBranches(ctx.exec, clone, headRef, baseRef);
    if (fetched.headSha !== headSha) throw new Stop("failed", "the branch moved before the fix started");
    mkdirSync(workRoot(ctx), { recursive: true });
    mkdirSync(noHooks, { recursive: true });
    made = true; // from here a half-made worktree is removed too
    await addWorktree(ctx.exec, clone, dir, headSha);

    let conflicted: string[] = [];
    if (what === "conflicts") {
      step(`merging ${baseRef}`);
      conflicted = (await startMerge(ctx.exec, dir, baseRef)).conflicted;
      if (conflicted.length === 0) throw new Stop("failed", "git found no conflicts to resolve");
    }

    // What Claude changes is measured from here, so files the base branch brought in do not count.
    const before = await snapshot(ctx.exec, dir);
    step("asking Claude");
    attempt.ranClaude = true;
    const answer = await ask(ctx, {
      dir,
      what,
      title,
      logs,
      conflicted,
      onUsage: (usage) => {
        if (usage.costUsd !== undefined) attempt.costUsd = usage.costUsd;
      },
    });
    if (answer.outcome === "cannot") throw new Stop("gave-up", answer.reason);

    step("checking the change");
    const changed = await changedSince(ctx.exec, dir, before);
    if (changed.length === 0) throw new Stop("gave-up", "Claude changed nothing");
    const marked = await markersLeft(ctx.exec, dir, conflicted);
    if (marked.length > 0) throw new Stop("failed", `${marked[0]} still has conflict markers`);
    const forbidden = touched(changed, fix.neverTouch);
    if (forbidden) throw new Stop("failed", `the fix changed ${forbidden}, which a fix may not touch`);
    if (changed.length > fix.maxFiles) throw new Stop("failed", `the fix changed ${changed.length} files; the limit is ${fix.maxFiles}`);

    step("committing");
    const sha = await commitAll(ctx.exec, dir, commitMessage(what, { title, headRef, baseRef }, attempt.checks, answer.summary), noHooks);
    step("pushing");
    await push(ctx.exec, dir, headRef, noHooks);

    attempt.pushedSha = sha;
    attempt.outcome = "pushed";
    attempt.text = answer.summary;
  } catch (e) {
    attempt.outcome = e instanceof Stop ? e.outcome : "failed";
    attempt.text = words(e);
  } finally {
    if (made) await removeWorktree(ctx.exec, clone, dir);
  }

  attempt.text = cut(attempt.text);
  try {
    recordAttempt(ctx, key, attempt);
  } catch (e) {
    ctx.log("fix-step", { key, step: `could not record the attempt: ${words(e)}` });
  }
  ctx.log("fix-end", { key, outcome: attempt.outcome, text: attempt.text });
  return { key, outcome: attempt.outcome, text: attempt.text };
}
