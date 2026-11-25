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

test("crew members default to none and must be a list of GitHub usernames", () => {
  assert.deepEqual(loadConfig(tempRoot()).github.crewMembers, []);
  assert.deepEqual(loadConfig(tempRoot({ github: { crewMembers: ["sha", "kit"] } })).github.crewMembers, ["sha", "kit"]);
  assert.throws(() => loadConfig(tempRoot({ github: { crewMembers: "sha" } })), /github\.crewMembers/);
  assert.throws(() => loadConfig(tempRoot({ github: { crewMembers: ["sha", 7] } })), /github\.crewMembers/);
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
  crewMembers:
    - ana   # captain
    - kit
`),
  );
  assert.equal(cfg.me.name, "Sam");
  assert.deepEqual(cfg.sources, ["github"]);
  assert.deepEqual(cfg.github.crewMembers, ["ana", "kit"]);
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
