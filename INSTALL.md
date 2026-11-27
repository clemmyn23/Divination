# Installing Divination

How to get the dashboard running on your own Mac, from nothing to a page in your browser.
The [README](README.md) says what the dashboard shows and how to use it.

Every command here is run from this folder. The tool's own commands are run as
`pnpm divination <command>`.

## 1. What you need first

- **macOS, Linux or Windows.** The tool is used every day on macOS. On Linux and Windows
  the token store is written and unit-tested but has not yet been run on a real machine,
  and the login item (step 7) is for macOS only.
- **Node 24 or newer.** The tool runs its TypeScript directly, so there is no build step.
  `.nvmrc` names the version, for `nvm use` or `fnm use`.
- **pnpm 10.** `corepack enable` gives you the version this project pins in
  `package.json`; installing pnpm your usual way works too.
- **The `gh` command-line tool**, for the review queue and your own PRs.
- **The `claude` command-line tool**, only if you want Claude to draft reviews, summarise
  threads, or read Slack and the calendar for you. Everything else works without it.

## 2. Install

```bash
pnpm install
```

No lock file is committed, because one can record the address of the registry you
install from. If pnpm writes a `pnpm-lock.yaml`, git ignores it.

## 3. Your config

```bash
cp config/local.example.yaml config/local.yaml
```

- `config/defaults.yaml` holds every setting with its default. It is committed; read it
  to see what can be set, but do not put your own settings there.
- `config/local.yaml` holds yours and is merged over the defaults. It is not committed.

Both are YAML, so comments are welcome. Settings merge key by key; a list in your file
replaces the whole default list. A setting in the wrong shape stops the tool with a
message naming it.

Start with these in `config/local.yaml`:

| Setting | What to put |
|---|---|
| `me.name` | Your first name, for the day's headline |
| `me.email` | Your work email, so the calendar can tell which meetings are optional for you |
| `me.timezone` | Your time zone, such as `Australia/Sydney` |
| `sources` | The panels you want: any of `calendar`, `github`, `slack` |
| `github.host` | Your GitHub host, such as `github.example.com` |

Leave a source out of `sources` and it needs no setup. Later you are most likely to
change `tick`, `claudeReads`, `github.crew`, `github.fix`, `github.mine.ignoreCommenters`,
`github.rank.riskPaths`, `slack.groups`, `slack.muteAuthors` and `hideOlderThanDays`.

## 4. Give each source access

A source gets its data in one of two ways, set by `transport` in its config block: the
tool fetches it itself (`api`, `ics`), or reads a file that a Claude session dropped in
`out/inbox/` (`inbox`).

### Review queue and My PRs (GitHub)

Sign the `gh` tool in to the host you put in `github.host`:

```bash
gh auth login --hostname <your host>
```

That is all it needs. Three optional settings:

- **`github.crew`**: fill this in only if you are in a review crew: the crew's GitHub
  team, its members and its review channel. The rules it switches on are written down in
  [docs/review-rules.md](docs/review-rules.md). Without it the review queue simply lists
  what is waiting on your review.
- **`github.mine.ignoreCommenters`**: GitHub usernames whose comments on your own PRs do
  not count as waiting on your answer, such as a review bot that signs in as a person.
- **`github.fix.clones`**: switches on the **Fix** button for your own PRs that are
  failing CI or have merge conflicts. Name your local clone of each repository you want
  it for:

  ```yaml
  github:
    fix:
      clones:
        "acme/monolith": /Users/you/code/monolith
  ```

  A fix also needs the `teamcity` command-line tool signed in (`teamcity auth login`),
  to read the failing builds' logs, and the `claude` tool signed in. `doctor` checks all
  three once a clone is named. The README's
  [Fixing your own PRs](README.md#fixing-your-own-prs) says what a fix does and does not
  do. This is the one part of the tool that changes anything outside your machine: it
  pushes commits to your own PRs' branches.

### Slack

Set `slack.workspaceUrl`, `slack.userId` and the conversations you follow under
`slack.groups`; `config/local.example.yaml` shows the shape. Set `slack.teamId` to make
Slack links open the Slack app instead of the browser. Then choose one of two ways:

- **By hand** (`transport: inbox`): run `/slack-sweep` in a Claude Code session opened on
  this folder. It reads the conversations in `slack.groups` through the Slack connector,
  on Haiku, and writes plain facts to `out/inbox/slack.json`. The tool's own code then
  decides what needs you. It is only as fresh as your last sweep.
- **Web API** (`transport: api`): create an internal Slack app from
  [docs/slack-app-manifest.json](docs/slack-app-manifest.json), install it, and store its
  user token:

  ```bash
  pnpm divination secret set slack
  ```

  The app has read-only user scopes and no bot. Your workspace may need an admin to
  approve the install.

### Today (calendar)

Choose one of two ways:

- **By hand** (`transport: inbox`): run `/calendar-read` in a Claude Code session opened
  on this folder. It reads today's events through the Google Calendar connector, on
  Haiku, and writes them to `out/inbox/calendar.json`.
- **iCal address** (`transport: ics`): copy your calendar's secret iCal address and store
  it:

  ```bash
  pnpm divination secret set calendar_ics
  ```

  Some workspaces switch this address off.

### Claude (optional)

Sign the `claude` tool in by running `claude`, then `/login`. That is enough for the
sparkle buttons on the page (**Draft review**, **Summarise threads**).

To have **Refresh now** run the Slack sweep and the calendar read for you, instead of
starting them by hand, also set `claudeReads.onRefresh: true`. It applies to sources whose
`transport` is `inbox`, and `claude` must be able to reach the Slack and Google Calendar
connectors. The tools each read may use are listed under `slack.sweep.tools` and
`calendar.read.tools`; keep them to read-only ones. To have the live timer run them as
well, name each source and its interval in minutes under `claudeReads.everyMinutes`
(`slack: 30`, `calendar: 60`). The README's
[When Claude is called](README.md#when-claude-is-called) says what this costs and how it
is limited.

### Where tokens are kept

`secret set <name>` stores a token in your computer's own token store, under the name
`divination`. That store's tool asks for the value in the terminal and hides what you
type, so the token never passes through this program on its way in.

| Platform | Where the token goes | What it needs |
|---|---|---|
| macOS | The Keychain | Nothing extra |
| Linux | The desktop keyring (GNOME Keyring, KWallet) | The `secret-tool` command, from your distribution's libsecret tools package, and a keyring that is running |
| Windows | The Credential Manager | Nothing extra; it uses Windows PowerShell (`powershell.exe`) |

A token can also come from the environment as `DIVINATION_<NAME>`, such as
`DIVINATION_SLACK`; the environment is checked first. Use it where there is no token
store, such as a Linux server or WSL with no keyring. Tokens are read from those two
places and nowhere else; they are never written to config, to `out/`, to logs or into an
error message.

## 5. Check it

```bash
pnpm divination doctor
```

It checks each source in `sources` and, for anything missing, prints the fix. Run it
again until every line has a tick.

## 6. Run it

```bash
pnpm divination serve
```

It prints the address of the page, `http://127.0.0.1:4815` unless you changed
`server.port`. Open it in your browser. `serve` keeps running, and restarts itself when
the code or the config changes, so the page is never drawn by out-of-date code.

To see the page with invented data before any source is set up:

```bash
pnpm divination render --fixtures
```

It prints the path of the sample page, `out/site/fixture.html`; open that file in your
browser. Your real page is left alone.

## 7. Keep it running from login (optional, macOS only)

```bash
pnpm divination schedule install
```

This adds a login item (a launchd agent) that starts `serve` when you log in and keeps it
alive. It only keeps the server running; whether updates are live is still the page's
Start / Pause button.

```bash
pnpm divination schedule status
```

```bash
pnpm divination schedule uninstall
```

## Updating

```bash
git pull
```

```bash
pnpm install
```

A running `serve` notices the new code and restarts itself. If a setting has moved, the
tool stops with a message that names the old setting and its new place.

## If something is wrong

- **Any source:** `pnpm divination doctor` names what is missing and how to fix it.
- **"config problems":** the message lists each setting that is in the wrong shape or has
  moved. Fix it in `config/local.yaml`.
- **The port is taken:** another `serve` is probably running. Stop it, or set
  `server.port` in `config/local.yaml`.
- **"gh is not logged in":** run the `gh auth login` command from step 4 again.
- **A Claude button fails:** open the activity log by clicking the status beside
  **Refresh now**; it says why. A signed-out `claude` tool is the usual cause.
- **A panel says "dozing":** its data is old. Press **Refresh now**, or for a source fed
  by hand run `/slack-sweep` or `/calendar-read` again.

## Working on the code

```bash
pnpm test
```

```bash
pnpm typecheck
```

[docs/adding-a-source.md](docs/adding-a-source.md) explains how to add a panel.
