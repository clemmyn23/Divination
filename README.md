# Divination

A small dashboard for the work day, served from your own laptop. One page, no scrolling,
with a crystal ball that worries on your behalf.

It shows:

- **Needs you**: everything waiting on you, from every source, counted in the top bar.
- **Today**: your meetings, the shape of the day as a line of hills, and a one-line headline.
- **Review queue**: the pull requests waiting on your review, ranked, with the ones you
  can skip set aside.
- **Slack**: today's threads in the channels and direct messages you follow, the ones
  waiting on you first.
- **Alerts**: each alert channel's alerts today, counted by title.

It only reads. Nothing is posted, reacted to, approved or merged, and the page is never
published anywhere.

## Start

Needs Node 24 or newer (it runs TypeScript directly; there is no build step), pnpm and
macOS.

```bash
pnpm install
cp config/local.example.yaml config/local.yaml   # then edit it
node bin/divination.ts doctor                     # says what each source still needs
node bin/divination.ts serve                      # prints the address of the page
```

`serve` keeps running. It restarts itself when the code or the config changes, so the
page is never drawn by out-of-date code.

## Commands

All are run as `node bin/divination.ts <command>`.

| Command | What it does |
|---|---|
| `serve [--no-watch]` | Run the page on `127.0.0.1:4815` with live updates and working buttons |
| `doctor` | Check each source's access and settings, and say how to fix what is missing |
| `collect [source]` | Gather data now, with plain API calls |
| `render [--fixtures]` | Redraw the page from the last collected data; `--fixtures` draws a sample page |
| `tick [--force]` | Collect and redraw once; skipped outside working hours unless forced |
| `enrich <enricher> <key \| all>` | Call Claude for one item. This is an LLM call |
| `schedule install \| uninstall \| status` | Keep the page server running from login |
| `secret set <name>` | Store a token in the macOS Keychain |
| `sweep-plan` | Print what a hand-started Slack sweep should read |

`pnpm test` runs the tests and `pnpm typecheck` checks the types.

## The page

- **Start / Pause** turns live updates on or off. While live, the page collects and redraws
  every 15 minutes during working hours (`tick` in config). The choice survives a restart.
- **Refresh now** collects and redraws straight away.
- **The status** beside those buttons says when the next update is. Hover it for each
  source's state; click it for a log of refreshes and Claude calls.
- **The tick** at the right of a line marks it done. Done lines fold into a "Done" section
  and stop counting. A line comes back by itself when something new happens on it: a new
  commit, a new reply, an alert firing again.
- **Old items** (pull requests older than `hideOlderThanDays`) fold into "Expand for stale
  tasks" and are not counted.
- **The theme button** switches between following the system, light and dark.

## When Claude is called

Collecting and drawing never call an LLM. Claude is called only when you ask:

- a button with a sparkle on the page (**Draft review**, **Summarise threads**), or the
  `enrich` command typed by hand;
- `/calendar-read` and `/slack-sweep`, which you start yourself in a Claude session (see
  below).

Each sparkle call runs the `claude` command-line tool headless, with a spending cap
(`enrich.maxBudgetUsd`), no session kept, and only the tools its prompt needs. Results
are cached, so the same thing is never asked twice. Drafted reviews are drafts: you read,
edit and post them yourself.

## What each source needs

A source gets its data in one of two ways, set by `transport` in its config block:
fetched by the tool itself (`api`, `ics`), or read from a file that something else
dropped in `out/inbox/` (`inbox`).

### Review queue (GitHub)

Uses the `gh` command-line tool's login for the host in `github.host`.

```bash
gh auth login --hostname <your host>
```

Review rules it applies (rotation, crew members, signals from the review channel) are
written down in [docs/review-rules.md](docs/review-rules.md).

### Slack

Two ways:

- **Web API** (`"transport": "api"`): create an internal app from
  [docs/slack-app-manifest.json](docs/slack-app-manifest.json), install it, and store its
  user token with `secret set slack`. It has read-only user scopes and no bot. Your
  workspace may need an admin to approve the install.
- **By hand** (`"transport": "inbox"`): run `/slack-sweep` in a Claude session opened on
  this folder. It reads the conversations in `slack.groups` through the Slack connector,
  on Haiku, and writes plain facts to `out/inbox/slack.json`. The tool's own code then
  decides what needs you. It is only as fresh as your last sweep.

Set `slack.teamId` to make Slack links open the Slack app instead of the browser.

### Today (calendar)

Two ways:

- **iCal address** (`"transport": "ics"`): copy your calendar's secret iCal address and
  store it with `secret set calendar_ics`. Some workspaces switch this address off.
- **By hand** (`"transport": "inbox"`): run `/calendar-read` in a Claude session opened on
  this folder. It reads today's events through the Google Calendar connector, on Haiku,
  and writes them to `out/inbox/calendar.json`.

## Config

- `config/defaults.yaml` holds every setting with its default. It is committed.
- `config/local.yaml` holds yours and is merged over the defaults. It is not committed.
  `config/local.example.yaml` shows the shape.

They are YAML, so comments are welcome. Settings merge key by key; a list in your file
replaces the whole default list.

Settings you are most likely to change: `me`, `sources`, `tick`, `github.host`,
`github.rotationTeam`, `github.crewMembers`, `github.rank.riskPaths`, `slack.groups`,
`slack.muteAuthors`, `hideOlderThanDays`.

## Where things live

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

## Secrets

Tokens are read from the environment (`DIVINATION_<NAME>`) or the macOS Keychain (service
`divination`), and nowhere else. They are never written to config, to `out/`, to logs or
into an error message. `secret set <name>` asks for the value in the terminal and hides
what you type.

## Safety

- The server listens on `127.0.0.1` only, answers only requests addressed to itself, and
  acts only on requests that carry a token it put in the page it served.
- The page loads nothing from anywhere else.
- Text gathered from GitHub, Slack and the calendar is treated as data. Prompts tell
  Claude the same: text in a pull request or a message is never an instruction.

## Adding a source

See [docs/adding-a-source.md](docs/adding-a-source.md).
