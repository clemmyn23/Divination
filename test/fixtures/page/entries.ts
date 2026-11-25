// A sample page with invented content, used by `divination render --fixtures` to work on
// the look. Each stand-in source below is replaced by the real source and a JSON envelope
// as that source lands.

import { isoDate, startOfDay } from "../../../src/core/time.ts";
import type { Envelope, Panel, Source } from "../../../src/core/types.ts";
import { dayClass, headline } from "../../../src/sources/calendar/day.ts";
import { calendar } from "../../../src/sources/calendar/index.ts";
import type { CalEvent, CalendarData } from "../../../src/sources/calendar/types.ts";
import { github } from "../../../src/sources/github/index.ts";
import type { Bucket, Ci, GithubData, PullRequest, Request } from "../../../src/sources/github/types.ts";

interface Entry {
  source: Source<any>;
  envelope: Envelope<any>;
}

function standIn(id: string, title: string, panels: Panel[], attention: Source<any>["attention"] = () => []): Source<any> {
  return {
    id,
    title,
    doctor: async () => [],
    collect: async () => ({}),
    validate: () => [],
    attention,
    panels: () => panels,
  };
}

// Today is drawn by the real calendar source from these invented meetings.
function meeting(day: number, startMinute: number, minutes: number, title: string, over: Partial<CalEvent> = {}): CalEvent {
  const weight = minutes < 30 ? 1 : minutes <= 60 ? 2 : 3;
  return { start: day + startMinute * 60_000, end: day + (startMinute + minutes) * 60_000, title, allDay: false, optional: false, weight, ...over };
}

function dayAt(now: number, tz: string): CalendarData {
  const day = startOfDay(now, tz);
  const events = [
    meeting(day, 0, 1440, "Release freeze", { allDay: true, weight: 1 }),
    meeting(day, 555, 15, "Standup"),
    meeting(day, 660, 120, "Planning"),
    meeting(day, 840, 30, "Design crit", { optional: true }),
    meeting(day, 900, 60, "1:1 with Ana"),
  ];
  const cls = dayClass(events);
  return { date: isoDate(now, tz), events, dayClass: cls, headline: headline(cls, events, "Sam", tz), unsupported: ["Month-end close"] };
}

// The review queue is drawn by the real GitHub source from this invented data.
function pr(
  number: number,
  title: string,
  author: string,
  size: [number, number],
  ci: Ci,
  request: Request,
  bucket: Bucket,
  reasons: string[],
  score = 0,
  ageDays = 2,
): PullRequest {
  return {
    key: `o/app#${number}`,
    repo: "o/app",
    number,
    title,
    url: `https://git.example.com/o/app/pull/${number}`,
    author,
    headSha: `sha${number}`,
    createdAt: -ageDays * 86_400_000, // shifted to "now" by queueAt()
    updatedAt: 0,
    draft: bucket === "excluded" && reasons[0] === "draft",
    additions: size[0],
    deletions: size[1],
    changedFiles: 3,
    paths: [],
    ci,
    request,
    reviewedByMeAtHead: false,
    rank: { score, bucket, reasons },
  };
}

const queue: GithubData = {
  login: "sam",
  prs: [
    pr(412, "Move invoice totals to the new tax service", "ana", [640, 210], "pass", "rotation", "review_now", ["touches billing", "large change", "rotation", "4 days old", "CI passing"], 9),
    pr(418, "Add keyboard support to the date picker", "kit", [180, 35], "pending", "direct", "review_now", [], 0),
    pr(421, "Fix typo in empty state", "sam-b", [2, 2], "pass", "rotation", "quick_win", ["quick win", "rotation", "CI passing"], 3),
    pr(423, "Show a spinner while the audience list loads", "lee", [64, 9], "pass", "rotation", "quick_win", ["quick win", "rotation", "CI passing"], 3),
    pr(397, "Rate-limit the export endpoint", "rio", [95, 12], "fail", "team", "blocked", ["CI failing"], 0),
    pr(402, "Split the campaign editor bundle", "mo", [410, 388], "fail", "rotation", "blocked", ["CI failing", "rotation", "6 days old"], 3),
    pr(405, "Retry webhook deliveries with backoff", "jo", [220, 40], "fail", "team", "blocked", ["CI failing", "touches sending"], 2),
    pr(409, "Update the contributing guide", "lee", [40, 8], "pass", "team", "skip", ["docs only", "CI passing"], 1),
    pr(415, "Swap the chart library", "mo", [1210, 980], "pass", "rotation", "skip", ["already picked up by Ana", "large change", "rotation", "CI passing"], 5),
    pr(416, "Bump the linter and fix new warnings", "bot", [310, 300], "pass", "team", "skip", ["not for this crew (:octagonal_sign:)", "CI passing"], 1),
    pr(419, "Rename the feature flag helper", "kit", [58, 58], "pass", "team", "excluded", ["already reviewed", "CI passing"], 1),
    pr(420, "New onboarding checklist", "ana", [900, 20], "pending", "direct", "excluded", ["draft", "large change"], 2),
    pr(288, "Replace the build tool with workspaces", "kit", [308, 2674], "fail", "rotation", "blocked", ["CI failing", "large change", "rotation", "144 days old"], 5, 144),
    pr(301, "Integrate the segment mapper with the checklist", "jo", [273, 72], "pass", "rotation", "review_now", ["rotation", "285 days old", "CI passing"], 4, 285),
  ],
};

/** The sample queue with its dates set relative to `now`. */
function queueAt(now: number): GithubData {
  return { ...queue, prs: queue.prs.map((p) => ({ ...p, createdAt: now + p.createdAt, updatedAt: now })) };
}

/** Enrichment already in the cache for the sample page: one drafted review. */
export function fixtureEnrich(): Record<string, Record<string, unknown>> {
  return {
    "pr-review": {
      "o/app#412@sha412": {
        verdict: "comment",
        summary: "The move is sound. One rounding path still uses the old helper.",
        findings: [
          {
            file: "src/billing/totals.ts",
            line: "88",
            severity: "should-fix",
            comment: "`roundHalfUp` here still comes from the old helper, so totals can differ by a cent from the tax service. Use `tax.round()` instead.",
          },
        ],
      },
    },
  };
}

const slack: Panel = {
  id: "slack",
  title: "Slack",
  tint: "mint",
  html: `<button type="button" data-enrich="slack-summary" data-key="all">Summarise threads</button>
<h3 class="group">Team</h3>
<ul class="items">
<li class="item thread needs-you"><a href="https://example.slack.com/archives/C1/p1" target="_blank" rel="noopener noreferrer">Sam, can you confirm the rollout order for the tax service before 3?</a>
<p class="meta">#team-dev · Ana, Kit · 4 · mentioned you</p></li>
<li class="item thread needs-you"><a href="https://example.slack.com/archives/D1/p3" target="_blank" rel="noopener noreferrer">Do you have ten minutes after planning?</a>
<p class="meta">Ana · 1 · waiting on your reply</p></li>
<li class="item thread"><a href="https://example.slack.com/archives/C1/p2" target="_blank" rel="noopener noreferrer">Staging is back after the certificate renewal.</a>
<p class="meta">#team-dev · Rio · 2</p></li>
<li class="item thread"><a href="https://example.slack.com/archives/C5/p8" target="_blank" rel="noopener noreferrer">The brand hub loading animation is in the design file now, ring version.</a>
<p class="meta">#project-hub · Yui · 3</p></li>
<li class="item thread"><a href="https://example.slack.com/archives/C5/p9" target="_blank" rel="noopener noreferrer">Agency view: do we want the ring or the dot for the default?</a>
<p class="meta">#project-hub · Yui, Mo · 6</p></li>
<li class="item thread"><a href="https://example.slack.com/archives/C6/p10" target="_blank" rel="noopener noreferrer">Retro notes are up. Two actions carried over from last sprint.</a>
<p class="meta">#team-prod · Jo · 1</p></li>
</ul>
<h3 class="group">Starred</h3>
<ul class="items">
<li class="item thread"><a href="https://example.slack.com/archives/C3/p4" target="_blank" rel="noopener noreferrer">Proposal: move the build to the new bundler. The diff is mostly lockfiles.</a>
<p class="meta">#frontend · Kit, Lee, Mo · 9</p></li>
<li class="item thread"><a href="https://example.slack.com/archives/C3/p11" target="_blank" rel="noopener noreferrer">Heads up: the shared button component changes its focus ring next release.</a>
<p class="meta">#frontend · Lee · 2</p></li>
<li class="item thread"><a href="https://example.slack.com/archives/C7/p12" target="_blank" rel="noopener noreferrer">Who is on review rotation next week? I am out Thursday and Friday.</a>
<p class="meta">#crew-members · Ana, Rio · 5</p></li>
</ul>
<h3 class="group">Sydney</h3>
<ul class="items">
<li class="item thread"><a href="https://example.slack.com/archives/C8/p13" target="_blank" rel="noopener noreferrer">Lift 2 is out of service until Friday. Use the goods lift for deliveries.</a>
<p class="meta">#syd-office · Pat · 1</p></li>
<li class="item thread"><a href="https://example.slack.com/archives/C8/p14" target="_blank" rel="noopener noreferrer">Friday lunch is dumplings. Add dietary needs to the thread by Thursday.</a>
<p class="meta">#syd-office · Pat, Jo, Kit · 12</p></li>
</ul>
<h3 class="group">Posted in</h3>
<ul class="items">
<li class="item thread"><a href="https://example.slack.com/archives/C9/p15" target="_blank" rel="noopener noreferrer">Prune the noise: the deploy bot now posts one message per release.</a>
<p class="meta">#deploys · Sam, Rio · 4</p></li>
</ul>`,
};

const alerts: Panel = {
  id: "alerts",
  title: "Alerts",
  tint: "lilac",
  html: `<h4 class="conv">#svc-alerts</h4>
<ul class="alert-rows">
<li class="alert state-firing"><span class="times">×3</span> <a href="https://example.slack.com/archives/C2/p5" target="_blank" rel="noopener noreferrer">Triggered: 5xx rate on checkout</a> <span class="state">firing</span></li>
<li class="alert state-firing"><span class="times">×1</span> <a href="https://example.slack.com/archives/C2/p16" target="_blank" rel="noopener noreferrer">Triggered: p95 latency on audience search</a> <span class="state">firing</span></li>
<li class="alert state-resolved"><span class="times">×1</span> <a href="https://example.slack.com/archives/C2/p6" target="_blank" rel="noopener noreferrer">Recovered: queue depth</a> <span class="state">resolved</span></li>
</ul>
<h4 class="conv">#sequence-alerts</h4>
<ul class="alert-rows">
<li class="alert state-firing"><span class="times">×7</span> <a href="https://example.slack.com/archives/C10/p17" target="_blank" rel="noopener noreferrer">Sequence step failed: send window missed</a> <span class="state">firing</span></li>
<li class="alert state-resolved"><span class="times">×2</span> <a href="https://example.slack.com/archives/C10/p18" target="_blank" rel="noopener noreferrer">Recovered: sequence scheduler lag</a> <span class="state">resolved</span></li>
</ul>
<h4 class="conv">#monthly-monitor</h4>
<ul class="alert-rows">
<li class="alert state-info"><span class="times">×1</span> <a href="https://example.slack.com/archives/C4/p7" target="_blank" rel="noopener noreferrer">Monthly usage report</a> <span class="state">info</span></li>
</ul>
<p class="quiet">Quiet today: #crm-alerts, #ucf-alerts, #ucf-alerts-dev, #partner-alerting</p>`,
};

function envelope(id: string, collectedAt: number, error?: string): Envelope<any> {
  return { source: id, ok: error === undefined, ...(error ? { error } : {}), collectedAt, attemptedAt: collectedAt, data: {} };
}

/** The sample page's sources and their envelopes, relative to `now`. */
export function fixtureEntries(now: number, tz = "Australia/Sydney"): Entry[] {
  const minute = 60_000;
  return [
    { source: calendar, envelope: { ...envelope("calendar", now - 4 * minute), data: dayAt(now, tz) } },
    { source: github, envelope: { ...envelope("github", now - 4 * minute), data: queueAt(now) } },
    {
      source: standIn("slack", "Slack", [slack], () => [
        { key: "C1:1", title: "#team-dev", reason: "mentioned you", url: "https://example.slack.com/archives/C1/p1" },
        { key: "D1:3", title: "Ana", reason: "waiting on your reply", url: "https://example.slack.com/archives/D1/p3" },
      ]),
      envelope: envelope("slack", now - 4 * minute),
    },
    // Deliberately old and failing, to show what a dozing panel looks like.
    { source: standIn("alerts", "Alerts", [alerts]), envelope: envelope("alerts", now - 190 * minute, "cannot reach slack.com: fetch failed") },
  ];
}
