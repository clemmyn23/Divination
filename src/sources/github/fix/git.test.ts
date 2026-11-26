// These tests run real git in throwaway folders: a bare "origin", a clone of it, and a
// PR branch that clashes with main. Nothing leaves the temp folder.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { realExec } from "../../../core/exec.ts";
import type { Exec } from "../../../core/types.ts";
import {
  addWorktree,
  changedSince,
  checkClone,
  commitAll,
  fetchBranches,
  markersLeft,
  push,
  removeWorktree,
  snapshot,
  startMerge,
  sweepWorktrees,
} from "./git.ts";

// The machine's own git settings (signing, hooks, templates) stay out of it.
const ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
const exec: Exec = (cmd, args, opts) => realExec(cmd, args, { ...opts, env: { ...opts?.env, ...ENV } });
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { env: { ...process.env, ...ENV }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

let hasGit = true;
try {
  execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
  hasGit = false;
}
const skip = hasGit ? false : "git is not installed";

const BRANCH = "me/ABC-101-writer";

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "divination-git-")));
  const origin = join(root, "origin.git");
  const clone = join(root, "clone");
  const work = join(root, "work");
  const noHooks = join(root, "no-hooks");
  mkdirSync(noHooks);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env: { ...process.env, ...ENV } });
  execFileSync("git", ["clone", "-q", origin, clone], { env: { ...process.env, ...ENV }, stdio: "ignore" });
  git(clone, "config", "user.name", "Test Person");
  git(clone, "config", "user.email", "test@example.com");
  const commit = (dir: string, files: Record<string, string>, message: string) => {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", message);
    return git(dir, "rev-parse", "HEAD");
  };
  git(clone, "checkout", "-q", "-b", "main");
  commit(clone, { "a.txt": "one\ntwo\nthree\n", ".gitignore": "ignored/\n" }, "start");
  git(clone, "push", "-q", "origin", "main");
  git(clone, "checkout", "-q", "-b", BRANCH);
  const head = commit(clone, { "a.txt": "one\nTWO from the branch\nthree\n" }, "branch change");
  git(clone, "push", "-q", "origin", BRANCH);
  git(clone, "checkout", "-q", "main");
  commit(clone, { "a.txt": "one\ntwo from main\nthree\n", "b.txt": "new on main\n" }, "main moves on");
  git(clone, "push", "-q", "origin", "main");
  return { root, origin, clone, work, noHooks, head, commit, tree: join(work, "acme-monolith-501") };
}

test("the clone must be a repository whose origin is this one", { skip }, async () => {
  const s = setup();
  git(s.clone, "remote", "set-url", "origin", "git@git.example.com:acme/monolith.git");
  await checkClone(exec, s.clone, "git.example.com", "acme/monolith");
  await assert.rejects(checkClone(exec, s.clone, "git.example.com", "acme/other"), /origin is not acme\/other/);
  await assert.rejects(checkClone(exec, s.root, "git.example.com", "acme/monolith"), /not a git repository/);
  await assert.rejects(checkClone(exec, join(s.root, "nowhere"), "git.example.com", "acme/monolith"), /not a git repository/);
});

test("a branch with slashes is fetched, checked out detached and pushed back", { skip }, async () => {
  const s = setup();
  assert.deepEqual(await fetchBranches(exec, s.clone, BRANCH, "main"), { headSha: s.head });
  await addWorktree(exec, s.clone, s.tree, s.head);
  assert.equal(git(s.tree, "rev-parse", "HEAD"), s.head);
  assert.equal(git(s.tree, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD"); // detached

  const before = await snapshot(exec, s.tree);
  writeFileSync(join(s.tree, "c.txt"), "added\n");
  assert.deepEqual(await changedSince(exec, s.tree, before), ["c.txt"]);
  const sha = await commitAll(exec, s.tree, "ABC-101: fix Style check\n\nAdded the file.", s.noHooks);
  await push(exec, s.tree, BRANCH, s.noHooks);

  assert.equal(git(s.origin, "rev-parse", `refs/heads/${BRANCH}`), sha);
  assert.equal(git(s.origin, "rev-parse", `${sha}^`), s.head);
  assert.equal(git(s.origin, "log", "-1", "--format=%s%n%n%b", sha), "ABC-101: fix Style check\n\nAdded the file.");
});

test("the same branch checked out in the clone does not stop the worktree, and the clone is left alone", { skip }, async () => {
  const s = setup();
  git(s.clone, "checkout", "-q", BRANCH);
  writeFileSync(join(s.clone, "scratch.txt"), "the owner's unsaved work\n");
  await fetchBranches(exec, s.clone, BRANCH, "main");
  await addWorktree(exec, s.clone, s.tree, s.head);
  writeFileSync(join(s.tree, "c.txt"), "added\n");
  await commitAll(exec, s.tree, "Fix it", s.noHooks);
  await push(exec, s.tree, BRANCH, s.noHooks);
  await removeWorktree(exec, s.clone, s.tree);

  assert.equal(git(s.clone, "rev-parse", "--abbrev-ref", "HEAD"), BRANCH);
  assert.equal(git(s.clone, "rev-parse", "HEAD"), s.head); // its branch was not moved under it
  assert.equal(readFileSync(join(s.clone, "scratch.txt"), "utf8"), "the owner's unsaved work\n");
  assert.equal(git(s.clone, "stash", "list"), "");
});

test("a merge lists what conflicted, and only what was changed after it counts", { skip }, async () => {
  const s = setup();
  await fetchBranches(exec, s.clone, BRANCH, "main");
  await addWorktree(exec, s.clone, s.tree, s.head);
  assert.deepEqual(await startMerge(exec, s.tree, "main"), { conflicted: ["a.txt"] });
  assert.deepEqual(await markersLeft(exec, s.tree, ["a.txt"]), ["a.txt"]);

  const before = await snapshot(exec, s.tree);
  writeFileSync(join(s.tree, "a.txt"), "one\nTWO from both\nthree\n");
  assert.deepEqual(await changedSince(exec, s.tree, before), ["a.txt"]); // not b.txt, which main brought in
  assert.deepEqual(await markersLeft(exec, s.tree, ["a.txt"]), []);
  assert.deepEqual(await markersLeft(exec, s.tree, []), []);

  const sha = await commitAll(exec, s.tree, "Merge main into me/ABC-101-writer\n\nKept both.", s.noHooks);
  assert.equal(git(s.tree, "rev-list", "--parents", "-1", sha).split(" ").length, 3); // a merge: two parents
  assert.equal(git(s.tree, "show", `${sha}:b.txt`), "new on main");
});

test("a merge with nothing to do, or that cannot start, says so", { skip }, async () => {
  const s = setup();
  await fetchBranches(exec, s.clone, "main", "main");
  const main = git(s.clone, "rev-parse", "refs/remotes/origin/main");
  await addWorktree(exec, s.clone, s.tree, main);
  await assert.rejects(startMerge(exec, s.tree, "main"), /nothing to merge/);
  await assert.rejects(startMerge(exec, s.tree, "no-such-branch"), /could not merge/);
});

test("hooks do not run for the commit or the push", { skip }, async () => {
  const s = setup();
  const ran = join(s.root, "hook-ran");
  for (const hook of ["pre-commit", "commit-msg", "pre-push"]) {
    const file = join(s.clone, ".git", "hooks", hook);
    writeFileSync(file, `#!/bin/sh\necho ran >> "${ran}"\nexit 1\n`);
    chmodSync(file, 0o755);
  }
  // The hooks are live: an ordinary commit in the clone is stopped by them.
  writeFileSync(join(s.clone, "x.txt"), "x\n");
  git(s.clone, "add", "-A");
  assert.throws(() => git(s.clone, "commit", "-q", "-m", "stopped"));
  assert.ok(existsSync(ran));
  writeFileSync(ran, "");
  git(s.clone, "reset", "-q", "--hard");

  await fetchBranches(exec, s.clone, BRANCH, "main");
  await addWorktree(exec, s.clone, s.tree, s.head);
  writeFileSync(join(s.tree, "c.txt"), "added\n");
  const sha = await commitAll(exec, s.tree, "Fix it", s.noHooks);
  await push(exec, s.tree, BRANCH, s.noHooks);
  assert.equal(readFileSync(ran, "utf8"), "");
  assert.equal(git(s.origin, "rev-parse", `refs/heads/${BRANCH}`), sha);
});

test("ignored files are not counted and not committed", { skip }, async () => {
  const s = setup();
  await fetchBranches(exec, s.clone, BRANCH, "main");
  await addWorktree(exec, s.clone, s.tree, s.head);
  const before = await snapshot(exec, s.tree);
  mkdirSync(join(s.tree, "ignored"));
  writeFileSync(join(s.tree, "ignored", "x"), "planted\n");
  writeFileSync(join(s.tree, "c.txt"), "added\n");
  assert.deepEqual(await changedSince(exec, s.tree, before), ["c.txt"]);
  const sha = await commitAll(exec, s.tree, "Fix it", s.noHooks);
  assert.deepEqual(git(s.tree, "show", "--name-only", "--format=", sha).split("\n"), ["c.txt"]);
});

test("nothing changed means nothing to list, and a commit of nothing is refused", { skip }, async () => {
  const s = setup();
  await fetchBranches(exec, s.clone, BRANCH, "main");
  await addWorktree(exec, s.clone, s.tree, s.head);
  const before = await snapshot(exec, s.tree);
  assert.deepEqual(await changedSince(exec, s.tree, before), []);
  await assert.rejects(commitAll(exec, s.tree, "Nothing", s.noHooks), /could not commit/);
});

test("a push to a branch that moved is refused and nothing is forced", { skip }, async () => {
  const s = setup();
  await fetchBranches(exec, s.clone, BRANCH, "main");
  await addWorktree(exec, s.clone, s.tree, s.head);

  const other = join(s.root, "other");
  execFileSync("git", ["clone", "-q", "-b", BRANCH, s.origin, other], { env: { ...process.env, ...ENV }, stdio: "ignore" });
  git(other, "config", "user.name", "Someone Else");
  git(other, "config", "user.email", "else@example.com");
  writeFileSync(join(other, "theirs.txt"), "theirs\n");
  git(other, "add", "-A");
  git(other, "commit", "-q", "-m", "their commit");
  git(other, "push", "-q", "origin", BRANCH);
  const theirs = git(other, "rev-parse", "HEAD");

  writeFileSync(join(s.tree, "c.txt"), "added\n");
  await commitAll(exec, s.tree, "Fix it", s.noHooks);
  await assert.rejects(push(exec, s.tree, BRANCH, s.noHooks), /the branch moved/);
  assert.equal(git(s.origin, "rev-parse", `refs/heads/${BRANCH}`), theirs);
});

test("removing and sweeping leave nothing behind, and never throw", { skip }, async () => {
  const s = setup();
  await fetchBranches(exec, s.clone, BRANCH, "main");
  await addWorktree(exec, s.clone, s.tree, s.head);
  writeFileSync(join(s.tree, "half-done.txt"), "uncommitted\n");
  await removeWorktree(exec, s.clone, s.tree);
  assert.ok(!existsSync(s.tree));
  assert.equal(git(s.clone, "worktree", "list").split("\n").length, 1);
  await removeWorktree(exec, s.clone, s.tree); // already gone

  await addWorktree(exec, s.clone, s.tree, s.head);
  mkdirSync(join(s.work, "stray"));
  writeFileSync(join(s.work, "stray", "junk"), "x");
  await sweepWorktrees(exec, [s.clone], s.work);
  assert.ok(!existsSync(s.tree) && !existsSync(join(s.work, "stray")));
  assert.equal(git(s.clone, "worktree", "list").split("\n").length, 1);

  await sweepWorktrees(exec, [s.clone], join(s.root, "no-such-folder"));
  await sweepWorktrees(exec, [join(s.root, "not-a-clone")], s.work);
});
