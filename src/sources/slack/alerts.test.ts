import assert from "node:assert/strict";
import { test } from "node:test";
import { alertState, alertTitle, countAlerts } from "./alerts.ts";

const PATTERNS = { firing: "triggered|firing|failed|error|down", resolved: "recovered|resolved|back to normal" };
const a = (ts: string, text: string) => ({ ts, text });

test("alert titles and states", () => {
  assert.equal(alertTitle({ ts: "1", text: "x", attachments: [{ title: "Triggered: 5xx rate on host-12345" }] }), "Triggered: 5xx rate on host-#");
  assert.equal(alertTitle({ ts: "1", text: "Deploy 20261125 failed\nmore" }), "Deploy # failed");
  assert.equal(alertState({ ts: "1", text: "Recovered: 5xx rate" }, PATTERNS), "resolved");
  assert.equal(alertState({ ts: "1", text: "Triggered: 5xx rate" }, PATTERNS), "firing");
  assert.equal(alertState({ ts: "1", text: "weekly report", attachments: [{ color: "danger" }] }, PATTERNS), "firing");
  assert.equal(alertState({ ts: "1", text: "weekly report" }, PATTERNS), "info");
});

test("titles are tidied, cut to 80 characters, and never empty", () => {
  assert.equal(alertTitle({ ts: "1", text: "  *Triggered:*   <https://x.example/m/1|CPU high>  " }), "Triggered: CPU high");
  assert.equal(alertTitle({ ts: "1", text: "z".repeat(200) }).length, 80);
  assert.equal(alertTitle({ ts: "1", text: "" }), "(no title)");
});

test("states: resolved wins over firing, colours count, and patterns ignore case", () => {
  assert.equal(alertState({ ts: "1", text: "RESOLVED: error rate" }, PATTERNS), "resolved");
  assert.equal(alertState({ ts: "1", text: "report", attachments: [{ color: "#D00000" }] }, PATTERNS), "firing");
  assert.equal(alertState({ ts: "1", text: "report", attachments: [{ color: "#e01e5a" }] }, PATTERNS), "firing");
  assert.equal(alertState({ ts: "1", text: "report", attachments: [{ color: "#2eb67d" }] }, PATTERNS), "info");
  assert.equal(alertState({ ts: "1", text: "x", attachments: [{ title: "Service DOWN" }] }, PATTERNS), "firing");
});

test("alerts are counted by title since the start of today", () => {
  const rows = countAlerts([a("90", "Triggered: A"), a("100", "Triggered: A"), a("110", "Recovered: B"), a("120", "Triggered: A"), a("5", "Triggered: A")], PATTERNS, "https://w.slack.com", "C2", 50_000);
  assert.deepEqual(
    rows.map((r) => [r.title, r.count, r.state, r.latestTs]),
    [
      ["Triggered: A", 3, "firing", "120"],
      ["Recovered: B", 1, "resolved", "110"],
    ],
  );
  assert.equal(rows[0]!.url, "https://w.slack.com/archives/C2/p120");
});

test("firing rows come first, then the most frequent", () => {
  const rows = countAlerts([a("100", "report one"), a("101", "report one"), a("102", "report one"), a("103", "Triggered: X"), a("104", "Triggered: Y"), a("105", "Triggered: Y")], PATTERNS, "https://w.slack.com", "C2", 0);
  assert.deepEqual(
    rows.map((r) => r.title),
    ["Triggered: Y", "Triggered: X", "report one"],
  );
});
