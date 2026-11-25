// app.js is browser code that is inlined into the page. These tests run it in a
// sandbox with just enough of a page around it to press its buttons.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const source = readFileSync(fileURLToPath(new URL("./app.js", import.meta.url)), "utf8");

class FakeElement {
  id: string;
  textContent: string;
  dataset: Record<string, string> = {};
  constructor(id: string, textContent = "") {
    this.id = id;
    this.textContent = textContent;
  }
  closest(selector: string): FakeElement | null {
    if (selector === `#${this.id}`) return this;
    if (selector === "button[data-copy]" && "copy" in this.dataset) return this;
    return null;
  }
}

function page(stored: string | null, opts: { storageBroken?: boolean } = {}) {
  const listeners: Record<string, ((event: unknown) => unknown)[]> = {};
  const root = new FakeElement("root");
  const toggle = new FakeElement("theme-toggle", "Theme");
  const store = new Map<string, string>();
  if (stored !== null) store.set("divination-theme", stored);
  let parsed = false; // the script runs in <head>, before the buttons exist

  const context = {
    Element: FakeElement,
    setTimeout: (fn: () => void) => fn(),
    navigator: { clipboard: { writeText: async () => {} } },
    localStorage: {
      getItem: (key: string) => {
        if (opts.storageBroken) throw new Error("blocked");
        return store.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        if (opts.storageBroken) throw new Error("blocked");
        store.set(key, value);
      },
    },
    document: {
      documentElement: root,
      getElementById: (id: string) => (parsed && id === "theme-toggle" ? toggle : null),
      addEventListener: (type: string, fn: (event: unknown) => unknown) => {
        (listeners[type] ??= []).push(fn);
      },
    },
  };
  vm.runInNewContext(source, context);

  return {
    root,
    toggle,
    store,
    themeBeforeParse: root.dataset.theme,
    finishParsing() {
      parsed = true;
      for (const fn of listeners.DOMContentLoaded ?? []) fn({});
    },
    async click(target: FakeElement) {
      for (const fn of listeners.click ?? []) await fn({ target });
    },
  };
}

test("a saved theme is applied before the page is drawn, and the button is labelled once it exists", () => {
  const p = page("dark");
  assert.equal(p.themeBeforeParse, "dark");
  p.finishParsing();
  assert.equal(p.toggle.textContent, "☾ Dark");
});

test("with nothing saved the page follows the system and says so", () => {
  const p = page(null);
  assert.equal(p.themeBeforeParse, undefined);
  p.finishParsing();
  assert.equal(p.toggle.textContent, "◐ Auto");
});

test("pressing the toggle cycles auto, light, dark and remembers the choice", async () => {
  const p = page(null);
  p.finishParsing();

  await p.click(p.toggle);
  assert.deepEqual([p.root.dataset.theme, p.toggle.textContent, p.store.get("divination-theme")], ["light", "☀ Light", "light"]);

  await p.click(p.toggle);
  assert.deepEqual([p.root.dataset.theme, p.toggle.textContent, p.store.get("divination-theme")], ["dark", "☾ Dark", "dark"]);

  await p.click(p.toggle);
  assert.deepEqual([p.root.dataset.theme, p.toggle.textContent, p.store.get("divination-theme")], [undefined, "◐ Auto", "auto"]);
});

test("a junk saved value falls back to auto", () => {
  const p = page("neon");
  assert.equal(p.themeBeforeParse, undefined);
});

test("the toggle still works when the browser blocks storage", async () => {
  const p = page(null, { storageBroken: true });
  p.finishParsing();
  await p.click(p.toggle);
  assert.equal(p.root.dataset.theme, "light");
});

test("copy buttons still copy and say so", async () => {
  const p = page(null);
  p.finishParsing();
  const button = new FakeElement("copy-1", "Copy comment");
  button.dataset.copy = "Rename `x`.";
  let copied = "";
  // Replace the clipboard for this check.
  const seen: string[] = [];
  button.closest = (selector: string) => (selector === "button[data-copy]" ? button : null);
  Object.defineProperty(button, "textContent", {
    set(value: string) {
      seen.push(value);
    },
    get() {
      return seen.at(-1) ?? "Copy comment";
    },
  });
  await p.click(button);
  copied = seen[0] ?? "";
  assert.equal(copied, "Copied");
  assert.equal(seen.at(-1), "Copy comment");
});
