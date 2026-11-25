// A sample page with invented content, used by `divination render --fixtures` to work on
// the look. Each stand-in source below is replaced by the real source and a JSON envelope
// as that source lands.

import type { Envelope, Panel, Source } from "../../../src/core/types.ts";
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

const today: Panel = {
  id: "today",
  title: "Today",
  tint: "butter",
  size: "short",
  html: `<p class="headline">3 meetings today, Sam; the longest gap starts at 11:00.</p>
<svg class="terrain" viewBox="0 0 840 170" preserveAspectRatio="none" role="img" aria-label="The shape of the day">
<path d="M0,150 L105,150 C115,150 116,110 126,110 C137,110 137,150 147,150 L252,150 C290,150 300,30 378,30 C456,30 466,150 504,150 L588,150 C610,150 616,70 651,70 C686,70 692,150 714,150 L840,150" />
</svg>
<p class="all-day">All day: Release freeze</p>
<ul class="events">
<li><span class="time">09:15–09:30</span> Standup</li>
<li><span class="time">11:00–13:00</span> Planning</li>
<li class="optional"><span class="time">14:00–14:30</span> Design crit <span class="tag">optional</span></li>
<li><span class="time">15:00–16:00</span> 1:1 with Ana</li>
</ul>`,
};

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
): PullRequest {
  return {
    key: `o/app#${number}`,
    repo: "o/app",
    number,
    title,
    url: `https://git.example.com/o/app/pull/${number}`,
    author,
    headSha: `sha${number}`,
    createdAt: 0,
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
  ],
};

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
<li class="item thread needs-you"><a href="https://example.slack.com/archives/C1/p1">Sam, can you confirm the rollout order for the tax service before 3?</a>
<p class="meta">#team-dev · Ana, Kit · 4 · mentioned you</p></li>
<li class="item thread needs-you"><a href="https://example.slack.com/archives/D1/p3">Do you have ten minutes after planning?</a>
<p class="meta">Ana · 1 · waiting on your reply</p></li>
<li class="item thread"><a href="https://example.slack.com/archives/C1/p2">Staging is back after the certificate renewal.</a>
<p class="meta">#team-dev · Rio · 2</p></li>
<li class="item thread"><a href="https://example.slack.com/archives/C5/p8">The brand hub loading animation is in the design file now, ring version.</a>
<p class="meta">#project-hub · Yui · 3</p></li>
<li class="item thread"><a href="https://example.slack.com/archives/C5/p9">Agency view: do we want the ring or the dot for the default?</a>
<p class="meta">#project-hub · Yui, Mo · 6</p></li>
<li class="item thread"><a href="https://example.slack.com/archives/C6/p10">Retro notes are up. Two actions carried over from last sprint.</a>
<p class="meta">#team-prod · Jo · 1</p></li>
</ul>
<h3 class="group">Starred</h3>
<ul class="items">
<li class="item thread"><a href="https://example.slack.com/archives/C3/p4">Proposal: move the build to the new bundler. The diff is mostly lockfiles.</a>
<p class="meta">#frontend · Kit, Lee, Mo · 9</p></li>
<li class="item thread"><a href="https://example.slack.com/archives/C3/p11">Heads up: the shared button component changes its focus ring next release.</a>
<p class="meta">#frontend · Lee · 2</p></li>
<li class="item thread"><a href="https://example.slack.com/archives/C7/p12">Who is on review rotation next week? I am out Thursday and Friday.</a>
<p class="meta">#crew-members · Ana, Rio · 5</p></li>
</ul>
<h3 class="group">Sydney</h3>
<ul class="items">
<li class="item thread"><a href="https://example.slack.com/archives/C8/p13">Lift 2 is out of service until Friday. Use the goods lift for deliveries.</a>
<p class="meta">#syd-office · Pat · 1</p></li>
<li class="item thread"><a href="https://example.slack.com/archives/C8/p14">Friday lunch is dumplings. Add dietary needs to the thread by Thursday.</a>
<p class="meta">#syd-office · Pat, Jo, Kit · 12</p></li>
</ul>
<h3 class="group">Posted in</h3>
<ul class="items">
<li class="item thread"><a href="https://example.slack.com/archives/C9/p15">Prune the noise: the deploy bot now posts one message per release.</a>
<p class="meta">#deploys · Sam, Rio · 4</p></li>
</ul>`,
};

const alerts: Panel = {
  id: "alerts",
  title: "Alerts",
  tint: "lilac",
  html: `<h4 class="conv">#svc-alerts</h4>
<ul class="alert-rows">
<li class="alert state-firing"><span class="times">×3</span> <a href="https://example.slack.com/archives/C2/p5">Triggered: 5xx rate on checkout</a> <span class="state">firing</span></li>
<li class="alert state-firing"><span class="times">×1</span> <a href="https://example.slack.com/archives/C2/p16">Triggered: p95 latency on audience search</a> <span class="state">firing</span></li>
<li class="alert state-resolved"><span class="times">×1</span> <a href="https://example.slack.com/archives/C2/p6">Recovered: queue depth</a> <span class="state">resolved</span></li>
</ul>
<h4 class="conv">#sequence-alerts</h4>
<ul class="alert-rows">
<li class="alert state-firing"><span class="times">×7</span> <a href="https://example.slack.com/archives/C10/p17">Sequence step failed: send window missed</a> <span class="state">firing</span></li>
<li class="alert state-resolved"><span class="times">×2</span> <a href="https://example.slack.com/archives/C10/p18">Recovered: sequence scheduler lag</a> <span class="state">resolved</span></li>
</ul>
<h4 class="conv">#monthly-monitor</h4>
<ul class="alert-rows">
<li class="alert state-info"><span class="times">×1</span> <a href="https://example.slack.com/archives/C4/p7">Monthly usage report</a> <span class="state">info</span></li>
</ul>
<p class="quiet">Quiet today: #crm-alerts, #ucf-alerts, #ucf-alerts-dev, #partner-alerting</p>`,
};

function envelope(id: string, collectedAt: number, error?: string): Envelope<any> {
  return { source: id, ok: error === undefined, ...(error ? { error } : {}), collectedAt, attemptedAt: collectedAt, data: {} };
}

/** The sample page's sources and their envelopes, relative to `now`. */
export function fixtureEntries(now: number): Entry[] {
  const minute = 60_000;
  return [
    { source: standIn("calendar", "Today", [today]), envelope: envelope("calendar", now - 4 * minute) },
    { source: github, envelope: { ...envelope("github", now - 4 * minute), data: queue } },
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
