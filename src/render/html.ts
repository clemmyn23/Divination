const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape text for use in HTML, in element content or in a quoted attribute. */
export function esc(s: unknown): string {
  if (s === undefined || s === null) return "";
  return String(s).replace(/[&<>"']/g, (c) => ENTITIES[c]!);
}

/** Someone's name on a line of small print, in bold so it can be found at a glance. */
export function who(name: string): string {
  return `<strong class="who">${esc(name)}</strong>`;
}

/** A link that opens a channel or a message in the Slack app. Nothing else with that scheme is let through. */
const SLACK_APP = /^slack:\/\/channel\?team=[A-Z0-9]+&id=[A-Z0-9]+(&message=\d+\.\d+)?(&thread_ts=\d+\.\d+)?$/;

/** The URL if it is a plain `https://` address or a Slack app link, otherwise undefined. */
export function safeUrl(u: unknown): string | undefined {
  if (typeof u !== "string") return undefined;
  if (SLACK_APP.test(u)) return u;
  if (!u.startsWith("https://") || u.length <= "https://".length) return undefined;
  return u;
}

/**
 * A link when the URL is safe, otherwise just the escaped text. Every web link opens in
 * a new tab, so the dashboard stays put, and the page it opens gets no handle back to it.
 */
export function link(text: string, url: unknown): string {
  const safe = safeUrl(url);
  // An app link hands over to the app; a new tab for it would just sit there empty.
  if (safe?.startsWith("slack://")) return `<a href="${esc(safe)}">${esc(text)}</a>`;
  return safe ? `<a href="${esc(safe)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>` : esc(text);
}
