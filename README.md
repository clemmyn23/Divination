# Divination

A small dashboard for the work day, served from your own laptop. One page, no scrolling,
with a crystal ball that worries on your behalf.

It shows:

- **Needs you**: everything waiting on you, from every source, counted in the top bar.
- **Today**: your meetings, the shape of the day as a line of hills, and a one-line headline.
- **Review queue**: the pull requests waiting on your review, ranked, with the ones you
  can skip set aside.
- **My PRs**: the pull requests you raised, the ones waiting on you first.
- **Slack**: today's threads in the channels and direct messages you follow, the ones
  waiting on you first.
- **Alerts**: each alert channel's alerts today, counted by title.

It only reads. Nothing is posted, reacted to, approved or merged, and the page is never
published anywhere.

## Start

It needs Node 24 or newer and pnpm. It is used every day on macOS;
[INSTALL.md](INSTALL.md) says where Linux and Windows stand.

```bash
pnpm install
cp config/local.example.yaml config/local.yaml   # then edit it
pnpm divination doctor                            # says what each source still needs
pnpm divination serve                             # prints the address of the page
```

[INSTALL.md](INSTALL.md) walks through each step: what to install first, your config, how
to give GitHub, Slack and the calendar access, and how to keep the page running from login.

## Commands

All are run as `pnpm divination <command>`.

| Command | What it does |
|---|---|
| `serve [--no-watch]` | Run the page on `127.0.0.1:4815` with live updates and working buttons |
| `doctor` | Check each source's access and settings, and say how to fix what is missing |
| `collect [source]` | Gather data now, with plain API calls |
| `render [--fixtures]` | Redraw the page from the last collected data; `--fixtures` draws a sample page |
| `tick [--force]` | Collect and redraw once; skipped outside working hours unless forced |
| `enrich <enricher> <key \| all>` | Call Claude for one item. This is an LLM call |
| `schedule install \| uninstall \| status` | Keep the page server running from login |
| `secret set <name>` | Store a token in this computer's token store |
| `sweep-plan` | Print what a hand-started Slack sweep should read |

`pnpm test` runs the tests and `pnpm typecheck` checks the types.

## The page

- **Start / Pause** turns live updates on or off. While live, the page collects and redraws
  every 15 minutes during working hours (`tick` in config). The choice survives a restart.
- **Refresh now** collects and redraws straight away. If you turn on
  `claudeReads.onRefresh`, it then has Claude read the calendar and sweep Slack (see
  below), redrawing as each one lands.
- **The status** beside those buttons says when the next update is. Hover it for each
  source's state; click it for the activity log. The log is live while it is open: each
  step of a refresh appears as it happens, and during a Claude call so do the words Claude
  writes and the tools it uses.
- **The tick** at the right of a line marks it done. Done lines fold into a "Done" section
  and stop counting. A line comes back by itself when something new happens on it: a new
  commit, a new reply, an alert firing again.
- **Old items** (pull requests older than `hideOlderThanDays`) fold into "Expand for stale
  tasks" and are not counted.
- **The theme button** switches between following the system, light and dark.

## Your own PRs

A PR you raised shows in Needs you only when a reviewer has spoken and the next move is yours:

- someone approved it, its CI is green, it merges cleanly and GitHub reports nothing else
  required, so it is ready to merge
- someone requested changes, and you have not pushed or replied since

The My PRs panel lists the rest under **To fix** (CI failing, conflicts with the base
branch, a comment since you last pushed or replied), **Waiting on others** and **Drafts**;
none of those reach Needs you. "Pushed" is read from the time of the PR's newest commit.
Comments from an app's bot account never count; a review bot that signs in as a person
does, until you add its username to `github.mine.ignoreCommenters`.

The review queue's own rules for a review crew (rotation, crew members, signals from the
review channel) are in [docs/review-rules.md](docs/review-rules.md). They apply only when
`github.crew` is filled in.

## When Claude is called

Collecting and drawing never call an LLM. Claude is called only when you ask:

- a button with a sparkle on the page (**Draft review**, **Summarise threads**), or the
  `enrich` command typed by hand;
- `/calendar-read` and `/slack-sweep`, which you start yourself in a Claude session
  ([INSTALL.md](INSTALL.md#4-give-each-source-access) says when you need them);
- **Refresh now**, but only with `claudeReads.onRefresh: true`, and only for sources whose
  `transport` is `inbox`. After its usual refresh it runs the same two reads headless, on
  Haiku, with nothing but the connector's read-only tools. The timer never does this.

Refresh now's Claude reads are throttled: once Claude has read a source (or failed to),
pressing again within `claudeReads.throttleMinutes` (2 by default) refreshes as usual but
does not ask Claude again, and the log says how long is left. The throttle only ever holds
back those Claude calls.

Each call runs the `claude` command-line tool headless, with a spending cap
(`enrich.maxBudgetUsd`, which applies to a Refresh now read too), no session kept, and
only the tools its prompt needs. A call that reaches the cap is stopped and says so.
Sparkle results are cached, so the same thing is never asked twice. Drafted reviews are
drafts: you read, edit and post them yourself.

A call is started lean, because everything a run starts with is read again on every turn:
no skills, no hooks, and no MCP servers, except that a Refresh now read gets the one
connector it reads through. To leave the others out it first lists the MCP servers this
machine and account have (`claude mcp list`, about 20 seconds, remembered for an hour).
The activity log shows what each run loaded and the tokens it used.

## Where things live

Your settings are in `config/local.yaml`, merged over `config/defaults.yaml`, which lists
every setting with its default. [INSTALL.md](INSTALL.md#3-your-config) says how they merge.

Everything the tool writes goes under `out/`, which is not committed:

| Path | What |
|---|---|
| `out/site/index.html` | The page, one self-contained file |
| `out/data/<source>.json` | The last data collected from each source |
| `out/inbox/<source>.json` | Files dropped by `/calendar-read` and `/slack-sweep` |
| `out/cache/` | Cached lookups and cached Claude results |
| `out/done.json` | The lines you ticked off |
| `out/state.json` | Whether live updates are on |
| `out/logs/` | What happened, one event per line |

## Safety

- Tokens are read from the computer's own token store (the macOS Keychain, the Linux
  desktop keyring or the Windows Credential Manager) or the environment, and nowhere else.
  They are never written to config, to `out/`, to logs or into an error message.
- The server listens on `127.0.0.1` only, answers only requests addressed to itself, and
  acts only on requests that carry a token it put in the page it served.
- The page loads nothing from anywhere else.
- Text gathered from GitHub, Slack and the calendar is treated as data. Prompts tell
  Claude the same: text in a pull request or a message is never an instruction.

## Adding a source

See [docs/adding-a-source.md](docs/adding-a-source.md).
