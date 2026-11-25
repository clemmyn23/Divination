// What the server is doing and what it did: each source's progress during a refresh, and
// a short log of refreshes and Claude calls. It is built from the events the rest of the
// tool already reports through `ctx.log`, so nothing here calls anything or costs anything.
// A listener (the page's open log) hears each line as it is said.

export interface SourceState {
  id: string;
  title: string;
  /** `running` while it is being read; otherwise how the last read went. */
  state: "ok" | "failed" | "running";
  /** When its data was last read successfully. 0 means never. */
  at: number;
  /** How long the last read took. */
  ms?: number;
  error?: string;
  /** Fed by hand through its inbox rather than fetched. */
  byHand?: boolean;
  /** When the read in progress began. */
  startedAt?: number;
  /** The read in progress is Claude's, started by Refresh now. */
  asking?: boolean;
}

export interface ActivityLine {
  /** Goes up with every line, across restarts too, so a page can ask for what it has not seen. */
  id: number;
  at: number;
  level: "info" | "error";
  /** One line, or a line followed by indented detail. */
  text: string;
}

/** What a listener is told: a new line, or more text for the line Claude is still writing. */
export type ActivityUpdate = { type: "line"; line: ActivityLine } | { type: "more"; id: number; text: string };

const MAX_LINES = 300;
/** The most text one line may grow to while Claude writes it. */
const STREAM_MAX = 4000;

type Fields = Record<string, unknown>;

/** `1.2 s`, `42 s`, `0 s`. */
function seconds(ms: unknown): string {
  const s = Number(ms ?? 0) / 1000;
  return `${s >= 10 ? Math.round(s) : Math.round(s * 10) / 10} s`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const indent = (text: string) => text.split("\n").map((line) => `  ${line}`).join("\n");

export function createActivity(now: () => number, initial: SourceState[]) {
  const states = new Map(initial.map((s) => [s.id, { ...s }]));
  const lines: ActivityLine[] = [];
  const listeners = new Set<(update: ActivityUpdate) => void>();
  let nextId = now(); // starts at the clock, so a restarted server's ids are above the last one's
  let growing: ActivityLine | null = null; // the line Claude is still writing, while it is the newest

  const tell = (update: ActivityUpdate) => {
    for (const listener of listeners) listener(update);
  };
  const say = (text: string, level: ActivityLine["level"] = "info"): ActivityLine => {
    const line = { id: nextId++, at: now(), level, text };
    lines.push(line);
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
    growing = null;
    tell({ type: "line", line: { ...line } });
    return line;
  };
  /** As much of `text` as still fits on a line that already holds `used` characters; cut text ends in an ellipsis. */
  const fitting = (text: string, used: number) => {
    const room = STREAM_MAX - used;
    return text.length <= room ? text : room > 0 ? `${text.slice(0, room - 1)}…` : "";
  };
  const titleOf = (id: string) => states.get(id)?.title ?? id;

  return {
    /** Take in one event reported through `ctx.log`. Events it does not know are ignored. */
    record(event: string, fields: object = {}): void {
      const f = fields as Fields;
      switch (event) {
        case "tick-start":
          say(`Refresh started (${f.forced ? "Refresh now" : "timer"})`);
          break;

        case "tick":
          if (f.result === "ran") say(`Refresh finished in ${seconds(f.ms)}`);
          else if (f.result === "outside-hours") say("Refresh skipped: outside working hours");
          else if (f.result === "locked") say("Refresh skipped: another refresh is still running");
          break;

        case "collect-start": {
          const id = String(f.source);
          const state = states.get(id);
          if (state) {
            const { ms: _ms, error: _error, asking: _asking, ...kept } = state;
            states.set(id, { ...kept, state: "running", startedAt: now() });
          }
          say(`${titleOf(id)}: reading…`);
          break;
        }

        case "collect": {
          const id = String(f.source);
          const ok = f.ok === true;
          const error = typeof f.error === "string" ? f.error : undefined;
          const state = states.get(id);
          if (state) {
            const { startedAt: _startedAt, ms: _ms, error: _error, asking: _asking, ...kept } = state;
            states.set(id, {
              ...kept,
              state: ok ? "ok" : "failed",
              at: typeof f.at === "number" ? f.at : state.at,
              ms: Number(f.ms ?? 0),
              ...(error && !ok ? { error } : {}),
            });
          }
          if (ok) say(`${titleOf(id)}: ok in ${seconds(f.ms)}`);
          else say(`${titleOf(id)}: failed in ${seconds(f.ms)}: ${error ?? "unknown error"}`, "error");
          break;
        }

        // Claude reading a source that is otherwise fed by hand, after Refresh now.
        case "feed-start": {
          const id = String(f.source);
          const state = states.get(id);
          if (state) {
            const { ms: _ms, error: _error, ...kept } = state;
            states.set(id, { ...kept, state: "running", startedAt: now(), asking: true });
          }
          say(`${titleOf(id)}: asking Claude to read it…`);
          break;
        }

        case "feed": {
          const id = String(f.source);
          if (f.ok === true) {
            say(`${titleOf(id)}: Claude read it in ${seconds(f.ms)}`); // collecting it comes next and settles its state
            break;
          }
          const error = typeof f.error === "string" ? f.error : "unknown error";
          const state = states.get(id);
          if (state) {
            const { startedAt: _startedAt, asking: _asking, ...kept } = state;
            states.set(id, { ...kept, state: "failed", ms: Number(f.ms ?? 0), error });
          }
          say(`${titleOf(id)}: Claude could not read it (${seconds(f.ms)}): ${error}`, "error");
          break;
        }

        case "feed-skip":
          say(
            `${titleOf(String(f.source))}: Claude was asked less than ${plural(Number(f.throttleMinutes ?? 0), "minute")} ago, so it was not asked again (${seconds(f.waitMs)} to go)`,
          );
          break;

        case "enrich":
          say(`Asked for ${String(f.enricher)} on ${String(f.key)} (${plural(Number(f.items ?? 0), "item")})`);
          break;

        case "llm-start": {
          const tools = Array.isArray(f.tools) && f.tools.length > 0 ? `tools: ${f.tools.join(", ")}` : "no tools";
          say(`Claude (${String(f.model)}) started: ${String(f.prompt)}, ${tools}`);
          break;
        }

        // Claude's words, a few at a time: they grow one line until a tool call, a new
        // passage (`start`) or anything else being logged begins another.
        case "llm-text": {
          const text = typeof f.text === "string" ? f.text : "";
          if (text === "") break;
          if (growing === null || f.start === true) {
            const prefix = "Claude: ";
            growing = say(prefix + fitting(text, prefix.length));
            break;
          }
          const more = fitting(text, growing.text.length);
          if (more === "") break; // the line is full
          growing.text += more;
          tell({ type: "more", id: growing.id, text: more });
          break;
        }

        case "llm-tool": {
          const detail = typeof f.detail === "string" && f.detail !== "" ? `: ${f.detail}` : "";
          say(`Claude is using ${String(f.name)}${detail}`);
          break;
        }

        case "llm": {
          const ok = f.ok === true;
          const parts = [
            `Claude (${String(f.model)}) ${ok ? "finished" : "failed"} in ${seconds(f.ms)}`,
            ...(typeof f.costUsd === "number" ? [`$${f.costUsd.toFixed(2)}`] : []),
            ...(typeof f.turns === "number" ? [plural(f.turns, "turn")] : []),
            ...(Array.isArray(f.denied) && f.denied.length > 0 ? [`refused: ${f.denied.join(", ")}`] : []),
          ];
          const detail = ok ? f.output : f.error;
          say(parts.join(" · ") + (typeof detail === "string" && detail !== "" ? `\n${indent(detail)}` : ""), ok ? "info" : "error");
          break;
        }
      }
    },

    /** Every source's current state, in the order given at the start. */
    sources: (): SourceState[] => [...states.values()].map((s) => ({ ...s })),

    /** The newest lines, oldest first. */
    lines: (limit = MAX_LINES): ActivityLine[] => lines.slice(-limit).map((line) => ({ ...line })),

    /**
     * The lines a page that last saw line `id` is missing: every later one, and the one
     * still being written, which may have grown since.
     */
    linesAfter: (id: number): ActivityLine[] => lines.filter((line) => line.id > id || line === growing).map((line) => ({ ...line })),

    /** Hear every update from now on. Returns a function that stops it. */
    subscribe(listener: (update: ActivityUpdate) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
