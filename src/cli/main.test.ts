import assert from "node:assert/strict";
import { test } from "node:test";
import { main } from "./main.ts";

function capture(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  return { lines, restore: () => { console.log = original; } };
}

test("no command prints usage and returns 1", async () => {
  const out = capture();
  try {
    assert.equal(await main([]), 1);
  } finally {
    out.restore();
  }
  assert.match(out.lines.join("\n"), /Usage: divination <command>/);
});

test("an unknown command names it, prints usage and returns 1", async () => {
  const out = capture();
  try {
    assert.equal(await main(["summon"]), 1);
  } finally {
    out.restore();
  }
  assert.match(out.lines.join("\n"), /Unknown command: summon/);
  assert.match(out.lines.join("\n"), /Usage: divination <command>/);
});
