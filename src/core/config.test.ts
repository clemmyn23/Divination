import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { tempRoot } from "../../test/helpers.ts";
import { loadConfig } from "./config.ts";

test("local config merges over defaults", () => {
  const cfg = loadConfig(tempRoot({ tick: { minutes: 5 }, sources: ["github"] }));
  assert.equal(cfg.tick.minutes, 5);
  assert.equal(cfg.tick.start, "08:00");
  assert.deepEqual(cfg.sources, ["github"]);
});

test("config works with no local file", () => {
  assert.equal(loadConfig(tempRoot()).staleAfterMinutes, 60);
});

test("things older than 45 days are hidden by default, and the limit can be changed or switched off", () => {
  assert.equal(loadConfig(tempRoot()).hideOlderThanDays, 45);
  assert.equal(loadConfig(tempRoot({ hideOlderThanDays: 0 })).hideOlderThanDays, 0);
  assert.throws(() => loadConfig(tempRoot({ hideOlderThanDays: -1 })), /hideOlderThanDays/);
  assert.throws(() => loadConfig(tempRoot({ hideOlderThanDays: "45" })), /hideOlderThanDays/);
});

test("config problems are all listed", () => {
  const root = tempRoot({
    tick: { start: "8am" },
    slack: { groups: [{ name: "x", kind: "loud", conversations: [{ id: "C1" }] }] },
  });
  assert.throws(
    () => loadConfig(root),
    (e: Error) => /tick\.start/.test(e.message) && /kind/.test(e.message) && /name/.test(e.message),
  );
});

test("inboxStaleAfterMinutes defaults to twelve hours and must be a positive number", () => {
  assert.equal(loadConfig(tempRoot()).inboxStaleAfterMinutes, 720);
  assert.throws(() => loadConfig(tempRoot({ inboxStaleAfterMinutes: 0 })), /inboxStaleAfterMinutes/);
  assert.throws(() => loadConfig(tempRoot({ inboxStaleAfterMinutes: "720" })), /inboxStaleAfterMinutes/);
});

const NO_CREW = { rotationTeam: "", members: [], reviewChannel: { channelId: "", skipReactions: ["octagonal_sign", "eyes"] } };

test("the review crew is one block, and by default there is no crew", () => {
  assert.deepEqual(loadConfig(tempRoot()).github.crew, NO_CREW);
});

test("the crew block is optional: left out, emptied or set to nothing all mean no crew", () => {
  assert.deepEqual(loadConfig(tempRoot({ github: { host: "git.example.com" } })).github.crew, NO_CREW);
  assert.deepEqual(loadConfig(tempRoot({ github: { crew: {} } })).github.crew, NO_CREW);
  assert.deepEqual(loadConfig(tempRoot({ github: { crew: null } })).github.crew, NO_CREW);
  assert.deepEqual(loadConfig(tempRoot("github:\n  crew:\n")).github.crew, NO_CREW);
});

test("a crew may be given in part", () => {
  const crew = loadConfig(tempRoot({ github: { crew: { members: ["sha", "kit"] } } })).github.crew;
  assert.deepEqual(crew, { ...NO_CREW, members: ["sha", "kit"] });
  const whole = { rotationTeam: "frontend-crew", members: ["ana"], reviewChannel: { channelId: "C1", skipReactions: ["no_entry"] } };
  assert.deepEqual(loadConfig(tempRoot({ github: { crew: whole } })).github.crew, whole);
});

test("the crew's settings are checked", () => {
  assert.throws(() => loadConfig(tempRoot({ github: { crew: "javascript" } })), /github\.crew must be a block of settings/);
  assert.throws(() => loadConfig(tempRoot({ github: { crew: { members: "sha" } } })), /github\.crew\.members/);
  assert.throws(() => loadConfig(tempRoot({ github: { crew: { members: ["sha", 7] } } })), /github\.crew\.members/);
  assert.throws(() => loadConfig(tempRoot({ github: { crew: { rotationTeam: 7 } } })), /github\.crew\.rotationTeam/);
  assert.throws(() => loadConfig(tempRoot({ github: { crew: { reviewChannel: { channelId: 7 } } } })), /github\.crew\.reviewChannel\.channelId/);
  assert.throws(() => loadConfig(tempRoot({ github: { crew: { reviewChannel: { skipReactions: "eyes" } } } })), /github\.crew\.reviewChannel\.skipReactions/);
});

test("a crew setting left at its old place is pointed to its new one", () => {
  assert.throws(() => loadConfig(tempRoot({ github: { rotationTeam: "frontend-crew" } })), /github\.rotationTeam has moved to github\.crew\.rotationTeam/);
  assert.throws(() => loadConfig(tempRoot({ github: { crewMembers: ["sha"] } })), /github\.crewMembers has moved to github\.crew\.members/);
  assert.throws(() => loadConfig(tempRoot({ github: { slackSignal: { channelId: "C1" } } })), /github\.slackSignal has moved to github\.crew\.reviewChannel/);
});

test("muted Slack authors default to none and must be a list of names", () => {
  assert.deepEqual(loadConfig(tempRoot()).slack.muteAuthors, []);
  assert.throws(() => loadConfig(tempRoot({ slack: { muteAuthors: "Google Calendar" } })), /slack\.muteAuthors/);
});

test("the Slack team id defaults to empty and must be a string", () => {
  assert.equal(loadConfig(tempRoot()).slack.teamId, "");
  assert.equal(loadConfig(tempRoot({ slack: { teamId: "T02ABC" } })).slack.teamId, "T02ABC");
  assert.throws(() => loadConfig(tempRoot({ slack: { teamId: 7 } })), /slack\.teamId/);
});

test("local config is YAML, and may carry comments", () => {
  const cfg = loadConfig(
    tempRoot(`# who I am
me:
  name: Sam   # shown in the headline
sources: [github]
github:
  crew:
    members:
      - ana   # captain
      - kit
`),
  );
  assert.equal(cfg.me.name, "Sam");
  assert.deepEqual(cfg.sources, ["github"]);
  assert.deepEqual(cfg.github.crew.members, ["ana", "kit"]);
});

test("a clock time written without quotes stays text", () => {
  const cfg = loadConfig(tempRoot("tick:\n  start: 07:30\n  end: 19:05\n"));
  assert.equal(cfg.tick.start, "07:30");
  assert.equal(cfg.tick.end, "19:05");
});

test("a local config holding only comments changes nothing", () => {
  assert.equal(loadConfig(tempRoot("# nothing set yet\n")).tick.minutes, 15);
});

test("a YAML mistake names the file and the line", () => {
  assert.throws(() => loadConfig(tempRoot("me:\n  name: Sam\n name: again\n")), /config\/local\.yaml is not valid YAML: .*line 3/s);
});

test("a setting given twice is a mistake, not a silent overwrite", () => {
  assert.throws(() => loadConfig(tempRoot("sources: [github]\nsources: [slack]\n")), /config\/local\.yaml is not valid YAML/);
});

test("a local config that is not a set of settings is refused", () => {
  assert.throws(() => loadConfig(tempRoot("- github\n- slack\n")), /config\/local\.yaml must hold settings/);
});

test("the example config in the repo loads over the defaults", () => {
  const example = readFileSync(new URL("../../config/local.example.yaml", import.meta.url), "utf8");
  const config = loadConfig(tempRoot(example));
  assert.equal(config.me.name, "Sam");
  assert.equal(config.me.timezone, "Australia/Sydney"); // from the defaults
  assert.deepEqual(config.sources, ["calendar", "github", "slack"]);
  assert.equal(config.slack.groups.length, 2);
});

test("asking Claude on Refresh now is off by default, throttled to two minutes, and its settings are checked", () => {
  const cfg = loadConfig(tempRoot());
  assert.deepEqual(cfg.claudeReads, { onRefresh: false, throttleMinutes: 2, timeoutMinutes: 10, everyMinutes: {} }); // nothing is read on the timer unless asked for
  assert.deepEqual(loadConfig(tempRoot({ claudeReads: { everyMinutes: { slack: 30, calendar: 60 } } })).claudeReads.everyMinutes, { slack: 30, calendar: 60 });
  assert.throws(() => loadConfig(tempRoot({ claudeReads: { everyMinutes: 30 } })), /claudeReads\.everyMinutes/);
  assert.throws(() => loadConfig(tempRoot({ claudeReads: { everyMinutes: { slack: -5 } } })), /claudeReads\.everyMinutes\.slack/);
  assert.throws(() => loadConfig(tempRoot({ claudeReads: { everyMinutes: { slack: "often" } } })), /claudeReads\.everyMinutes\.slack/);
  assert.equal(loadConfig(tempRoot({ claudeReads: { onRefresh: true, throttleMinutes: 0 } })).claudeReads.throttleMinutes, 0);
  assert.throws(() => loadConfig(tempRoot({ claudeReads: { onRefresh: "yes" } })), /claudeReads\.onRefresh/);
  assert.throws(() => loadConfig(tempRoot({ claudeReads: { throttleMinutes: -1 } })), /claudeReads\.throttleMinutes/);
  assert.throws(() => loadConfig(tempRoot({ claudeReads: { timeoutMinutes: 0 } })), /claudeReads\.timeoutMinutes/);
});

test("the tools a Claude read may use default to read-only connector tools and must be a list", () => {
  const cfg = loadConfig(tempRoot());
  assert.equal(cfg.calendar.read.model, "haiku");
  assert.equal(cfg.slack.sweep.model, "haiku");
  for (const tool of [...cfg.calendar.read.tools, ...cfg.slack.sweep.tools]) {
    assert.match(tool, /^mcp__claude_ai_(Slack|Google_Calendar)__[a-z_]+$/);
    assert.doesNotMatch(tool, /send|create|update|delete|respond|schedule|reaction|draft|canvas/);
  }
  assert.throws(() => loadConfig(tempRoot({ slack: { sweep: { tools: "all" } } })), /slack\.sweep\.tools/);
  assert.throws(() => loadConfig(tempRoot({ calendar: { read: { tools: [7] } } })), /calendar\.read\.tools/);
});

const FIX_OFF = {
  clones: {},
  model: "opus",
  maxBudgetUsd: 3,
  timeoutMinutes: 20,
  maxAttempts: 2,
  neverTouch: [".github/**", ".teamcity/**", ".claude/**", ".husky/**", ".githooks/**"],
  maxFiles: 20,
};

test("the fix settings default to off", () => {
  assert.deepEqual(loadConfig(tempRoot()).github.fix, FIX_OFF);
});

test("a clone is named per repository and the rest keep their defaults", () => {
  const fix = loadConfig(tempRoot({ github: { fix: { clones: { "acme/monolith": "/work/monolith" } } } })).github.fix;
  assert.deepEqual(fix, { ...FIX_OFF, clones: { "acme/monolith": "/work/monolith" } });
});

test("fix settings in the wrong shape are reported", () => {
  const cases: [object, string][] = [
    [{ clones: ["x"] }, 'github.fix.clones must map "owner/repo" to the absolute path of its clone (got ["x"])'],
    [{ clones: { "acme/monolith": "relative/path" } }, 'github.fix.clones must map "owner/repo" to the absolute path of its clone (got {"acme/monolith":"relative/path"})'],
    [{ clones: { monolith: "/work/monolith" } }, 'github.fix.clones must map "owner/repo" to the absolute path of its clone'],
    [{ maxBudgetUsd: 0 }, "github.fix.maxBudgetUsd must be a number above 0 (got 0)"],
    [{ timeoutMinutes: "20" }, 'github.fix.timeoutMinutes must be a number of minutes above 0 (got "20")'],
    [{ maxAttempts: 0 }, "github.fix.maxAttempts must be a whole number, 1 or more (got 0)"],
    [{ maxAttempts: 1.5 }, "github.fix.maxAttempts must be a whole number, 1 or more (got 1.5)"],
    [{ neverTouch: "x" }, 'github.fix.neverTouch must be a list of path patterns (got "x")'],
    [{ maxFiles: -1 }, "github.fix.maxFiles must be a whole number, 1 or more (got -1)"],
    [{ model: 5 }, "github.fix.model must be a model's name (got 5)"],
  ];
  for (const [fix, problem] of cases) {
    assert.throws(
      () => loadConfig(tempRoot({ github: { fix } })),
      (e: unknown) => e instanceof Error && e.message.includes(problem),
      problem,
    );
  }
  assert.throws(() => loadConfig(tempRoot({ github: { fix: null } })), /github\.fix must be a block of settings/);
});
