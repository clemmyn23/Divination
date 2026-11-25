// A sample page with invented content, used by `divination render --fixtures` to work on
// the look. Every panel is drawn by its real source from the invented data below.

import { isoDate, startOfDay } from "../../../src/core/time.ts";
import type { Envelope, Source } from "../../../src/core/types.ts";
import { dayClass, headline } from "../../../src/sources/calendar/day.ts";
import { calendar } from "../../../src/sources/calendar/index.ts";
import type { CalEvent, CalendarData } from "../../../src/sources/calendar/types.ts";
import { github } from "../../../src/sources/github/index.ts";
import type { Bucket, Ci, GithubData, PullRequest, Request } from "../../../src/sources/github/types.ts";
import { slack } from "../../../src/sources/slack/index.ts";
import type { AlertCount, SlackData, SlackThread } from "../../../src/sources/slack/types.ts";

interface Entry {
  source: Source<any>;
  envelope: Envelope<any>;
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

// Slack and Alerts are drawn by the real Slack source from these invented threads.
const WORKSPACE = "https://example.slack.com";

function chat(
  channelId: string,
  n: number,
  minutesAgo: number,
  excerpt: string,
  authors: string[],
  messageCount: number,
  needsYou?: string,
): (now: number) => SlackThread {
  return (now) => {
    const ts = `${Math.floor((now - minutesAgo * 60_000) / 1000)}.${String(n).padStart(6, "0")}`;
    return {
      channelId,
      ts,
      url: `${WORKSPACE}/archives/${channelId}/p${ts.replace(".", "")}`,
      authors,
      excerpt,
      text: authors.map((name) => `${name}: …`).join("\n"),
      messageCount,
      latestTs: ts,
      ...(needsYou ? { needsYou } : {}),
    };
  };
}

const chats = [
  chat("C1", 1, 35, "Sam, can you confirm the rollout order for the tax service before 3?", ["Ana", "Kit"], 4, "mentioned you"),
  chat("D1", 3, 20, "Do you have ten minutes after planning?", ["Ana"], 1, "waiting on your reply"),
  chat("C1", 2, 50, "Staging is back after the certificate renewal.", ["Rio"], 2),
  chat("C5", 8, 70, "The brand hub loading animation is in the design file now, ring version.", ["Yui"], 3),
  chat("C5", 9, 95, "Agency view: do we want the ring or the dot for the default?", ["Yui", "Mo"], 6),
  chat("C6", 10, 120, "Retro notes are up. Two actions carried over from last sprint.", ["Jo"], 1),
  chat("C3", 4, 40, "Proposal: move the build to the new bundler. The diff is mostly lockfiles.", ["Kit", "Lee", "Mo"], 9),
  chat("C3", 11, 80, "Heads up: the shared button component changes its focus ring next release.", ["Lee"], 2),
  chat("C7", 12, 100, "Who is on review rotation next week? I am out Thursday and Friday.", ["Ana", "Rio"], 5),
  chat("C8", 13, 60, "Lift 2 is out of service until Friday. Use the goods lift for deliveries.", ["Pat"], 1),
  chat("C8", 14, 110, "Friday lunch is dumplings. Add dietary needs to the thread by Thursday.", ["Pat", "Jo", "Kit"], 12),
  chat("C9", 15, 30, "Prune the noise: the deploy bot now posts one message per release.", ["Sam", "Rio"], 4),
];

const alertRow = (channelId: string, n: number, title: string, count: number, state: AlertCount["state"]): AlertCount => ({
  title,
  count,
  state,
  latestTs: `${n}.000100`,
  url: `${WORKSPACE}/archives/${channelId}/p${n}`,
});

function slackAt(now: number): SlackData {
  const channel = (id: string, name: string, group: string, kind: "channel" | "dm" | "alerts" = "channel") => ({ id, name, group, kind });
  return {
    conversations: [
      channel("C1", "team-dev", "Team"),
      channel("D1", "Ana", "Team", "dm"),
      channel("C5", "project-hub", "Team"),
      channel("C6", "team-prod", "Team"),
      channel("C3", "frontend", "Starred"),
      channel("C7", "crew-members", "Starred"),
      channel("C8", "syd-office", "Sydney"),
      channel("C2", "svc-alerts", "Alerts", "alerts"),
      channel("C10", "sequence-alerts", "Alerts", "alerts"),
      channel("C4", "monthly-monitor", "Alerts", "alerts"),
      channel("C11", "crm-alerts", "Alerts", "alerts"),
      channel("C12", "ucf-alerts", "Alerts", "alerts"),
      channel("C13", "ucf-alerts-dev", "Alerts", "alerts"),
      channel("C14", "partner-alerting", "Alerts", "alerts"),
      channel("C9", "deploys", "Posted in"),
    ],
    threads: chats.map((make) => make(now)),
    alerts: {
      C2: [
        alertRow("C2", 5, "Triggered: 5xx rate on checkout", 3, "firing"),
        alertRow("C2", 16, "Triggered: p95 latency on audience search", 1, "firing"),
        alertRow("C2", 6, "Recovered: queue depth", 1, "resolved"),
      ],
      C10: [alertRow("C10", 17, "Sequence step failed: send window missed", 7, "firing"), alertRow("C10", 18, "Recovered: sequence scheduler lag", 2, "resolved")],
      C4: [alertRow("C4", 7, "Monthly usage report", 1, "info")],
    },
  };
}

function envelope(id: string, collectedAt: number, error?: string): Envelope<any> {
  return { source: id, ok: error === undefined, ...(error ? { error } : {}), collectedAt, attemptedAt: collectedAt, data: {} };
}

/** The sample page's sources and their envelopes, relative to `now`. */
export function fixtureEntries(now: number, tz = "Australia/Sydney"): Entry[] {
  const minute = 60_000;
  return [
    { source: calendar, envelope: { ...envelope("calendar", now - 4 * minute), data: dayAt(now, tz) } },
    { source: github, envelope: { ...envelope("github", now - 4 * minute), data: queueAt(now) } },
    { source: slack, envelope: { ...envelope("slack", now - 4 * minute), data: slackAt(now) } },
  ];
}
