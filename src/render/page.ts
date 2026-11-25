import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { hhmm } from "../core/time.ts";
import type { AttentionItem, Envelope, Panel, Source, View } from "../core/types.ts";
import { esc, link } from "./html.ts";

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

function isStale(envelope: Envelope<unknown>, view: View): boolean {
  if (envelope.collectedAt === 0) return true;
  return view.now - envelope.collectedAt > view.config.staleAfterMinutes * 60_000;
}

function updatedText(envelope: Envelope<unknown>, view: View): string {
  if (envelope.collectedAt === 0) return "never updated";
  return `updated ${hhmm(envelope.collectedAt, view.config.me.timezone)}`;
}

function section(panel: Panel, entry: PageEntry, view: View): string {
  const { source, envelope } = entry;
  const stale = isStale(envelope, view);
  const error = envelope.ok ? "" : `\n<p class="source-error">${esc(envelope.error ?? "failed")}</p>`;
  return `<section id="${esc(panel.id)}" class="panel tint-${esc(panel.tint)}" data-source="${esc(source.id)}" data-stale="${stale}">
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
  return source.panels(envelope.data, view).map((panel) => section(panel, entry, view));
}

function attentionList(items: AttentionItem[]): string {
  if (items.length === 0) return "";
  const rows = items
    .map((it) => `<li>${link(it.title, it.url)} <span class="reason">${esc(it.reason)}</span></li>`)
    .join("\n");
  return `<ol class="attention">\n${rows}\n</ol>`;
}

function dateLine(view: View): string {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: view.config.me.timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(view.now));
}

/** What sits in the header beside the title. Task 5 puts the mascot here. */
export function needsYouBadge(count: number): string {
  return `<div id="needs-you" data-count="${count}">
<span class="count">${count}</span>
<span class="label">${count === 1 ? "thing needs you" : "things need you"}</span>
</div>`;
}

/** The whole page as one self-contained HTML document. */
export function renderPage(input: { view: View; entries: PageEntry[] }): string {
  const { view, entries } = input;

  const attention = entries.flatMap(({ source, envelope }) =>
    envelope.data === null ? [] : source.attention(envelope.data, view),
  );
  const sections = entries.flatMap((entry) => sectionsFor(entry, view));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="divination-token" content="__DIVINATION_TOKEN__">
<title>Divination</title>
<style>
${styles()}
</style>
</head>
<body>
<header>
<div id="controls">
<button id="live-toggle" type="button">Pause</button>
<button id="refresh-now" type="button">Refresh now</button>
<span id="live-status"></span>
</div>
<div class="masthead">
<h1>Divination</h1>
<p class="today">${esc(dateLine(view))}</p>
</div>
${needsYouBadge(attention.length)}
${attentionList(attention)}
</header>
<main>
${sections.join("\n")}
</main>
<script>
${readFileSync(clientScript, "utf8")}
</script>
</body>
</html>
`;
}
