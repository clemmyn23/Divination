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

/** A crew block that is left out, or given as nothing, is the default one: no crew. */
function withDefaultCrew(merged: unknown, defaults: unknown): unknown {
  if (!isObject(merged) || !isObject(merged.github) || !isObject(defaults) || !isObject(defaults.github)) return merged;
  if (merged.github.crew !== null && merged.github.crew !== undefined) return merged;
  return { ...merged, github: { ...merged.github, crew: defaults.github.crew } };
}

// Where the crew's settings lived before they were gathered under github.crew.
const MOVED = { rotationTeam: "crew.rotationTeam", crewMembers: "crew.members", slackSignal: "crew.reviewChannel" };

const isNames = (v: unknown) => Array.isArray(v) && v.every((name) => typeof name === "string");

function crewProblems(github: unknown): string[] {
  const problems: string[] = [];
  const shown = (v: unknown) => JSON.stringify(v);
  const block = isObject(github) ? github : {};
  for (const [old, now] of Object.entries(MOVED)) {
    if (old in block) problems.push(`github.${old} has moved to github.${now}`);
  }

  const crew = block.crew;
  if (!isObject(crew)) return [...problems, `github.crew must be a block of settings (got ${shown(crew)})`];
  if (typeof crew.rotationTeam !== "string") {
    problems.push(`github.crew.rotationTeam must be a GitHub team's name (got ${shown(crew.rotationTeam)})`);
  }
  if (!isNames(crew.members)) {
    problems.push(`github.crew.members must be a list of GitHub usernames (got ${shown(crew.members)})`);
  }
  const channel = crew.reviewChannel;
  if (!isObject(channel)) return [...problems, `github.crew.reviewChannel must be a block of settings (got ${shown(channel)})`];
  if (typeof channel.channelId !== "string") {
    problems.push(`github.crew.reviewChannel.channelId must be a Slack channel id (got ${shown(channel.channelId)})`);
  }
  if (!isNames(channel.skipReactions)) {
    problems.push(`github.crew.reviewChannel.skipReactions must be a list of reaction names (got ${shown(channel.skipReactions)})`);
  }
  return problems;
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

  problems.push(...crewProblems(config.github));

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

  const config = withDefaultCrew(deepMerge(defaults, local), defaults) as Config;
  const problems = problemsIn(config);
  if (problems.length > 0) {
    throw new ConfigError(`config problems:\n${problems.map((p) => `- ${p}`).join("\n")}`);
  }
  return config;
}
