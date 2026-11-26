import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "../../../core/types.ts";
import { originIs } from "./rules.ts";

// The git a fix does, and all of it: Claude never runs git. Every call names its folder
// with `-C`, so nothing here depends on, or changes, the folder the tool runs in. The
// owner's clone is only ever fetched into and given a worktree; its own checkout, index
// and stash are never touched.

const MINUTE = 60_000;
const QUICK = 2 * MINUTE;
const SLOW = 15 * MINUTE; // a fetch or a checkout of a large repository
const SAID_MAX = 300;

type Ran = Awaited<ReturnType<Exec>>;

const run = (exec: Exec, dir: string, args: string[], timeoutMs = QUICK): Promise<Ran> => exec("git", ["-C", dir, ...args], { timeoutMs });

/** What git said, short enough for one line. Its messages hold paths and branch names, never tokens. */
function said(res: Ran): string {
  const text = (res.stderr.trim() || res.stdout.trim() || `git exited ${res.code}`).replace(/\s+/g, " ");
  return text.length <= SAID_MAX ? text : `${text.slice(0, SAID_MAX - 1)}…`;
}

async function must(exec: Exec, dir: string, args: string[], what: string, timeoutMs = QUICK): Promise<string> {
  const res = await run(exec, dir, args, timeoutMs);
  if (res.code !== 0) throw new Error(`${what}: ${said(res)}`);
  return res.stdout.trim();
}

const lines = (text: string) => text.split("\n").filter((line) => line !== "");

/** The clone named in config must be a git repository whose `origin` is this repository on this host. */
export async function checkClone(exec: Exec, clone: string, host: string, repo: string): Promise<void> {
  if (!existsSync(clone) || (await run(exec, clone, ["rev-parse", "--git-dir"])).code !== 0) {
    throw new Error(`${clone} is not a git repository`);
  }
  const origin = await run(exec, clone, ["remote", "get-url", "origin"]);
  if (origin.code !== 0 || !originIs(origin.stdout.trim(), host, repo)) {
    throw new Error(`${clone}: its origin is not ${repo} on ${host}`);
  }
}

/** Fetch the PR's two branches into the clone's remote-tracking refs, and say where the head branch now is. */
export async function fetchBranches(exec: Exec, clone: string, headRef: string, baseRef: string): Promise<{ headSha: string }> {
  const spec = (ref: string) => `+refs/heads/${ref}:refs/remotes/origin/${ref}`;
  const refs = headRef === baseRef ? [spec(headRef)] : [spec(headRef), spec(baseRef)];
  await must(exec, clone, ["fetch", "--no-tags", "origin", ...refs], "could not fetch the PR's branches", SLOW);
  return { headSha: await must(exec, clone, ["rev-parse", `refs/remotes/origin/${headRef}`], "could not find the fetched branch") };
}

/**
 * A throwaway worktree at one commit. Detached, because the owner often has the PR's
 * branch checked out already and git will not check a branch out twice.
 */
export async function addWorktree(exec: Exec, clone: string, dir: string, sha: string): Promise<void> {
  await must(exec, clone, ["worktree", "add", "--detach", dir, sha], "could not make the worktree", SLOW);
}

/** Start merging the base branch in, without committing. Conflicts are the expected result, not a failure. */
export async function startMerge(exec: Exec, dir: string, baseRef: string): Promise<{ conflicted: string[] }> {
  const merged = await run(exec, dir, ["merge", "--no-commit", "--no-ff", `origin/${baseRef}`], SLOW);
  const merging = (await run(exec, dir, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).code === 0;
  if (!merging) {
    if (merged.code === 0) throw new Error(`there is nothing to merge from ${baseRef}`);
    throw new Error(`could not merge ${baseRef}: ${said(merged)}`);
  }
  return { conflicted: lines(await must(exec, dir, ["diff", "--name-only", "--diff-filter=U"], "could not list the conflicts")) };
}

/** Everything in the worktree as it stands, as a tree id. Ignored files are not part of it. */
export async function snapshot(exec: Exec, dir: string): Promise<string> {
  await must(exec, dir, ["add", "-A"], "could not stage the worktree");
  return must(exec, dir, ["write-tree"], "could not record the worktree");
}

/** The paths that differ from an earlier snapshot: what was changed since it was taken. */
export async function changedSince(exec: Exec, dir: string, tree: string): Promise<string[]> {
  const now = await snapshot(exec, dir);
  if (now === tree) return [];
  return lines(await must(exec, dir, ["diff", "--name-only", tree, now], "could not list what changed"));
}

/** Which of these files still hold a conflict marker at the start of a line. */
export async function markersLeft(exec: Exec, dir: string, files: string[]): Promise<string[]> {
  if (files.length === 0) return [];
  const res = await run(exec, dir, ["grep", "-l", "-E", "^(<<<<<<<|>>>>>>>)", "--", ...files]);
  if (res.code === 1) return []; // git grep: nothing matched
  if (res.code !== 0) throw new Error(`could not look for conflict markers: ${said(res)}`);
  return lines(res.stdout);
}

/**
 * Hooks are switched off by pointing git at an empty hooks folder. A hook is a program,
 * and the repository's hooks may run files from the worktree, where Claude can write.
 */
const withoutHooks = (noHooks: string) => ["-c", `core.hooksPath=${noHooks}`];

/** Commit everything in the worktree that is not ignored. Returns the new commit. */
export async function commitAll(exec: Exec, dir: string, message: string, noHooks: string): Promise<string> {
  await must(exec, dir, ["add", "-A"], "could not stage the fix");
  const res = await exec("git", ["-C", dir, ...withoutHooks(noHooks), "commit", "--no-verify", "-m", message], { timeoutMs: QUICK });
  if (res.code !== 0) throw new Error(`could not commit the fix: ${said(res)}`);
  return must(exec, dir, ["rev-parse", "HEAD"], "could not read the new commit");
}

/** Push the worktree's commit to the PR's branch. Never forced: a branch that moved refuses it. */
export async function push(exec: Exec, dir: string, headRef: string, noHooks: string): Promise<void> {
  const res = await exec("git", ["-C", dir, ...withoutHooks(noHooks), "push", "--no-verify", "origin", `HEAD:refs/heads/${headRef}`], { timeoutMs: SLOW });
  if (res.code === 0) return;
  if (/\[rejected\]|fetch first|non-fast-forward/.test(res.stderr)) throw new Error("the branch moved while the fix was being made");
  throw new Error(`could not push the fix: ${said(res)}`);
}

/** Remove a worktree and git's record of it. Never throws: it runs when a fix is already ending. */
export async function removeWorktree(exec: Exec, clone: string, dir: string): Promise<void> {
  try {
    await run(exec, clone, ["worktree", "remove", "--force", dir]);
    rmSync(dir, { recursive: true, force: true });
    await run(exec, clone, ["worktree", "prune"]);
  } catch {
    // Nothing more can be done here; the next sweep tries again.
  }
}

/** Remove everything under the work folder: worktrees left by a run that was killed. Never throws. */
export async function sweepWorktrees(exec: Exec, clones: string[], workRoot: string): Promise<void> {
  let left: string[];
  try {
    left = readdirSync(workRoot);
  } catch {
    return; // no work folder, so nothing was left
  }
  if (left.length === 0) return;
  for (const name of left) {
    const dir = join(workRoot, name);
    try {
      for (const clone of clones) await run(exec, clone, ["worktree", "remove", "--force", dir]);
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Left for the next sweep.
    }
  }
  for (const clone of clones) {
    try {
      await run(exec, clone, ["worktree", "prune"]);
    } catch {
      // A clone that is gone has nothing to prune.
    }
  }
}
