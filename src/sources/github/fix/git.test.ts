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
  tampered,
  withoutHooks,
} from "./git.ts";

// The machine's own git settings (signing, hooks, templates) stay out of it.
const ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
const plain: Exec = (cmd, args, opts) => realExec(cmd, args, { ...opts, env: { ...opts?.env, ...ENV } });
// One empty folder for hooks, shared by every test: git is pointed at it so no hook runs.
const NO_HOOKS = realpathSync(mkdtempSync(join(tmpdir(), "divination-no-hooks-")));
const exec = withoutHooks(plain, NO_HOOKS);
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
  return { root, origin, clone, work, head, commit, tree: join(work, "acme-monolith-501") };
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
  const tree = await addWorktree(exec, s.clone, s.tree, s.head);
  assert.equal(git(s.tree, "rev-parse", "HEAD"), s.head);
  assert.equal(git(s.tree, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD"); // detached

  const before = await snapshot(exec, tree);
  writeFileSync(join(s.tree, "c.txt"), "added\n");
  assert.deepEqual(await changedSince(exec, tree, before), ["c.txt"]);
  const sha = await commitAll(exec, tree, "ABC-101: fix Style check\n\nAdded the file.");
  await push(exec, tree, BRANCH);

  assert.equal(git(s.origin, "rev-parse", `refs/heads/${BRANCH}`), sha);
  assert.equal(git(s.origin, "rev-parse", `${sha}^`), s.head);
  assert.equal(git(s.origin, "log", "-1", "--format=%s%n%n%b", sha), "ABC-101: fix Style check\n\nAdded the file.");
});

test("the same branch checked out in the clone does not stop the worktree, and the clone is left alone", { skip }, async () => {
  const s = setup();
  git(s.clone, "checkout", "-q", BRANCH);
  writeFileSync(join(s.clone, "scratch.txt"), "the owner's unsaved work\n");
  await fetchBranches(exec, s.clone, BRANCH, "main");
  const tree = await addWorktree(exec, s.clone, s.tree, s.head);
  writeFileSync(join(s.tree, "c.txt"), "added\n");
  await commitAll(exec, tree, "Fix it");
  await push(exec, tree, BRANCH);
  await removeWorktree(exec, s.clone, s.tree);

  assert.equal(git(s.clone, "rev-parse", "--abbrev-ref", "HEAD"), BRANCH);
  assert.equal(git(s.clone, "rev-parse", "HEAD"), s.head); // its branch was not moved under it
  assert.equal(readFileSync(join(s.clone, "scratch.txt"), "utf8"), "the owner's unsaved work\n");
  assert.equal(git(s.clone, "stash", "list"), "");
});

test("a merge lists what conflicted, and only what was changed after it counts", { skip }, async () => {
  const s = setup();
  await fetchBranches(exec, s.clone, BRANCH, "main");
  const tree = await addWorktree(exec, s.clone, s.tree, s.head);
  assert.deepEqual(await startMerge(exec, tree, "main"), { conflicted: ["a.txt"] });
  assert.deepEqual(await markersLeft(exec, tree, ["a.txt"]), ["a.txt"]);

  const before = await snapshot(exec, tree);
  writeFileSync(join(s.tree, "a.txt"), "one\nTWO from both\nthree\n");
  assert.deepEqual(await changedSince(exec, tree, before), ["a.txt"]); // not b.txt, which main brought in
  assert.deepEqual(await markersLeft(exec, tree, ["a.txt"]), []);
  assert.deepEqual(await markersLeft(exec, tree, []), []);

  const sha = await commitAll(exec, tree, "Merge main into me/ABC-101-writer\n\nKept both.");
  assert.equal(git(s.tree, "rev-list", "--parents", "-1", sha).split(" ").length, 3); // a merge: two parents
  assert.equal(git(s.tree, "show", `${sha}:b.txt`), "new on main");
});

test("a merge with nothing to do, or that cannot start, says so", { skip }, async () => {
  const s = setup();
  await fetchBranches(exec, s.clone, "main", "main");
  const main = git(s.clone, "rev-parse", "refs/remotes/origin/main");
  const tree = await addWorktree(exec, s.clone, s.tree, main);
  await assert.rejects(startMerge(exec, tree, "main"), /nothing to merge/);
  await assert.rejects(startMerge(exec, tree, "no-such-branch"), /could not merge/);
});

test("hooks in the clone's own hooks folder do not run for the commit or the push", { skip }, async () => {
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
  const tree = await addWorktree(exec, s.clone, s.tree, s.head);
  writeFileSync(join(s.tree, "c.txt"), "added\n");
  const sha = await commitAll(exec, tree, "Fix it");
  await push(exec, tree, BRANCH);
  assert.equal(readFileSync(ran, "utf8"), "");
  assert.equal(git(s.origin, "rev-parse", `refs/heads/${BRANCH}`), sha);
});

test("ignored files are not counted and not committed", { skip }, async () => {
  const s = setup();
  await fetchBranches(exec, s.clone, BRANCH, "main");
  const tree = await addWorktree(exec, s.clone, s.tree, s.head);
  const before = await snapshot(exec, tree);
  mkdirSync(join(s.tree, "ignored"));
  writeFileSync(join(s.tree, "ignored", "x"), "planted\n");
  writeFileSync(join(s.tree, "c.txt"), "added\n");
  assert.deepEqual(await changedSince(exec, tree, before), ["c.txt"]);
  const sha = await commitAll(exec, tree, "Fix it");
  assert.deepEqual(git(s.tree, "show", "--name-only", "--format=", sha).split("\n"), ["c.txt"]);
});

test("nothing changed means nothing to list, and a commit of nothing is refused", { skip }, async () => {
  const s = setup();
  await fetchBranches(exec, s.clone, BRANCH, "main");
  const tree = await addWorktree(exec, s.clone, s.tree, s.head);
  const before = await snapshot(exec, tree);
  assert.deepEqual(await changedSince(exec, tree, before), []);
  await assert.rejects(commitAll(exec, tree, "Nothing"), /could not commit/);
});

test("a push to a branch that moved is refused and nothing is forced", { skip }, async () => {
  const s = setup();
  await fetchBranches(exec, s.clone, BRANCH, "main");
  const tree = await addWorktree(exec, s.clone, s.tree, s.head);

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
  await commitAll(exec, tree, "Fix it");
  await assert.rejects(push(exec, tree, BRANCH), /the branch moved/);
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

test("a replaced .git file is noticed, and git never reads what it points at", { skip }, async () => {
  const s = setup();
  await fetchBranches(exec, s.clone, BRANCH, "main");
  const tree = await addWorktree(exec, s.clone, s.tree, s.head);
  assert.equal(tree.dir, s.tree);
  assert.equal(tree.gitDir, join(s.clone, ".git", "worktrees", "acme-monolith-501"));
  assert.equal(tampered(tree), false);
  const before = await snapshot(exec, tree);

  // What a model with write access to the folder could do: point .git at a folder of its
  // own, whose config names a program for git to run.
  const ran = join(s.root, "planted-program-ran");
  mkdirSync(join(s.tree, "evil", "refs"), { recursive: true });
  mkdirSync(join(s.tree, "evil", "objects"));
  writeFileSync(join(s.tree, "evil", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(s.tree, "evil", "config"), `[core]\n\trepositoryformatversion = 0\n\tfsmonitor = "touch ${ran}; false"\n`);
  writeFileSync(join(s.tree, ".git"), "gitdir: evil\n");
  writeFileSync(join(s.tree, "c.txt"), "added\n");
  assert.equal(tampered(tree), true);

  // Git is told where its own folder is, so the planted one is only files to it.
  assert.ok((await changedSince(exec, tree, before)).includes("c.txt"));
  assert.ok(!existsSync(ran));

  await removeWorktree(exec, s.clone, s.tree);
  assert.ok(!existsSync(s.tree) && !existsSync(ran));
  assert.equal(git(s.clone, "worktree", "list").split("\n").length, 1);
});

test("a .git that has become a folder, or gone, counts as tampered", { skip }, async () => {
  const s = setup();
  await fetchBranches(exec, s.clone, BRANCH, "main");
  const tree = await addWorktree(exec, s.clone, s.tree, s.head);
  assert.equal(tampered({ ...tree, dir: join(s.root, "nowhere") }), true);
  assert.equal(tampered({ ...tree, dir: s.clone }), true); // the clone's .git is a folder
  assert.equal(tampered({ ...tree, dotGit: "gitdir: somewhere else\n" }), true);
  assert.equal(tampered(tree), false);
});

test("hooks the repository itself configures run for no step at all", { skip }, async () => {
  const s = setup();
  const ran = join(s.root, "hook-ran");
  const hooks = join(s.root, "configured-hooks");
  mkdirSync(hooks);
  for (const hook of ["post-checkout", "reference-transaction", "pre-commit", "commit-msg", "post-commit", "pre-push", "post-merge", "pre-merge-commit"]) {
    writeFileSync(join(hooks, hook), `#!/bin/sh\necho ${hook} >> "${ran}"\n`);
    chmodSync(join(hooks, hook), 0o755);
  }
  git(s.clone, "config", "core.hooksPath", hooks);

  // The hooks are live: making a worktree the ordinary way runs them.
  await addWorktree(plain, s.clone, join(s.work, "ordinary"), s.head);
  assert.ok(existsSync(ran));
  await removeWorktree(plain, s.clone, join(s.work, "ordinary"));
  writeFileSync(ran, "");

  await fetchBranches(exec, s.clone, BRANCH, "main");
  const tree = await addWorktree(exec, s.clone, s.tree, s.head);
  await startMerge(exec, tree, "main");
  const before = await snapshot(exec, tree);
  writeFileSync(join(s.tree, "a.txt"), "one\nTWO from both\nthree\n");
  await changedSince(exec, tree, before);
  await commitAll(exec, tree, "Merge main");
  await push(exec, tree, BRANCH);
  await removeWorktree(exec, s.clone, s.tree);
  assert.equal(readFileSync(ran, "utf8"), "");
});

test("names git would put in quotes are listed as they are", { skip }, async () => {
  const s = setup();
  // A file with an accent in its name, changed on both sides.
  git(s.clone, "checkout", "-q", BRANCH);
  const head = s.commit(s.clone, { "café.txt": "from the branch\n" }, "branch adds a file");
  git(s.clone, "push", "-q", "origin", BRANCH);
  git(s.clone, "checkout", "-q", "main");
  s.commit(s.clone, { "café.txt": "from main\n" }, "main adds the same file");
  git(s.clone, "push", "-q", "origin", "main");

  await fetchBranches(exec, s.clone, BRANCH, "main");
  const tree = await addWorktree(exec, s.clone, s.tree, head);
  assert.deepEqual((await startMerge(exec, tree, "main")).conflicted.sort(), ["a.txt", "café.txt"]);
  assert.deepEqual(await markersLeft(exec, tree, ["café.txt"]), ["café.txt"]);

  const before = await snapshot(exec, tree);
  mkdirSync(join(s.tree, ".github", "workflows"), { recursive: true });
  writeFileSync(join(s.tree, ".github", "workflows", "é \"new\".yml"), "on: push\n");
  assert.deepEqual(await changedSince(exec, tree, before), ['.github/workflows/é "new".yml']);
});
