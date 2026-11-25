import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { captureLog, contextWith, fakeExec } from "../../test/helpers.ts";
import { scheduleCommand } from "../cli/commands/schedule.ts";
import { LABEL, plist } from "./launchd.ts";

test("plist", () => {
  const xml = plist({
    label: "com.divination.serve",
    node: "/n/node",
    script: "/r/bin/divination.ts",
    root: "/r",
    path: "/n:/usr/bin",
    logs: "/r/out/logs & more",
  });
  for (const s of [
    "<string>com.divination.serve</string>",
    "<string>/n/node</string>",
    "<string>/r/bin/divination.ts</string>",
    "<string>serve</string>",
    "<key>KeepAlive</key>",
    "<key>RunAtLoad</key>",
    "<key>WorkingDirectory</key>\n  <string>/r</string>",
    "<key>PATH</key>\n    <string>/n:/usr/bin</string>",
    "/r/out/logs &amp; more/launchd.out.log",
    "/r/out/logs &amp; more/launchd.err.log",
  ]) {
    assert.ok(xml.includes(s), s);
  }
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.equal(LABEL, "com.divination.serve");
});

function setup() {
  const home = mkdtempSync(join(tmpdir(), "divination-home-"));
  const exec = fakeExec({
    "which gh": { stdout: "/opt/homebrew/bin/gh\n" },
    "which claude": { stdout: "/Users/x/.local/bin/claude\n" },
    "launchctl bootout": { code: 3 }, // not loaded yet; must be ignored
    "launchctl bootstrap": { stdout: "" },
    "launchctl print": { code: 113 },
  });
  const ctx = contextWith({}, { exec });
  const file = join(home, "Library", "LaunchAgents", "com.divination.serve.plist");
  return { ctx, exec, file, command: scheduleCommand(() => ctx, { home, uid: 501, node: "/n/bin/node" }) };
}

test("install writes the agent and loads it, replacing any old one", async () => {
  const { ctx, exec, file, command } = setup();
  const out = captureLog();
  try {
    assert.equal(await command.run(["install"]), 0);
  } finally {
    out.restore();
  }
  const xml = readFileSync(file, "utf8");
  assert.ok(xml.includes(`<string>${join(ctx.root, "bin", "divination.ts")}</string>`));
  assert.ok(xml.includes("<string>/n/bin:/opt/homebrew/bin:/Users/x/.local/bin:/usr/bin:/bin</string>"));
  const launchctl = exec.calls.filter((c) => c[0] === "launchctl").map((c) => c.slice(1));
  assert.deepEqual(launchctl, [
    ["bootout", "gui/501/com.divination.serve"],
    ["bootstrap", "gui/501", file],
  ]);
});

test("uninstall unloads the agent and removes its file", async () => {
  const { exec, file, command } = setup();
  const out = captureLog();
  try {
    await command.run(["install"]);
    exec.calls.length = 0;
    assert.equal(await command.run(["uninstall"]), 0);
  } finally {
    out.restore();
  }
  assert.equal(existsSync(file), false);
  assert.deepEqual(exec.calls.map((c) => c.slice(0, 3)), [["launchctl", "bootout", "gui/501/com.divination.serve"]]);
});

test("status says whether the agent is loaded, and usage is shown for anything else", async () => {
  const { command } = setup();
  const out = captureLog();
  try {
    assert.equal(await command.run(["status"]), 0);
    assert.equal(await command.run([]), 1);
    assert.equal(await command.run(["explode"]), 1);
  } finally {
    out.restore();
  }
  assert.ok(out.lines[0]!.includes("not loaded"));
  assert.ok(out.lines.some((l) => l.includes("Usage: divination schedule")));
});
