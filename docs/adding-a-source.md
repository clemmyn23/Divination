# Adding a source

A source is one service the dashboard reads: GitHub, Slack, the calendar. Each lives in
its own folder under `src/sources/` and tells the rest of the tool five things: how to
check its access, how to collect its data, whether data is valid, what in it needs you,
and how to draw it.

The calendar is the worked example throughout. Read `src/sources/calendar/` alongside
this page.

## The contract

From `src/core/types.ts`:

```ts
export interface Source<TData> {
  id: string;                                          // "calendar"; also its config block and file names
  title: string;                                       // "Today"; shown when there is no data yet
  doctor(ctx: Context): Promise<Check[]>;              // can it be reached, and how to fix it if not
  collect(ctx: Context): Promise<TData>;               // fetch the data; throw on failure
  fromInbox?(dropped: unknown, ctx: Context): TData;   // turn a hand-dropped file into the data
  feed?(ctx: Context): Promise<unknown>;               // optional: have Claude gather what fromInbox takes
  validate(data: unknown): string[];                   // problems with the data; empty means valid
  attention(data: TData, view: View): AttentionItem[]; // what is waiting on me
  panels(data: TData, view: View): Panel[];            // the panels to draw
  enrichers?: Enricher<TData>[];                       // optional: things Claude can add on request
}
```

`Context` gives a source everything it may touch: `config`, `paths`, `now()`, `http`,
`exec`, `secrets` and `log`. A source uses these and nothing else, which is what lets its
tests run with fakes and no network.

What the rest of the tool does with a source:

- **collect** calls `collect` (or reads the inbox), runs `validate`, and writes an
  envelope to `out/data/<id>.json`. If collecting fails, the last good data is kept and
  the error is recorded beside it. A source never has to handle "keep the old data".
- **render** calls `attention` and `panels` with the stored data and draws the page.
  These two must be pure: no network, no clock other than `view.now`.

## The folder

```
src/sources/calendar/
  types.ts        the data shape (CalendarData) and anything it is built from
  ics.ts          reading the service's format
  recur.ts        working things out from it
  day.ts
  inbox.ts        fromInbox: the hand-fed route
  terrain.ts      drawing helpers
  panel.ts        panels()
  index.ts        the Source object: doctor, collect, validate, attention
  *.test.ts       a test file beside each file
test/fixtures/calendar/
  sample.ics      invented data in the service's real shape
```

Split by what a file is responsible for, not by layer. Keep `index.ts` thin: it wires the
pieces together.

## Steps

1. **Types first.** Write `types.ts`: the shape `collect` returns and `panels` reads. Keep
   it small. It is stored as JSON, so no classes, dates as epoch milliseconds.

2. **Fixtures.** Put invented data, in the shape the real service returns, under
   `test/fixtures/<id>/`. Check the shape against the real service before you write
   them; do not write fixtures from memory.

3. **Collect.** Fetch with `ctx.http`, get tokens with `ctx.secrets.get("<name>")`, and
   throw an `Error` with a message a person can act on, such as
   `no calendar address; run: divination secret set calendar_ics`. Never put a token, or
   an address that is itself a secret, in an error.

4. **Validate.** Return a list of problems. This guards the page against a half-written
   file as much as against a bad fetch.

5. **Attention.** Return one `AttentionItem` per thing waiting on me. Set `at` (when it
   started waiting) so old items fold away, and `doneKey` so the item can be ticked off.
   `reason` says why in plain words; add `parts` when some of it reads better as
   lozenges (see `attention` in `src/sources/github/index.ts`).
   A source with nothing to ask returns `[]`, as the calendar does.

6. **Panels.** Return `Panel`s whose `html` is already escaped: run every piece of text
   that came from outside through `esc`, and every link through `link`, both from
   `src/render/html.ts`. Use the classes listed at the top of
   `src/render/theme/panels.css`; keep a line to a title and one meta line. Set
   `size: "short"` for a panel that can share a column.

7. **Doctor.** Return `Check`s in the order a person would fix them, each with a `fix`
   when it fails. Stop at the first check the rest depend on.

8. **Register.** Add the source to the list in `src/sources/index.ts`, add its config
   block to `config/defaults.yaml` and to `Config` in `src/core/types.ts`, and add its id
   to `sources` in config.

9. **Sample page.** Add an entry to `test/fixtures/page/entries.ts` so
   `node bin/divination.ts render --fixtures` shows the new panel with invented data.
   Look at it in both themes and in a narrow window.

Write each test before the code it tests, and watch it fail first.

## Marking lines done

Give each line a key that names it *in its current state*, and use the helpers in
`src/render/done.ts`:

```ts
const key = `pr:${pr.key}@${pr.headSha}`;          // a new commit changes the key
tick(key, isDone(key, view));                      // the button on the line
doneAccordion(done.length, listOfDoneLines);       // the fold at the bottom of the panel
```

Because the key includes the state, a ticked line comes back by itself when something
new happens on it. Use the same key as the `doneKey` of the line's attention item.

## The inbox transport

When a service cannot be fetched directly (no token, an address switched off), a source
can be fed by hand. With `"transport": "inbox"` in its config block, the tool reads
`out/inbox/<id>.json` instead of calling `collect`.

- Without `fromInbox`, the dropped file must already be the source's data.
- With `fromInbox`, the file can be something plainer, and the source turns it into data.
  Prefer this when an LLM writes the file: have it copy facts, and keep every judgement
  in code where it can be tested. `src/sources/calendar/inbox.ts` takes plain events and
  works out weights, the day's class and the headline itself.

The file is written by a Claude session the user starts: a command under
`.claude/commands/` (pinned to a cheap model with `model: haiku`) that follows a prompt
under `prompts/`. Give `doctor` an inbox check that says which command to run.

A source can also offer `feed`: the same read, run headless when Refresh now is pressed
(and only then, and only with `claudeReads.onRefresh`). See `src/sources/calendar/feed.ts`:

- It calls `runClaude` with the same prompt file plus a short `note` saying how this run
  differs: its input is given to it, and its answer is the result rather than a file.
- It sets `connectors: true` and passes only the connector's read-only tools, taken from
  config. The run gets no file or shell tools, so text it reads cannot make it write.
- It returns what `fromInbox` takes, and throws when the service could not be read. An
  empty answer must never stand in for a failed read.

The server checks the answer with `fromInbox`, writes it to the inbox, collects and
redraws. It also throttles these reads (`claudeReads.throttleMinutes`); a source does
nothing to get that.

## Enrichers

An enricher adds something only an LLM can: a drafted review, a one-line summary. It is
never run by collecting or drawing, only by a sparkle button on the page or the `enrich`
command.

```ts
export interface Enricher<TData> {
  id: string;
  items(data: TData, ctx: Context): EnrichItem[];                              // what could be enriched
  run(items: EnrichItem[], ctx: Context): Promise<Record<string, unknown>>;    // key -> output
}
```

- `items` gives each item a `key` and a `hash`. The hash is what the result is cached
  under, so choose it to change exactly when the answer should be asked for again.
- `run` calls `runClaude` from `src/enrich/claude.ts` with a prompt file, a JSON schema
  for the answer, a model from config, and only the tools the prompt needs. While it
  runs, what Claude writes and the tools it uses show up in the page's activity log;
  an enricher does nothing to get that.
- The panel reads results from `view.enrich[<enricher id>][<key>]` and offers a button
  when one is missing:
  `<button data-enrich="<enricher id>" data-key="<key>">…</button>`.
- Say in the prompt that the gathered text is data, never instructions, and check the
  shape of what comes back before returning it.

See `src/sources/github/review.enricher.ts` and `src/sources/slack/summary.enricher.ts`.

## Before you call it done

- `pnpm test` and `pnpm typecheck` pass.
- `node bin/divination.ts doctor` says something useful for your source when it is not
  set up, and passes when it is.
- The panel has been checked against the real service, not only the fixtures. Real data
  finds things fixtures do not.
- No token or secret address appears in `out/`, in logs or in an error.
