import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError } from "../core/config.ts";
import { main } from "./main.ts";

function capture(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  return { lines, restore: () => { console.log = original; } };
}

test("a config error is printed and returns 1 instead of crashing", async () => {
  const out = capture();
  const table = {
    broken: {
      summary: "always fails",
      run: async (): Promise<number> => {
        throw new ConfigError("config problems:\n- tick.start must be HH:MM");
      },
    },
  };
  try {
    assert.equal(await main(["broken"], table), 1);
  } finally {
    out.restore();
  }
  assert.match(out.lines.join("\n"), /tick\.start must be HH:MM/);
});

test("other errors are not swallowed", async () => {
  const table = { broken: { summary: "", run: async (): Promise<number> => { throw new Error("real bug"); } } };
  await assert.rejects(main(["broken"], table), /real bug/);
});

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
