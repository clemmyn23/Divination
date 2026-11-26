import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "../../../core/types.ts";
import { originIs } from "./rules.ts";

// The git a fix does, and all of it: Claude never runs git. Every call names its folder
// with `-C`, so nothing here depends on, or changes, the folder the tool runs in. The
// owner's clone is only ever fetched into and given a worktree; its own checkout, index
// and stash are never touched.
//
// Claude can write any file in the worktree, so nothing in it is trusted to tell git
// what to do:
// - Every call made in the worktree names git's own folder for it (`--git-dir`), so the
//   worktree's `.git` file is never read. A `.git` file pointed at a planted folder
//   would otherwise hand git a config, and a config can name a program to run.
// - Every call runs with hooks off (see `withoutHooks`), not only the commit and the push:
//   a repository can keep its hooks in a tracked folder, and `worktree add` runs them.
// - File names are read as git stores them (`-z`), never as it prints them in quotes.

const MINUTE = 60_000;
const QUICK = 2 * MINUTE;
const SLOW = 15 * MINUTE; // a fetch or a checkout of a large repository
const SAID_MAX = 300;

type Ran = Awaited<ReturnType<Exec>>;

/**
 * A fix's worktree, as git was told about it when it was made: the folder, git's own
 * folder for it inside the clone, and what its `.git` file said then.
 */
export interface Tree {
  dir: string;
  gitDir: string;
  dotGit: string;
}

type Where = string | Tree;

/** A clone is found by its folder. A worktree is never found: git is told where its own folder is. */
const at = (where: Where) => (typeof where === "string" ? ["-C", where] : ["-C", where.dir, `--git-dir=${where.gitDir}`, `--work-tree=${where.dir}`]);

const run = (exec: Exec, where: Where, args: string[], timeoutMs = QUICK): Promise<Ran> => exec("git", [...at(where), ...args], { timeoutMs });

/**
 * The same runner, with git's hooks switched off for every git call it makes: git is
 * pointed at an empty hooks folder. A hook is a program, and a repository's hooks may be
 * files from the worktree, where Claude can write.
 */
export function withoutHooks(exec: Exec, noHooks: string): Exec {
  return (cmd, args, opts) => exec(cmd, cmd === "git" ? ["-c", `core.hooksPath=${noHooks}`, ...args] : args, opts);
}

/** What git said, short enough for one line. Its messages hold paths and branch names, never tokens. */
function said(res: Ran): string {
  const text = (res.stderr.trim() || res.stdout.trim() || `git exited ${res.code}`).replace(/\s+/g, " ");
  return text.length <= SAID_MAX ? text : `${text.slice(0, SAID_MAX - 1)}…`;
}

async function must(exec: Exec, where: Where, args: string[], what: string, timeoutMs = QUICK): Promise<string> {
  const res = await run(exec, where, args, timeoutMs);
  if (res.code !== 0) throw new Error(`${what}: ${said(res)}`);
  return res.stdout.trim();
}

/** The names in a `-z` listing: each ends in a NUL, and none is quoted or escaped. */
const names = (listing: string) => listing.split("\0").filter((name) => name !== "");

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
export async function addWorktree(exec: Exec, clone: string, dir: string, sha: string): Promise<Tree> {
  await must(exec, clone, ["worktree", "add", "--detach", dir, sha], "could not make the worktree", SLOW);
  // Asked once, now, while everything in the folder is still git's own work.
  const gitDir = await must(exec, dir, ["rev-parse", "--absolute-git-dir"], "could not find the worktree's git folder");
  return { dir, gitDir, dotGit: readFileSync(join(dir, ".git"), "utf8") };
}

/**
 * Whether the worktree's `.git` is no longer the file git wrote. Git is never asked to
 * read it again either way; a change means something tried, and the fix is thrown away.
 */
export function tampered(tree: Tree): boolean {
  try {
    const file = join(tree.dir, ".git");
    return !statSync(file).isFile() || readFileSync(file, "utf8") !== tree.dotGit;
  } catch {
    return true;
  }
}

/** Start merging the base branch in, without committing. Conflicts are the expected result, not a failure. */
export async function startMerge(exec: Exec, tree: Tree, baseRef: string): Promise<{ conflicted: string[] }> {
  const merged = await run(exec, tree, ["merge", "--no-commit", "--no-ff", `origin/${baseRef}`], SLOW);
  const merging = (await run(exec, tree, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).code === 0;
  if (!merging) {
    if (merged.code === 0) throw new Error(`there is nothing to merge from ${baseRef}`);
    throw new Error(`could not merge ${baseRef}: ${said(merged)}`);
  }
  return { conflicted: names(await must(exec, tree, ["diff", "--name-only", "--diff-filter=U", "-z"], "could not list the conflicts")) };
}

/** Everything in the worktree as it stands, as a tree id. Ignored files are not part of it. */
export async function snapshot(exec: Exec, tree: Tree): Promise<string> {
  await must(exec, tree, ["add", "-A"], "could not stage the worktree");
  return must(exec, tree, ["write-tree"], "could not record the worktree");
}

/** The paths that differ from an earlier snapshot: what was changed since it was taken. */
export async function changedSince(exec: Exec, tree: Tree, earlier: string): Promise<string[]> {
  const now = await snapshot(exec, tree);
  if (now === earlier) return [];
  return names(await must(exec, tree, ["diff", "--name-only", "-z", earlier, now], "could not list what changed"));
}

/** Which of these files still hold a conflict marker at the start of a line. */
export async function markersLeft(exec: Exec, tree: Tree, files: string[]): Promise<string[]> {
  if (files.length === 0) return [];
  // `:(literal)` so a name with a star or a bracket in it is that file and not a pattern.
  const res = await run(exec, tree, ["grep", "-l", "-z", "-E", "^(<<<<<<<|>>>>>>>)", "--", ...files.map((file) => `:(literal)${file}`)]);
  if (res.code === 1) return []; // git grep: nothing matched
  if (res.code !== 0) throw new Error(`could not look for conflict markers: ${said(res)}`);
  return names(res.stdout);
}

/** Commit everything in the worktree that is not ignored. Returns the new commit. */
export async function commitAll(exec: Exec, tree: Tree, message: string): Promise<string> {
  await must(exec, tree, ["add", "-A"], "could not stage the fix");
  const res = await run(exec, tree, ["commit", "--no-verify", "-m", message]);
  if (res.code !== 0) throw new Error(`could not commit the fix: ${said(res)}`);
  return must(exec, tree, ["rev-parse", "HEAD"], "could not read the new commit");
}

/** Push the worktree's commit to the PR's branch. Never forced: a branch that moved refuses it. */
export async function push(exec: Exec, tree: Tree, headRef: string): Promise<void> {
  const res = await run(exec, tree, ["push", "--no-verify", "origin", `HEAD:refs/heads/${headRef}`], SLOW);
  if (res.code === 0) return;
  if (/\[rejected\]|fetch first|non-fast-forward/.test(res.stderr)) throw new Error("the branch moved while the fix was being made");
  throw new Error(`could not push the fix: ${said(res)}`);
}

/**
 * Remove a worktree and git's record of it. The folder is deleted as plain files and the
 * clone then forgets it, so git is never run on what Claude left there. Never throws: it
 * runs when a fix is already ending.
 */
export async function removeWorktree(exec: Exec, clone: string, dir: string): Promise<void> {
  try {
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
    try {
      rmSync(join(workRoot, name), { recursive: true, force: true });
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
