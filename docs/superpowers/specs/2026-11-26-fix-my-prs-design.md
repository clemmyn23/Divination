# Fix my PRs: design

Date: 2026-11-26

## Intent

The My PRs panel lists the owner's open PRs that need fixing. On the day this was
written there were 18: 14 failing CI and 8 with merge conflicts (4 of them both); none
were waiting on a comment. All were in one large repository, built by TeamCity, and most
of the failing checks (a C# style check, Docker integration tests, unit tests) cannot be
run on the owner's laptop.

The owner wants that pile cleared without working through it by hand: press a button, and
Claude fixes the PR on its own branch.

This is the first thing the dashboard does that changes anything outside the laptop. The
design keeps that one step, the push, in code that can be tested.

## What the owner decided

- **A button, and it pushes.** A fix starts only when the owner presses **Fix** (or **Fix
  all**). The result is pushed to the PR's branch without a second confirmation. Nothing
  starts on a timer or on a refresh.
- **The dashboard runs the fix, and its own code does the git.** Claude only reads and
  edits files in a throwaway worktree. It never runs git, never reaches GitHub, TeamCity
  or the network.

## Goals

- A **Fix** button on each PR of the owner's that is failing CI or has merge conflicts.
- A **Fix all** button that works through every such PR, one at a time.
- The PR's line says what the last attempt did.
- A fix that cannot be made says why, and pushes nothing.
- The same thing from the command line: `divination fix <key | all>`.

## Non-goals

- Answering review comments. No PR is waiting on one today, and answering speaks as the
  owner. It is a later, separate piece of work.
- Logs from anything other than TeamCity (GitHub Actions and so on). A failing check
  whose log cannot be read is reported as such.
- Building or running tests on the laptop. CI is the test.
- PRs from a fork, and draft PRs.
- Starting a fix automatically.
- Re-running a build. When a log shows the build machine failed rather than the code,
  the fix says so and stops.

## Anti-goals

These would make the feature a failure even if it "works":

- A push to any branch other than the head branch of the PR that was pressed, or any
  forced push.
- A check made to pass by weakening it: a test deleted or skipped, a rule suppressed, CI
  configuration changed.
- The owner's own checkouts disturbed: a branch switched, a file changed, a stash made in
  the clone or any of its existing worktrees.
- A worktree left behind after a fix ends, however it ends.
- Anything Claude wrote being run as a program on the laptop, by a git hook or otherwise.
- Log contents, file contents or tokens written to the dashboard's own log.

## Approaches considered

**A. The dashboard runs Claude headless; the dashboard's code does the git. (Chosen.)**
The code fetches the failing logs, makes a worktree, runs Claude there with file tools
only, then commits and pushes. A wrong push is impossible by construction, and it works
for a teammate with nothing but the dashboard. The cost: a run cannot be steered, and
Claude sees only the logs it is handed.

**B. The dashboard runs Claude headless with a shell (`git`, `gh`, `teamcity`).** More
capable, because Claude can pull another log or compare builds. Rejected because the
limits become a prompt and an allow-list of commands rather than code.

**C. Hand each PR to a session in the Claude desktop app.** Sessions can be watched and
steered. Rejected because the page cannot start app sessions, so there would be no
button, and because it needs the desktop app and so travels badly to teammates.

## How a fix runs

One fix is one PR, one attempt. The steps, in order; a failure at any step ends the
attempt, removes the worktree if one was made, records what happened and pushes nothing.

### 1. Check it may run

Asked of GitHub fresh at this moment, not taken from collected data:

- The PR is open, not a draft, and its author is the signed-in user.
- Its head repository is its base repository (not a fork).
- The repository has a clone named in config (see Config), the path is a git repository,
  and its `origin` points at this repository on `github.host`.
- Attempts are not used up (see Attempts).

### 2. Decide what to fix

- **Merge conflicts** (`mergeable === false`): this attempt resolves the conflicts and
  nothing else. CI runs again on the merged result; anything it then fails is the next
  attempt's job.
- **Otherwise, failing CI**: the failing commit statuses and check runs of the head
  commit.
- CI still running and nothing failing: refuse with "CI is still running".
- Neither: refuse with "nothing to fix".

### 3. Read the failing logs (CI only)

- A failing commit status carries a link to its build. The build id is the last path
  segment of that link when it is all digits.
- The log is read with `teamcity run log <id> --raw --no-color --no-input`. (The tool's
  `--failed` summary was checked against a real style-check failure and gave only "exit
  code -1"; the raw log named the file, line and rule.)
- At most five failing builds are read per attempt, in the order GitHub lists them. The
  rest are named in the prompt as "also failing, log not read".
- Each log is cut to fit: the lines that look like failures (`error`, `fail`,
  `exception`, `[ERR]`, case-insensitive) with two lines either side, plus the last 200
  lines, in their original order, up to 60 KB per build. The exact cutting is the
  builder's to settle.
- A failing check with no readable log (no link, no numeric id, or the tool fails) is
  named in the prompt as "failing, no log". If no log at all could be read, the attempt
  ends: "could not read any failing log".

### 4. Make the worktree

- `git fetch origin <head branch> <base branch>` in the clone.
- The fetched head must be the head commit GitHub reported; otherwise "the branch moved".
- `git worktree add --detach <dir> <head commit>`. Detached, because the owner often has
  the same branch checked out in another worktree and git refuses a second checkout of a
  branch.
- `<dir>` is under `out/fix/work/`, named from the repository and PR number.
- For conflicts: `git merge --no-commit --no-ff origin/<base branch>` in the worktree,
  then the list of conflicted files from `git diff --name-only --diff-filter=U`.

### 5. Run Claude in the worktree

- Working directory: the worktree.
- Tools: read, search and edit files, and nothing else. No shell, no connectors, no web.
  Reads and edits must be confined to the worktree. The CLI's `--restricted` mode says it
  "confines the file tools to the working directories"; use it. **The builder must prove
  this with a real run**: a prompt that tries to read and to edit a file outside the
  worktree is refused both times. If the CLI cannot confine them, stop and come back to
  the owner.
- For conflicts, Claude may also edit files that are not in the conflicted list, when the
  merge needs it. Claude has no way to delete a file, so a conflict that can only be
  settled by deleting one is `cannot`.
- Input: for CI, the failing checks' names and their cut logs; for conflicts, the list of
  conflicted files. Everything in it is data, never instructions, and the prompt says so.
- The prompt's rules: fix the code, not the check. Never delete or skip a test, suppress a
  rule, or change CI configuration. Change as little as the fix needs. If the log shows
  the build machine failed rather than the code, or the fix is not clear from what is
  there, say so and change nothing.
- The answer, as structured output: `outcome` (`fixed` or `cannot`), `summary` (one or
  two plain sentences for the PR's line and the commit message) and, for `cannot`,
  `reason`.
- Limits: `github.fix.maxBudgetUsd`, `github.fix.timeoutMinutes`,
  `github.fix.model`. `enrich.maxBudgetUsd` does not apply to a fix.

### 6. Check, commit, push

- `cannot`, or `fixed` with no changed files: nothing is committed. The attempt is
  recorded as gave up, with the reason.
- For conflicts, any file still conflicted or still holding conflict markers ends the
  attempt.
- The next two checks measure **what Claude changed**: the difference between the
  worktree as it stood just before Claude ran and as it stands after. For a conflict fix
  that is after the merge was started, so the files the base branch brought in do not
  count.
- Any path Claude changed that matches `github.fix.neverTouch` ends the attempt, naming
  the path.
- More than `github.fix.maxFiles` paths changed by Claude ends the attempt.
- Commit everything in the worktree with the clone's own git identity. The message is
  written by the code:
  - CI: `<KEY>: fix <check names>` when the PR's title starts with a ticket key
    (`ABC-123`), otherwise `Fix <check names>`; then a blank line and Claude's summary.
  - Conflicts: `Merge <base branch> into <head branch>`, then the summary.
  - No Claude or co-author line. (The owner's standing rule for commits.)
- **Git hooks are switched off for the commit and the push.** A hook runs programs from
  the worktree (the monolith's hooks run a script from the worktree's own
  `node_modules`), and Claude can write files there, including ignored ones that the
  checks above never see. With hooks on, a file edit could become a program run on the
  laptop. In a fresh worktree those hooks find nothing installed and check nothing
  anyway; CI is the check.
- Only tracked and new, un-ignored files are committed. Ignored files Claude made go
  when the worktree is removed.
- `git push origin HEAD:refs/heads/<head branch>`, never forced. A rejected push ends the
  attempt: "the branch moved".

### 7. Clean up and report

- `git worktree remove --force <dir>` and `git worktree prune`, always. Worktrees left
  under `out/fix/work/` by a run that was killed are removed the same way when the server
  starts and before each fix.
- Record the attempt (see Attempts).
- Collect GitHub again and redraw, so the PR shows its new commit and "CI running".

## Attempts

- Kept in `out/fix/attempts.json`, a list per PR key. Each: when, what it was for (`ci`
  or `conflicts`), the checks named, the head commit it started from, the commit it
  pushed (if any), the outcome (`pushed`, `gave-up`, `failed`), the summary or reason, and
  the cost.
- **The limit.** `github.fix.maxAttempts` (default 2) attempts in a row. "In a row" means
  an unbroken chain ending at the PR's current head: walking back from the latest
  attempt, an attempt counts when the commit it pushed (or, if it pushed nothing, the
  commit it started from) is the commit the chain currently stands on. When the owner
  pushes a commit of their own, the chain is broken and the count starts again.
- **Only an attempt in which Claude ran counts.** A press that is refused at step 1 or 2
  ("CI is still running", "nothing to fix") is not recorded at all. An attempt that ends
  before Claude runs (the log tool is signed out, the branch moved) is recorded, so the
  PR's line can say what happened, but does not count toward the limit.
- At the limit, the button is replaced by "tried twice, over to you" (the number follows
  the config), and a press from the command line is refused with the same words.
- There is no reset button. Pushing a commit of your own resets the count; so does
  deleting the PR's entry from the file.

### A fix's push is not the owner's answer

Today a push by the owner answers a request for changes and the comments before it. A
commit pushed by a fix must not: the owner has answered nothing. When the PR's head is a
commit a fix pushed, the collector takes "when the owner last pushed" from the commit
that fix chain started from (it is in the attempts record) instead of from the head. So
a PR with changes requested stays in "Needs you" after a fix, and comments stay
unanswered.

## The page

In the My PRs panel, on each PR that can be fixed, a **Fix** button in the same style as
**Draft review**, and under the meta line one line about the latest attempt on the
current chain. The "To fix" heading carries **Fix all** when two or more can be fixed.

```
To fix · 3                                              [ Fix all ]

  ABC-101: Add the archive writer                         [ Fix ]
  acme/monolith#501 · +420 −12 · CI ✗

  ABC-102: Tidy the import page                           [ Fix ]
  acme/monolith#502 · +88 −40 · CI ✗
  Fix pushed 10:42: moved the helper above the struct. Waiting on CI.

  ABC-103: Change the report query
  acme/monolith#503 · +15 −3 · CI ✗
  Tried twice, over to you. Last: the integration test needs a database change.
```

- **Can be fixed** means: its reasons include "CI failing" or "merge conflicts", it is not
  a draft, its repository has a clone in config, and attempts are not used up. This is
  worked out when the page is drawn, from collected data, config and the attempts file. A
  PR in "Needs you" that is also failing CI gets the button too.
- **Fix all covers only what is in the open groups** ("Needs you" and "To fix"). A PR
  folded away as old (`hideOlderThanDays`) or ticked off as done is left out, on the page
  and from the command line. It still has its own Fix button where its row is drawn, so
  fixing a long-quiet PR is always a deliberate press.
- While Fix all runs, its button reads **Stop after this one**. Pressing it lets the PR
  in hand finish and skips the rest. A fix in hand is never cut short from the page.
- A PR whose repository has no clone in config shows no button and no hint.
- While a fix runs, the page's status line says which PR and, for Fix all, how far along
  ("fixing acme/monolith#501, 2 of 14"). The activity log shows each step as it happens:
  step names and check names, never log or file contents.
- Like every other button, a press while another job is running answers "busy".

## The server and the command line

- `POST /api/fix` with `{ key }`, where `key` is a PR key (`owner/repo#number`) or `all`.
  It follows the rules of the existing routes: local host only, the page's token, one job
  at a time.
- **Fix all** is one job that runs each fixable PR in the panel's order, one at a time. A
  PR that fails does not stop the rest. GitHub is collected again and the page redrawn
  after each PR, so the page keeps up while the job runs. It ends with a count of pushed,
  gave up, failed and skipped.
- `POST /api/fix/stop` asks a running Fix all to stop after the PR in hand. It is the one
  route that is not refused as "busy" while a job runs.
- `divination fix <key | all>` does the same from a terminal, and prints each step.
- Like `enrich`, these are the only two ways a fix can start.

## Config

Under `github` in `config/defaults.yaml`:

```yaml
  fix:
    # "owner/repo": the absolute path of your local clone. A repository that is not
    # listed gets no Fix button.
    clones: {}
    model: opus
    maxBudgetUsd: 3
    timeoutMinutes: 20
    maxAttempts: 2
    # A fix that changes a path matching one of these is thrown away.
    neverTouch: [".github/**", ".teamcity/**"]
    # A fix that changes more files than this is thrown away.
    maxFiles: 20
```

Wrong shapes are reported by the existing config check. With `clones` empty, the feature
is off: no button, no route behaviour beyond "nothing to fix", no doctor checks.

## Doctor

When `github.fix.clones` is not empty, the GitHub source's checks also cover: each clone
exists, is a git repository and has the right `origin`; `teamcity auth status` succeeds;
and the `claude` tool is signed in. Each failure names its fix, as existing checks do.

## What changes in the code

- `Exec` gains a working-directory option. The Claude runner gains a working directory
  and a per-run budget; today it always uses `enrich.maxBudgetUsd`.
- A new `src/sources/github/fix/` holds the pieces: deciding what to fix, reading and
  cutting logs, the worktree, the Claude run, commit and push, and the attempts record.
  Rules that are pure (what can be fixed, the attempt chain, build id from a link, log
  cutting, commit message) are separate from the code that runs commands.
- `prompts/pr-fix.md` is the prompt.
- The GitHub client gains what the fix asks for fresh: the PR's head and base branch
  names and repositories, and each failing status's link.
- The My PRs panel, the page's script, the server's routes and the command list gain the
  button, its handler, the route and the command.
- README (commands, a "Fixing your own PRs" section, Safety and "When Claude is called"),
  INSTALL.md (the config and what a fix needs) and `config/local.example.yaml`.

## Safety, restated

The README's safety section stops saying the tool is read-only toward GitHub. It says
instead: the tool pushes commits to the head branch of the owner's own PRs, only when
Fix is pressed, never with force, and does nothing else to GitHub. It still posts no
comment, review, reaction or approval, and merges nothing.

Worst-case spend for one press of Fix all is the number of PRs it covers times
`maxBudgetUsd`, and worst-case time is that number times `timeoutMinutes` (16 PRs on the
day this was written: $48, and over five hours if every one ran to its limit). The README
says so, and the Fix all button's tooltip gives the count.

## Testing

- Written test-first, as the rest of the tool is.
- Pure rules: unit tests.
- The run: tests with the fake command runner that assert the exact git, `teamcity` and
  `claude` commands and their order, and that every failure path removes the worktree and
  pushes nothing. In particular: the branch moved before the worktree; the branch moved
  before the push; Claude answered `cannot`; `fixed` with no changes; a `neverTouch` path;
  too many files; conflict markers left; a log that cannot be read. Also: the commit and
  the push are run with hooks off; base-branch files in a merge do not count toward the
  limits; a stop request ends Fix all after the PR in hand.
- The collector: a PR whose head is a fix's commit keeps "changes requested" unanswered.
- Routes, panel and command: as their neighbours are tested.
- Confinement of Claude's file tools to the worktree: proved once with a real run, as
  above, and written down in the plan's results.
- The first real fix is pressed by the owner, on one style-check PR, not by the builder.

## Left to the builder

- File and function names inside `fix/`, and how the log is cut.
- The exact wording of the prompt, the activity lines and the refusals, in the tool's
  existing plain style.
- How the worktree directory is named.
- Whether Fix all re-reads the list between PRs or works from the list at the press.
