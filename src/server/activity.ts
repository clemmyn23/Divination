// What the server is doing and what it did: each source's progress during a refresh, and
// a short log of refreshes and Claude calls. It is built from the events the rest of the
// tool already reports through `ctx.log`, so nothing here calls anything or costs anything.

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
}

export interface ActivityLine {
  at: number;
  level: "info" | "error";
  /** One line, or a line followed by indented detail. */
  text: string;
}

const MAX_LINES = 300;

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

  const say = (text: string, level: ActivityLine["level"] = "info") => {
    lines.push({ at: now(), level, text });
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
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
            const { ms: _ms, error: _error, ...kept } = state;
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
            const { startedAt: _startedAt, ms: _ms, error: _error, ...kept } = state;
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

        case "enrich":
          say(`Asked for ${String(f.enricher)} on ${String(f.key)} (${plural(Number(f.items ?? 0), "item")})`);
          break;

        case "llm-start": {
          const tools = Array.isArray(f.tools) && f.tools.length > 0 ? `tools: ${f.tools.join(", ")}` : "no tools";
          say(`Claude (${String(f.model)}) started: ${String(f.prompt)}, ${tools}`);
          break;
        }

        case "llm": {
          const ok = f.ok === true;
          const parts = [
            `Claude (${String(f.model)}) ${ok ? "finished" : "failed"} in ${seconds(f.ms)}`,
            ...(typeof f.costUsd === "number" ? [`$${f.costUsd.toFixed(2)}`] : []),
            ...(typeof f.turns === "number" ? [plural(f.turns, "turn")] : []),
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
    lines: (limit = MAX_LINES): ActivityLine[] => lines.slice(-limit),
  };
}
