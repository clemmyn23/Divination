import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MINE2, type MyPullFixture, githubRoutes } from "../../../../test/fixtures/github/api.ts";
import { contextWith, fakeHttp } from "../../../../test/helpers.ts";
import type { Exec } from "../../../core/types.ts";
import type { Attempt } from "../types.ts";
import type { FixAnswer, askForFix } from "./ask.ts";
import { readAttempts, recordAttempt } from "./attempts.ts";
import { fixOne, workRoot } from "./run.ts";

const KEY = "o/r#8";
const SHA = MINE2.sha;
const BUILD = "https://ci.example.com/teamcity/buildConfiguration/Acme_Style/4090522";
const FAILING: MyPullFixture = { ...MINE2, mergeable: true, statuses: [{ state: "failure", context: "Style check", target_url: BUILD }] };
const CONFLICTED: MyPullFixture = { ...MINE2, mergeable: false };

type Reply = { code?: number; stdout?: string; stderr?: string };

/** A stand-in for git and teamcity: the first pattern found in the command line answers it. */
function scripted(over: Record<string, Reply | (() => Reply)> = {}) {
  const calls: string[][] = [];
  const trees = ["tree-before", "tree-after"];
  const usual: Record<string, Reply | (() => Reply)> = {
    "remote get-url origin": { stdout: "git@git.example.com:o/r.git\n" },
    "teamcity run log": { stdout: "Writer.cs(223,28): [SA1201] ZEBRAWORD\n" },
    "rev-parse refs/remotes/origin/": { stdout: `${SHA}\n` },
    "merge --no-commit": { code: 1, stdout: "CONFLICT (content)" },
    "diff --name-only --diff-filter=U": { stdout: "a.txt\n" },
    "write-tree": () => ({ stdout: `${trees.shift() ?? "tree-after"}\n` }),
    "diff --name-only tree-before tree-after": { stdout: "src/Writer.cs\n" },
    " grep -l": { code: 1 },
    "rev-parse HEAD": { stdout: "fixsha\n" },
  };
  const table = Object.entries({ ...over, ...usual, ...over }); // what a test gives is looked at first
  const exec: Exec = async (cmd, args) => {
    if (cmd === "gh") return { code: 0, stdout: "a-token\n", stderr: "" }; // the API client asking for its token
    calls.push([cmd, ...args]);
    const line = [cmd, ...args].join(" ");
    const found = table.find(([pattern]) => line.includes(pattern))?.[1];
    const reply = typeof found === "function" ? found() : (found ?? {});
    return { code: reply.code ?? 0, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" };
  };
  return { exec, calls };
}

interface Setup {
  pull?: MyPullFixture;
  git?: Record<string, Reply | (() => Reply)>;
  answer?: FixAnswer | Error;
  config?: object;
  clone?: string | null;
}

async function fixing(setup: Setup = {}) {
  const clone = setup.clone === undefined ? mkdtempSync(join(tmpdir(), "divination-clone-")) : setup.clone;
  const { exec, calls } = scripted(setup.git);
  const logged: [string, Record<string, unknown>][] = [];
  const ctx = contextWith(
    { github: { host: "git.example.com", fix: { clones: clone === null ? {} : { "o/r": clone }, ...setup.config } } },
    { exec, http: fakeHttp(githubRoutes([], "me", [setup.pull ?? FAILING])), log: (event, fields) => logged.push([event, { ...(fields as object) }]) },
  );
  const asked: Parameters<typeof askForFix>[1][] = [];
  const ask: typeof askForFix = async (_ctx, job) => {
    asked.push(job);
    job.onUsage?.({ costUsd: 0.42 });
    const answer = setup.answer ?? { outcome: "fixed", summary: "Moved the helper above the struct." };
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { ctx, calls, logged, asked, ask, clone: clone ?? "" };
}

/** The git and teamcity commands that ran, each as its first words after `-C <dir>`. */
const steps = (calls: string[][]) =>
  calls.map((c) => (c[0] === "git" ? c.slice(3).filter((a) => !a.startsWith("core.hooksPath=") && a !== "-c") : c).slice(0, c[0] === "git" ? 2 : 3).join(" "));

const ran = (calls: string[][], word: string) => steps(calls).some((s) => s.startsWith(word));
const record = (ctx: Parameters<typeof readAttempts>[0]): Attempt[] => readAttempts(ctx)[KEY] ?? [];

test("a failing PR is fixed: logs, worktree, Claude, commit, push, clean up", async () => {
  const s = await fixing();
  const result = await fixOne(s.ctx, KEY, { ask: s.ask });
  assert.deepEqual(result, { key: KEY, outcome: "pushed", text: "Moved the helper above the struct." });

  assert.deepEqual(steps(s.calls), [
    "rev-parse --git-dir",
    "remote get-url",
    "teamcity run log",
    "fetch --no-tags",
    "rev-parse refs/remotes/origin/me/ABC-8",
    "worktree add",
    "add -A",
    "write-tree",
    "add -A",
    "write-tree",
    "diff --name-only",
    "add -A",
    "commit --no-verify",
    "rev-parse HEAD",
    "push --no-verify",
    "worktree remove",
    "worktree prune",
  ]);

  const tree = join(workRoot(s.ctx), "o-r-8");
  const commit = s.calls.find((c) => c.includes("commit"))!;
  const push = s.calls.find((c) => c.includes("push"))!;
  assert.deepEqual(commit.slice(0, 3), ["git", "-C", tree]);
  assert.ok(commit.some((a) => a.startsWith("core.hooksPath=")) && push.some((a) => a.startsWith("core.hooksPath=")));
  assert.equal(commit.at(-1), "ABC-8: fix Style check\n\nMoved the helper above the struct.");
  assert.deepEqual(push.slice(-2), ["origin", "HEAD:refs/heads/me/ABC-8"]);
  // Force appears once, to remove the throwaway worktree, and never on a push.
  assert.deepEqual(s.calls.filter((c) => c.some((a) => /^(--force|-f|--force-with-lease)$/.test(a) || a.startsWith("+HEAD"))).map((c) => c.slice(3, 5)), [["worktree", "remove"]]);

  assert.deepEqual(s.asked.map((j) => [j.dir, j.what, j.title, j.conflicted]), [[tree, "ci", "ABC-8: PR number 8", []]]);
  assert.deepEqual(s.asked[0]!.logs, [{ name: "Style check", log: "Writer.cs(223,28): [SA1201] ZEBRAWORD\n" }]);
  assert.deepEqual(record(s.ctx), [
    { at: s.ctx.now(), what: "ci", checks: ["Style check"], startSha: SHA, pushedSha: "fixsha", outcome: "pushed", text: "Moved the helper above the struct.", ranClaude: true, costUsd: 0.42 },
  ]);
});

test("each step is told as it happens, and nothing from the log or the files is logged", async () => {
  const s = await fixing();
  await fixOne(s.ctx, KEY, { ask: s.ask });
  assert.deepEqual(s.logged.filter(([e]) => e.startsWith("fix-")), [
    ["fix-start", { key: KEY, what: "ci" }],
    ["fix-step", { key: KEY, step: "reading the log of Style check" }],
    ["fix-step", { key: KEY, step: "making the worktree" }],
    ["fix-step", { key: KEY, step: "asking Claude" }],
    ["fix-step", { key: KEY, step: "checking the change" }],
    ["fix-step", { key: KEY, step: "committing" }],
    ["fix-step", { key: KEY, step: "pushing" }],
    ["fix-end", { key: KEY, outcome: "pushed", text: "Moved the helper above the struct." }],
  ]);
  assert.ok(!JSON.stringify(s.logged).includes("ZEBRAWORD"));
});

test("a conflicted PR gets the merge, and its CI is left for next time", async () => {
  const s = await fixing({ pull: CONFLICTED, git: { "diff --name-only tree-before tree-after": { stdout: "a.txt\n" } } });
  const result = await fixOne(s.ctx, KEY, { ask: s.ask });
  assert.equal(result.outcome, "pushed");
  assert.ok(ran(s.calls, "merge --no-commit") && !ran(s.calls, "teamcity"));
  assert.deepEqual(s.calls.find((c) => c.includes("merge"))!.slice(3), ["merge", "--no-commit", "--no-ff", "origin/main"]);
  assert.deepEqual(s.asked.map((j) => [j.what, j.conflicted, j.logs]), [["conflicts", ["a.txt"], []]]);
  assert.ok(s.calls.find((c) => c.includes("commit"))!.at(-1)!.startsWith("Merge main into me/ABC-8\n\n"));
  assert.ok(s.logged.some(([e, f]) => e === "fix-step" && f.step === "merging main"));
  assert.deepEqual(record(s.ctx).map((a) => [a.what, a.checks, a.outcome]), [["conflicts", [], "pushed"]]);
});

/** A fix that must end without a commit or a push, with the worktree removed if one was made. */
async function stops(setup: Setup, expected: { outcome: string; text: RegExp; recorded: boolean; ranClaude?: boolean; madeTree?: boolean; noGit?: boolean }) {
  const s = await fixing(setup);
  const result = await fixOne(s.ctx, KEY, { ask: s.ask });
  assert.equal(result.outcome, expected.outcome, result.text);
  assert.match(result.text, expected.text);
  assert.ok(!ran(s.calls, "commit") && !ran(s.calls, "push"), "nothing may be committed or pushed");
  if (expected.madeTree ?? ran(s.calls, "worktree add")) assert.ok(ran(s.calls, "worktree remove"), "the worktree must be removed");
  if (expected.noGit) assert.deepEqual(s.calls, []);
  const kept = record(s.ctx);
  assert.equal(kept.length, expected.recorded ? 1 : 0);
  if (expected.recorded) {
    assert.equal(kept[0]!.ranClaude, expected.ranClaude);
    assert.equal(kept[0]!.outcome, expected.outcome);
    assert.equal(kept[0]!.pushedSha, undefined);
  }
  assert.deepEqual(s.logged.filter(([e]) => e === "fix-end").map(([, f]) => f.outcome), [expected.outcome]);
  return s;
}

test("a PR that may not be fixed is refused before any command runs, and nothing is recorded", async () => {
  const refused = { outcome: "refused", recorded: false, noGit: true };
  await stops({ pull: { ...FAILING, pull: { draft: true } } }, { ...refused, text: /^the PR is a draft$/ });
  await stops({ pull: { ...FAILING, pull: { state: "closed" } } }, { ...refused, text: /^the PR is not open$/ });
  await stops({ pull: { ...FAILING, pull: { user: { login: "ann" } } } }, { ...refused, text: /^the PR is not yours$/ });
  await stops({ pull: { ...FAILING, pull: { head: { sha: SHA, ref: "x", repo: { full_name: "ann/r" } } } } }, { ...refused, text: /^the PR comes from a fork$/ });
  await stops({ clone: null }, { ...refused, text: /^no clone of o\/r is named in github\.fix\.clones$/ });
  await stops({ pull: { ...FAILING, status: { state: "pending", total_count: 1 } } }, { ...refused, text: /^CI is still running$/ });
  await stops({ pull: { ...FAILING, status: { state: "success", total_count: 1 } } }, { ...refused, text: /^nothing to fix$/ });
});

test("a key that is not a PR, or a PR GitHub does not know, is refused", async () => {
  const s = await fixing();
  assert.deepEqual(await fixOne(s.ctx, "nonsense", { ask: s.ask }), { key: "nonsense", outcome: "refused", text: "nonsense is not a PR" });
  const missing = await fixOne(s.ctx, "o/r#999", { ask: s.ask });
  assert.equal(missing.outcome, "refused");
  assert.deepEqual(s.calls, []);
});

test("a clone that is not this repository is refused", async () => {
  await stops({ git: { "remote get-url origin": { stdout: "git@git.example.com:o/other.git\n" } } }, { outcome: "refused", recorded: false, text: /its origin is not o\/r on git\.example\.com/ });
  await stops({ clone: "/no/such/folder" }, { outcome: "refused", recorded: false, text: /is not a git repository/ });
});

test("at the limit a fix is refused in the page's words", async () => {
  const s = await fixing();
  recordAttempt(s.ctx, KEY, { at: 1, what: "ci", checks: [], startSha: "s0", pushedSha: "s1", outcome: "pushed", text: "one", ranClaude: true });
  recordAttempt(s.ctx, KEY, { at: 2, what: "ci", checks: [], startSha: "s1", pushedSha: SHA, outcome: "pushed", text: "two", ranClaude: true });
  assert.deepEqual(await fixOne(s.ctx, KEY, { ask: s.ask }), { key: KEY, outcome: "refused", text: "tried twice, over to you" });
  assert.equal(record(s.ctx).length, 2);
  assert.deepEqual(s.asked, []);

  const three = await fixing({ config: { maxAttempts: 3 } });
  recordAttempt(three.ctx, KEY, { at: 1, what: "ci", checks: [], startSha: "s0", pushedSha: "s1", outcome: "pushed", text: "one", ranClaude: true });
  recordAttempt(three.ctx, KEY, { at: 2, what: "ci", checks: [], startSha: "s1", pushedSha: SHA, outcome: "pushed", text: "two", ranClaude: true });
  assert.equal((await fixOne(three.ctx, KEY, { ask: three.ask })).outcome, "pushed");
});

test("a fix that ends before Claude is asked is recorded but does not count", async () => {
  const early = { outcome: "failed", recorded: true, ranClaude: false };
  await stops({ git: { "teamcity run log": { code: 1 } } }, { ...early, text: /^could not read any failing log$/ });
  await stops({ pull: { ...FAILING, statuses: [{ state: "failure", context: "Style check" }] } }, { ...early, text: /^could not read any failing log$/ });
  await stops({ git: { "rev-parse refs/remotes/origin/": { stdout: "someone-elses-sha\n" } } }, { ...early, text: /the branch moved/ });
  await stops({ git: { " fetch ": { code: 1, stderr: "fatal: could not read from remote" } } }, { ...early, text: /could not fetch the PR's branches/ });
  await stops({ git: { "worktree add": { code: 128, stderr: "fatal: already exists" } } }, { ...early, text: /could not make the worktree/, madeTree: true });
  await stops({ pull: CONFLICTED, git: { "rev-parse -q --verify MERGE_HEAD": { code: 1 }, "merge --no-commit": { code: 0 } } }, { ...early, text: /nothing to merge/ });
});

test("when Claude cannot fix it, or changes nothing, nothing is pushed", async () => {
  const gaveUp = { outcome: "gave-up", recorded: true, ranClaude: true };
  await stops({ answer: { outcome: "cannot", summary: "Not fixed.", reason: "The build machine ran out of disk." } }, { ...gaveUp, text: /^The build machine ran out of disk\.$/ });
  await stops({ git: { "write-tree": { stdout: "same-tree\n" } } }, { ...gaveUp, text: /^Claude changed nothing$/ });
});

test("a fix that breaks a rule, or that Claude could not finish, is thrown away", async () => {
  const failed = { outcome: "failed", recorded: true, ranClaude: true };
  const changed = (paths: string[]) => ({ "diff --name-only tree-before tree-after": { stdout: `${paths.join("\n")}\n` } });
  await stops({ git: changed(["src/Writer.cs", ".github/workflows/ci.yml"]) }, { ...failed, text: /^the fix changed \.github\/workflows\/ci\.yml, which a fix may not touch$/ });
  await stops({ git: changed(Array.from({ length: 21 }, (_, i) => `src/f${i}.cs`)) }, { ...failed, text: /^the fix changed 21 files; the limit is 20$/ });
  await stops({ pull: CONFLICTED, git: { ...changed(["a.txt"]), " grep -l": { stdout: "a.txt\n" } } }, { ...failed, text: /^a\.txt still has conflict markers$/ });
  await stops({ answer: new Error("claude failed: timed out") }, { ...failed, text: /^claude failed: timed out$/ });
  await stops({ answer: new Error("claude answered in the wrong shape") }, { ...failed, text: /wrong shape/ });
});

test("a commit or a push that fails leaves nothing pushed on record", async () => {
  const s = await fixing({ git: { "push --no-verify": { code: 1, stderr: " ! [rejected] HEAD -> me/ABC-8 (fetch first)" } } });
  const result = await fixOne(s.ctx, KEY, { ask: s.ask });
  assert.equal(result.outcome, "failed");
  assert.match(result.text, /the branch moved/);
  assert.ok(ran(s.calls, "worktree remove"));
  assert.deepEqual(record(s.ctx).map((a) => [a.outcome, a.ranClaude, a.pushedSha]), [["failed", true, undefined]]);

  const t = await fixing({ git: { "commit --no-verify": { code: 1, stderr: "error: gpg failed to sign the data" } } });
  const second = await fixOne(t.ctx, KEY, { ask: t.ask });
  assert.match(second.text, /could not commit the fix: error: gpg failed to sign the data/);
  assert.ok(!ran(t.calls, "push") && ran(t.calls, "worktree remove"));
});

test("a leftover worktree is swept before the fix starts", async () => {
  const s = await fixing();
  const leftover = join(workRoot(s.ctx), "o-r-3");
  mkdirSync(leftover, { recursive: true });
  await fixOne(s.ctx, KEY, { ask: s.ask });
  assert.ok(!existsSync(leftover));
  const sweep = steps(s.calls).indexOf("worktree remove");
  assert.ok(sweep >= 0 && sweep < steps(s.calls).indexOf("teamcity run log"));
  assert.deepEqual(s.calls[sweep]!.slice(-1), [leftover]);
});

test("a long reason is cut to fit a line", async () => {
  const s = await fixing({ answer: { outcome: "cannot", summary: "x", reason: "r".repeat(1000) } });
  const result = await fixOne(s.ctx, KEY, { ask: s.ask });
  assert.equal(result.text.length, 300);
  assert.ok(result.text.endsWith("…"));
});
