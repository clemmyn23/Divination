// A sample page with invented content, used by `divination render --fixtures` to work on
// the look. Each stand-in source below is replaced by the real source and a JSON envelope
// as that source lands.

import type { Envelope, Panel, Source } from "../../../src/core/types.ts";

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
  html: `<p class="headline">3 meetings today, Sam; the longest gap starts at 11:00.</p>
<svg class="terrain" viewBox="0 0 840 170" role="img" aria-label="The shape of the day">
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

const prs: Panel = {
  id: "prs",
  title: "Review queue",
  tint: "blush",
  html: `<h3 class="group">Needs you</h3>
<ul class="items">
<li class="item pr needs-you"><a href="https://git.example.com/o/app/pull/412">Move invoice totals to the new tax service</a>
<p class="meta">o/app#412 · ana · +640 −210 · <span class="ci-pass">CI passing</span> · <span class="tag">rotation</span></p>
<p class="meta">touches billing, large change, rotation, 4 days old</p>
<div class="review">
<p class="verdict">Suggested: comment</p>
<p>The move is sound. One rounding path still uses the old helper.</p>
<div class="finding">
<p class="where">src/billing/totals.ts:88 · should-fix</p>
<pre>\`roundHalfUp\` here still comes from the old helper, so totals can differ by a cent from the tax service. Use \`tax.round()\` instead.</pre>
<button type="button" data-copy="roundHalfUp here still comes from the old helper.">Copy comment</button>
</div>
</div></li>
<li class="item pr needs-you"><a href="https://git.example.com/o/app/pull/418">Add keyboard support to the date picker</a>
<p class="meta">o/app#418 · kit · +180 −35 · <span class="ci-pending">CI running</span> · <span class="tag">direct</span></p>
<p class="meta">CI still running</p>
<button type="button" data-enrich="pr-review" data-key="o/app#418@abc123">Draft review</button></li>
<li class="item pr needs-you"><a href="https://git.example.com/o/app/pull/421">Fix typo in empty state</a>
<p class="meta">o/app#421 · sam-b · +2 −2 · <span class="ci-pass">CI passing</span> · <span class="tag">rotation</span></p>
<p class="meta">quick win, rotation</p>
<button type="button" data-enrich="pr-review" data-key="o/app#421@def456">Draft review</button></li>
</ul>
<h3 class="group">Waiting on authors</h3>
<ul class="items">
<li class="item pr"><a href="https://git.example.com/o/api/pull/97">Rate-limit the export endpoint</a>
<p class="meta">o/api#97 · rio · +95 −12 · <span class="ci-fail">CI failing</span> · <span class="tag">team</span></p></li>
</ul>
<h3 class="group">Covered or low priority</h3>
<ul class="items">
<li class="item pr"><a href="https://git.example.com/o/app/pull/409">Update the contributing guide</a>
<p class="meta">o/app#409 · lee · +40 −8 · docs only</p></li>
<li class="item pr"><a href="https://git.example.com/o/app/pull/415">Swap the chart library</a>
<p class="meta">o/app#415 · mo · +1,210 −980 · already picked up by Ana</p></li>
</ul>`,
};

const slack: Panel = {
  id: "slack",
  title: "Slack",
  tint: "mint",
  html: `<button type="button" data-enrich="slack-summary" data-key="all">Summarise threads</button>
<h3 class="group">Team</h3>
<h4 class="conv">#team-dev</h4>
<ul class="items">
<li class="item thread needs-you"><a href="https://example.slack.com/archives/C1/p1">Sam, can you confirm the rollout order for the tax service before 3?</a>
<p class="meta">Ana, Kit · 4 messages · mentioned you</p></li>
<li class="item thread"><a href="https://example.slack.com/archives/C1/p2">Staging is back after the certificate renewal.</a>
<p class="meta">Rio · 2 messages</p></li>
</ul>
<h4 class="conv">Ana</h4>
<ul class="items">
<li class="item thread needs-you"><a href="https://example.slack.com/archives/D1/p3">Do you have ten minutes after planning?</a>
<p class="meta">Ana · 1 message · waiting on your reply</p></li>
</ul>
<h3 class="group">Starred</h3>
<h4 class="conv">#frontend</h4>
<ul class="items">
<li class="item thread"><a href="https://example.slack.com/archives/C3/p4">Proposal: move the build to the new bundler. The diff is mostly lockfiles.</a>
<p class="meta">Kit, Lee, Mo · 9 messages</p></li>
</ul>
<h3 class="group">Posted in</h3>
<h4 class="conv">#deploys</h4>
<p class="quiet">quiet</p>`,
};

const alerts: Panel = {
  id: "alerts",
  title: "Alerts",
  tint: "lilac",
  html: `<h4 class="conv">#svc-alerts</h4>
<ul class="alert-rows">
<li class="alert state-firing"><a href="https://example.slack.com/archives/C2/p5">Triggered: 5xx rate on checkout</a> <span class="times">×3</span> <span class="state">firing</span></li>
<li class="alert state-resolved"><a href="https://example.slack.com/archives/C2/p6">Recovered: queue depth</a> <span class="times">×1</span> <span class="state">resolved</span></li>
</ul>
<h4 class="conv">#monthly-monitor</h4>
<ul class="alert-rows">
<li class="alert state-info"><a href="https://example.slack.com/archives/C4/p7">Monthly usage report</a> <span class="times">×1</span> <span class="state">info</span></li>
</ul>
<h4 class="conv">#crm-alerts</h4>
<p class="quiet">quiet</p>`,
};

function envelope(id: string, collectedAt: number, error?: string): Envelope<unknown> {
  return { source: id, ok: error === undefined, ...(error ? { error } : {}), collectedAt, attemptedAt: collectedAt, data: {} };
}

/** The sample page's sources and their envelopes, relative to `now`. */
export function fixtureEntries(now: number): Entry[] {
  const minute = 60_000;
  return [
    { source: standIn("calendar", "Today", [today]), envelope: envelope("calendar", now - 4 * minute) },
    {
      source: standIn("github", "Review queue", [prs], () => [
        { key: "o/app#412", title: "Move invoice totals to the new tax service", reason: "touches billing, rotation", url: "https://git.example.com/o/app/pull/412" },
        { key: "o/app#418", title: "Add keyboard support to the date picker", reason: "direct request", url: "https://git.example.com/o/app/pull/418" },
        { key: "o/app#421", title: "Fix typo in empty state", reason: "quick win", url: "https://git.example.com/o/app/pull/421" },
      ]),
      envelope: envelope("github", now - 4 * minute),
    },
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
