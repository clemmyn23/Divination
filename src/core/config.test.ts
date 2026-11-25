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

test("the example config in the repo loads over the defaults", () => {
  const example = JSON.parse(readFileSync(new URL("../../config/local.example.json", import.meta.url), "utf8"));
  const config = loadConfig(tempRoot(example));
  assert.equal(config.me.name, "Sam");
  assert.equal(config.me.timezone, "Australia/Sydney"); // from the defaults
  assert.deepEqual(config.sources, ["calendar", "github", "slack"]);
  assert.equal(config.slack.groups.length, 2);
});
