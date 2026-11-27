import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { transportOf } from "../core/pipeline.ts";
import { hhmm } from "../core/time.ts";
import type { AttentionItem, Envelope, Panel, Source, View } from "../core/types.ts";
import { isDone, tick } from "./done.ts";
import { faviconHref } from "./favicon.ts";
import { esc, link, who } from "./html.ts";
import { mascotSvg } from "./mascot.ts";
import { isOld, staleAccordion } from "./old.ts";

export interface PageEntry {
  source: Source<any>;
  envelope: Envelope<any>;
}

const themeDir = fileURLToPath(new URL("./theme/", import.meta.url));
const clientScript = fileURLToPath(new URL("./client/app.js", import.meta.url));

function styles(): string {
  return readdirSync(themeDir)
    .filter((name) => name.endsWith(".css"))
    .sort()
    .map((name) => readFileSync(join(themeDir, name), "utf8"))
    .join("\n");
}

/** Data goes stale after an hour, or after half a day for a source that is fed by hand. */
function isStale(sourceId: string, envelope: Envelope<unknown>, view: View): boolean {
  if (envelope.collectedAt === 0) return true;
  const byHand = transportOf(view.config, sourceId) === "inbox";
  const minutes = byHand ? view.config.inboxStaleAfterMinutes : view.config.staleAfterMinutes;
  return view.now - envelope.collectedAt > minutes * 60_000;
}

function updatedText(envelope: Envelope<unknown>, view: View): string {
  if (envelope.collectedAt === 0) return "never updated";
  return `updated ${hhmm(envelope.collectedAt, view.config.me.timezone)}`;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function section(panel: Panel, entry: PageEntry, view: View, drawError?: string): string {
  const { source, envelope } = entry;
  const stale = isStale(source.id, envelope, view);
  const errors = [...(envelope.ok ? [] : [envelope.error ?? "failed"]), ...(drawError ? [drawError] : [])];
  const error = errors.map((text) => `\n<p class="source-error">${esc(text)}</p>`).join("");
  const size = panel.size === "short" ? "short" : "tall";
  return `<section id="${esc(panel.id)}" class="panel tint-${esc(panel.tint)}" data-source="${esc(source.id)}" data-stale="${stale}" data-size="${size}">
<div class="panel-head">
<h2>${esc(panel.title)}</h2>
<p class="updated">${esc(updatedText(envelope, view))}${stale ? ' <span class="dozing">dozing</span>' : ""}</p>
</div>${error}
<div class="panel-body">
${panel.html}
</div>
</section>`;
}

function sectionsFor(entry: PageEntry, view: View): string[] {
  const { source, envelope } = entry;
  if (envelope.data === null) {
    const empty: Panel = { id: source.id, title: source.title, tint: "lilac", html: '<p class="empty">No data yet</p>' };
    return [section(empty, entry, view)];
  }
  // Data in a shape the source does not expect (a hand-dropped file, an envelope written
  // by older code) must not take the whole page down: that source shows the error instead.
  let panels: Panel[];
  try {
    panels = source.panels(envelope.data, view);
  } catch (e) {
    const blank: Panel = { id: source.id, title: source.title, tint: "lilac", html: "" };
    return [section(blank, entry, view, `could not draw this panel: ${message(e)}`)];
  }
  return panels.map((panel) => section(panel, entry, view));
}

/** What a source says is waiting on me. A source that cannot say is treated as having nothing. */
function attentionOf(entry: PageEntry, view: View): AttentionItem[] {
  if (entry.envelope.data === null) return [];
  try {
    return entry.source.attention(entry.envelope.data, view);
  } catch {
    return [];
  }
}

/** Why an item is waiting: its parts when it has them, lozenges and all, otherwise its plain reason. */
function why(it: AttentionItem): string {
  if (!it.parts) return esc(it.reason);
  return it.parts
    .map((part) => {
      if (typeof part === "string") return esc(part);
      if ("who" in part) return who(part.who);
      return `<span class="tag${part.kind === "crew" ? " crew" : ""}">${esc(part.tag)}</span>`;
    })
    .join(" ");
}

function attentionList(items: AttentionItem[]): string {
  const rows = items
    .map((it) => `<li>${link(it.title, it.url)} <span class="reason">${why(it)}</span>${it.doneKey ? tick(it.doneKey, false) : ""}</li>`)
    .join("\n");
  return `<ol class="attention">\n${rows}\n</ol>`;
}

/**
 * Everything that is waiting on you, from every source, as the first panel on the page.
 * Old items are folded into an accordion below the list and are not counted.
 */
function attentionPanel(items: AttentionItem[], stale: AttentionItem[]): string {
  const list = items.length === 0 ? '<p class="quiet">Nothing needs you. Enjoy the calm.</p>' : attentionList(items);
  const body = stale.length === 0 ? list : `${list}\n${staleAccordion(stale.length, attentionList(stale))}`;
  return `<aside id="attention" class="panel tint-accent" data-size="short">
<div class="panel-head">
<h2>Needs you</h2>
<p class="updated">${items.length}</p>
</div>
<div class="panel-body">
${body}
</div>
</aside>`;
}

function dateLine(view: View): string {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: view.config.me.timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(view.now));
}

/** The mascot and the count, in the top bar. */
export function needsYouBadge(count: number): string {
  const label =
    count === 0 ? "All clear" : `<strong>${count}</strong> ${count === 1 ? "thing needs" : "things need"} you`;
  return `<div id="needs-you" data-count="${count}">
${mascotSvg(count)}
<p class="needs-label">${label}</p>
</div>`;
}

/** The whole page as one self-contained HTML document. */
export function renderPage(input: { view: View; entries: PageEntry[] }): string {
  const { view, entries } = input;

  // What I have ticked off by hand no longer waits on me.
  const waiting = entries.flatMap((entry) => attentionOf(entry, view)).filter((it) => !isDone(it.doneKey, view));
  // Only what is shown is counted; old items wait in the accordion.
  const attention = waiting.filter((it) => !isOld(it.at, view));
  const stale = waiting.filter((it) => isOld(it.at, view));
  const sections = entries.flatMap((entry) => sectionsFor(entry, view));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="divination-token" content="__DIVINATION_TOKEN__">
<title>Divination</title>
<link rel="icon" type="image/svg+xml" href="${faviconHref(attention.length)}">
<style>
${styles()}
</style>
<script>
${readFileSync(clientScript, "utf8")}
</script>
</head>
<body>
<header>
<div id="controls">
<button id="live-toggle" type="button">Pause</button>
<button id="refresh-now" type="button">Refresh now</button>
<button id="live-status" type="button" aria-haspopup="dialog" aria-controls="activity-log"></button>
<div id="activity-pop" role="status"></div>
<button id="theme-toggle" type="button" title="Switch between following the system, light and dark">◐ Auto</button>
</div>
<div class="masthead">
<h1>Divination</h1>
<p class="today">${esc(dateLine(view))}</p>
</div>
${needsYouBadge(attention.length)}
</header>
<main>
${attentionPanel(attention, stale)}
${sections.join("\n")}
</main>
<dialog id="activity-log" aria-labelledby="activity-title">
<h2 id="activity-title">Activity <span id="activity-live"></span></h2>
<pre id="activity-lines"></pre>
<button id="activity-close" type="button">Close</button>
</dialog>
</body>
</html>
`;
}
