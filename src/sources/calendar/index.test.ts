import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { NOW, contextWith, fakeExec, fakeHttp, view } from "../../../test/helpers.ts";
import { HttpError } from "../../core/http.ts";
import { collectSource } from "../../core/pipeline.ts";
import type { Secrets } from "../../core/types.ts";
import { calendar } from "./index.ts";
import type { CalEvent, CalendarData } from "./types.ts";

const sample = readFileSync(fileURLToPath(new URL("../../../test/fixtures/calendar/sample.ics", import.meta.url)), "utf8");
const ADDRESS = "https://cal.example.com/private-sekrit-token/basic.ics";
const local = { me: { name: "Clem", email: "me@example.com" } };
const wed = Date.parse("2026-11-24T13:00:00Z"); // Sydney midnight

const secrets = (value?: string): Secrets => ({ get: async (name) => (name === "calendar_ics" ? value : undefined) });

function mins(start: number, length: number, over: Partial<CalEvent> = {}): CalEvent {
  return {
    start: wed + start * 60_000,
    end: wed + (start + length) * 60_000,
    title: "Meeting",
    allDay: false,
    optional: false,
    weight: 2,
    ...over,
  };
}

function data(over: Partial<CalendarData> = {}): CalendarData {
  return { date: "2026-11-25", events: [], dayClass: "open", headline: "The day is yours, Clem.", unsupported: [], ...over };
}

test("collect reads the calendar address from the secret store and works out today", async () => {
  const http = fakeHttp({ [ADDRESS]: sample });
  const got = await calendar.collect(contextWith(local, { http, secrets: secrets(ADDRESS) }));
  assert.deepEqual(http.calls, [ADDRESS]);
  assert.equal(got.date, "2026-11-25");
  assert.deepEqual(
    got.events.map((e) => e.title),
    ["Daily standup, team", "Planning", "Moved 1:1"],
  );
  assert.equal(got.dayClass, "normal");
  assert.equal(got.headline, "2 meetings today, Clem; the longest gap starts at 09:45.");
  assert.deepEqual(got.unsupported, ["Yearly review"]);
  assert.deepEqual(calendar.validate(got), []);
});

test("a missing address says how to set it", async () => {
  await assert.rejects(calendar.collect(contextWith(local, { secrets: secrets(undefined) })), {
    message: "no calendar address; run: divination secret set calendar_ics",
  });
});

test("a webcal address is fetched over https, and anything else is refused without being fetched", async () => {
  const http = fakeHttp({ [ADDRESS]: sample });
  await calendar.collect(contextWith(local, { http, secrets: secrets(ADDRESS.replace("https://", "webcal://")) }));
  assert.deepEqual(http.calls, [ADDRESS]);

  const none = fakeHttp({});
  await assert.rejects(
    calendar.collect(contextWith(local, { http: none, secrets: secrets("http://cal.example.com/private-sekrit-token") })),
    (e: Error) => /https/.test(e.message) && !/sekrit/.test(e.message),
  );
  assert.deepEqual(none.calls, []);
});

test("the calendar address never reaches an error, the envelope or the log", async () => {
  for (const failure of [new HttpError(404, ADDRESS, "not found"), new Error(`fetch failed for ${ADDRESS}`)]) {
    const logged: unknown[] = [];
    const ctx = contextWith(local, {
      http: fakeHttp({ [ADDRESS]: failure }),
      secrets: secrets(ADDRESS),
      log: (event, fields) => logged.push([event, fields]),
    });
    const envelope = await collectSource(calendar, ctx);
    assert.equal(envelope.ok, false);
    assert.ok(envelope.error);
    assert.ok(!/sekrit|cal\.example\.com\/private/.test(JSON.stringify(envelope) + JSON.stringify(logged)));
    assert.ok(!/sekrit/.test(readFileSync(ctx.paths.data("calendar"), "utf8")));
  }
});

test("a failed fetch says what the server answered", async () => {
  const ctx = contextWith(local, { http: fakeHttp({ [ADDRESS]: new HttpError(404, ADDRESS, "gone") }), secrets: secrets(ADDRESS) });
  await assert.rejects(calendar.collect(ctx), { message: "the calendar address answered HTTP 404" });
});

test("an answer that is not a calendar is an error, not an empty day", async () => {
  const ctx = contextWith(local, { http: fakeHttp({ [ADDRESS]: "<html>Sign in</html>" }), secrets: secrets(ADDRESS) });
  await assert.rejects(calendar.collect(ctx), { message: "the calendar address did not return a calendar" });
});

test("validate", () => {
  assert.deepEqual(calendar.validate(data()), []);
  assert.ok(calendar.validate(null).length > 0);
  assert.ok(calendar.validate({ ...data(), events: "none" }).length > 0);
  assert.ok(calendar.validate({ ...data(), dayClass: "busy" }).length > 0);
  assert.ok(calendar.validate({ ...data(), headline: 3 }).length > 0);
});

test("nothing on the calendar asks for attention", () => {
  assert.deepEqual(calendar.attention(data({ events: [mins(600, 30)] }), view), []);
});

test("doctor reports whether an address is stored and whether it answers, without showing it", async () => {
  const missing = await calendar.doctor(contextWith(local, { secrets: secrets(undefined) }));
  assert.deepEqual(
    missing.map((c) => [c.name, c.ok, c.fix]),
    [["address", false, "divination secret set calendar_ics"]],
  );

  const good = await calendar.doctor(contextWith(local, { http: fakeHttp({ [ADDRESS]: sample }), secrets: secrets(ADDRESS) }));
  assert.deepEqual(
    good.map((c) => [c.name, c.ok]),
    [
      ["address", true],
      ["calendar file", true],
    ],
  );
  assert.match(good[1]!.detail, /8 events/);

  const bad = await calendar.doctor(
    contextWith(local, { http: fakeHttp({ [ADDRESS]: new HttpError(403, ADDRESS, "") }), secrets: secrets(ADDRESS) }),
  );
  assert.equal(bad[1]!.ok, false);
  assert.ok(!/sekrit/.test(JSON.stringify([missing, good, bad])));
});

test("the panel shows the headline, the day's shape and the timed events", () => {
  const [panel, ...rest] = calendar.panels(
    data({
      events: [mins(570, 15, { title: "Standup", weight: 1 }), mins(660, 90, { title: "Planning <b>", optional: true, weight: 3 })],
      dayClass: "normal",
      headline: "One meeting today, Clem, at 09:30.",
    }),
    view,
  );
  assert.equal(rest.length, 0);
  assert.equal(panel!.id, "today");
  assert.equal(panel!.title, "Today");
  assert.equal(panel!.tint, "butter");
  assert.equal(panel!.size, "short");
  assert.ok(panel!.html.includes('<p class="headline">One meeting today, Clem, at 09:30.</p>'));
  assert.match(panel!.html, /<svg class="terrain" viewBox="0 0 840 170"[^>]*>\s*<path d="M0,150 [^"]+840,150" \/>/);
  assert.ok(panel!.html.includes('<li><span class="time">09:30–09:45</span> Standup</li>'));
  assert.ok(
    panel!.html.includes('<li class="optional"><span class="time">11:00–12:30</span> Planning &lt;b&gt; <span class="tag">optional</span></li>'),
  );
  assert.ok(!panel!.html.includes("All day"));
  assert.ok(!panel!.html.includes("Not understood"));
});

test("all-day events sit on one line above the list, and unread rules are named below it", () => {
  const [panel] = calendar.panels(
    data({
      events: [
        mins(0, 1440, { title: "Release freeze", allDay: true, weight: 1 }),
        mins(0, 1440, { title: "Ana & Kit away", allDay: true, weight: 1 }),
        mins(600, 30, { title: "Sync" }),
      ],
      unsupported: ["Month end", "Board <prep>"],
    }),
    view,
  );
  const html = panel!.html;
  assert.ok(html.includes('<p class="all-day">All day: Release freeze, Ana &amp; Kit away</p>'));
  assert.ok(html.includes('<p class="quiet">Not understood: Month end, Board &lt;prep&gt;</p>'));
  assert.ok(html.indexOf("All day") < html.indexOf('<ul class="events">'));
  assert.ok(html.indexOf('<ul class="events">') < html.indexOf("Not understood"));
  assert.equal(html.match(/<li/g)!.length, 1);
});

test("a day with no timed events says so instead of showing an empty list", () => {
  const [panel] = calendar.panels(data(), view);
  assert.ok(panel!.html.includes('<p class="quiet">No meetings today.</p>'));
  assert.ok(!panel!.html.includes('<ul class="events">'));
  assert.ok(panel!.html.includes('d="M0,150 L840,150"'));
});

test("events from another day are labelled as such", () => {
  const [today] = calendar.panels(data(), view);
  assert.ok(!today!.html.includes("not been read"));
  const [stale] = calendar.panels(data({ date: "2026-11-24" }), { ...view, now: NOW });
  assert.ok(stale!.html.includes('<p class="quiet">These are for 2026-11-24; today has not been read yet.</p>'));
});

test("fed by hand, doctor also checks the Claude CLI when Refresh now is set to use it, and only then", async () => {
  const exec = fakeExec({ "claude auth status": { stdout: '{"loggedIn": false}', code: 1 } });
  const off = await calendar.doctor(contextWith({ calendar: { transport: "inbox" } }, { exec }));
  assert.deepEqual(off.map((c) => c.name), ["inbox file"]);
  assert.equal(exec.calls.length, 0);

  const on = await calendar.doctor(contextWith({ calendar: { transport: "inbox" }, claudeReads: { onRefresh: true } }, { exec }));
  assert.deepEqual(on.map((c) => [c.name, c.ok]), [["inbox file", false], ["claude", false]]);

  // And when the timer is set to have Claude read it, with Refresh now off.
  const timed = await calendar.doctor(contextWith({ calendar: { transport: "inbox" }, claudeReads: { everyMinutes: { calendar: 60 } } }, { exec }));
  assert.deepEqual(timed.map((c) => c.name), ["inbox file", "claude"]);
  const other = await calendar.doctor(contextWith({ calendar: { transport: "inbox" }, claudeReads: { everyMinutes: { slack: 30 } } }, { exec }));
  assert.deepEqual(other.map((c) => c.name), ["inbox file"]);
});
