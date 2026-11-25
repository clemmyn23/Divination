import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { Config } from "./types.ts";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const TRANSPORTS = ["api", "ics", "inbox"];
const GROUP_KINDS = ["digest", "alerts"];

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Objects merge key by key; arrays and scalars in `over` replace those in `base`. */
function deepMerge(base: unknown, over: unknown): unknown {
  if (!isObject(base) || !isObject(over)) return over;
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(over)) {
    out[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return out;
}

function readConfigFile(path: string, label: string, required: boolean): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      if (required) throw new ConfigError(`${label} is missing`);
      return {};
    }
    throw e;
  }
  let value: unknown;
  try {
    value = parse(text);
  } catch (e) {
    throw new ConfigError(`${label} is not valid YAML: ${(e as Error).message}`);
  }
  if (value === null || value === undefined) return {}; // empty, or only comments
  if (!isObject(value)) throw new ConfigError(`${label} must hold settings, as "name: value" lines`);
  return value;
}

function problemsIn(config: Config): string[] {
  const problems: string[] = [];
  const shown = (v: unknown) => JSON.stringify(v);

  for (const key of ["start", "end"] as const) {
    if (!HHMM.test(String(config.tick?.[key]))) {
      problems.push(`tick.${key} must be HH:MM (got ${shown(config.tick?.[key])})`);
    }
  }

  const hide: unknown = config.hideOlderThanDays;
  if (typeof hide !== "number" || !Number.isFinite(hide) || hide < 0) {
    problems.push(`hideOlderThanDays must be a number of days, 0 or more (got ${shown(hide)})`);
  }

  const inboxStale: unknown = config.inboxStaleAfterMinutes;
  if (typeof inboxStale !== "number" || !Number.isFinite(inboxStale) || inboxStale <= 0) {
    problems.push(`inboxStaleAfterMinutes must be a number of minutes above 0 (got ${shown(inboxStale)})`);
  }

  const reads: Partial<Config["claudeReads"]> = config.claudeReads ?? {};
  if (typeof reads.onRefresh !== "boolean") {
    problems.push(`claudeReads.onRefresh must be true or false (got ${shown(reads.onRefresh)})`);
  }
  const throttle: unknown = reads.throttleMinutes;
  if (typeof throttle !== "number" || !Number.isFinite(throttle) || throttle < 0) {
    problems.push(`claudeReads.throttleMinutes must be a number of minutes, 0 or more (got ${shown(throttle)})`);
  }
  const timeout: unknown = reads.timeoutMinutes;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
    problems.push(`claudeReads.timeoutMinutes must be a number of minutes above 0 (got ${shown(timeout)})`);
  }
  for (const [name, run] of [["slack.sweep", config.slack?.sweep], ["calendar.read", config.calendar?.read]] as const) {
    const tools: unknown = run?.tools;
    if (!Array.isArray(tools) || !tools.every((tool) => typeof tool === "string")) {
      problems.push(`${name}.tools must be a list of tool names (got ${shown(tools)})`);
    }
  }

  for (const id of ["github", "slack", "calendar"] as const) {
    const transport = config[id]?.transport;
    if (!TRANSPORTS.includes(transport)) {
      problems.push(`${id}.transport must be one of ${TRANSPORTS.join(", ")} (got ${shown(transport)})`);
    }
  }

  const crew: unknown = config.github?.crewMembers;
  if (!Array.isArray(crew) || !crew.every((name) => typeof name === "string")) {
    problems.push(`github.crewMembers must be a list of GitHub usernames (got ${shown(crew)})`);
  }

  if (typeof config.slack?.teamId !== "string") {
    problems.push(`slack.teamId must be a string (got ${shown(config.slack?.teamId)})`);
  }

  const muted: unknown = config.slack?.muteAuthors;
  if (!Array.isArray(muted) || !muted.every((name) => typeof name === "string")) {
    problems.push(`slack.muteAuthors must be a list of names (got ${shown(muted)})`);
  }

  const groups: unknown = config.slack?.groups;
  if (!Array.isArray(groups)) {
    problems.push("slack.groups must be a list");
    return problems;
  }
  groups.forEach((group, g) => {
    const at = `slack.groups[${g}]`;
    if (!isObject(group)) {
      problems.push(`${at} must be an object`);
      return;
    }
    if (!GROUP_KINDS.includes(group.kind as string)) {
      problems.push(`${at}.kind must be one of ${GROUP_KINDS.join(", ")} (got ${shown(group.kind)})`);
    }
    if (!Array.isArray(group.conversations)) {
      problems.push(`${at}.conversations must be a list`);
      return;
    }
    group.conversations.forEach((conversation, c) => {
      for (const field of ["id", "name"]) {
        const value = isObject(conversation) ? conversation[field] : undefined;
        if (typeof value !== "string" || value === "") {
          problems.push(`${at}.conversations[${c}] needs a ${field}`);
        }
      }
    });
  });

  return problems;
}

/**
 * Load `config/defaults.yaml` with `config/local.yaml` merged over it.
 * `local.yaml` is optional. Every problem found is listed in one error.
 */
export function loadConfig(root: string): Config {
  const defaults = readConfigFile(join(root, "config", "defaults.yaml"), "config/defaults.yaml", true);
  const local = readConfigFile(join(root, "config", "local.yaml"), "config/local.yaml", false);

  const config = deepMerge(defaults, local) as Config;
  const problems = problemsIn(config);
  if (problems.length > 0) {
    throw new ConfigError(`config problems:\n${problems.map((p) => `- ${p}`).join("\n")}`);
  }
  return config;
}
