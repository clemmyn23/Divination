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

/** The URL if it is a plain `https://` address, otherwise undefined. */
export function safeUrl(u: unknown): string | undefined {
  if (typeof u !== "string") return undefined;
  if (!u.startsWith("https://") || u.length <= "https://".length) return undefined;
  return u;
}

/** A link when the URL is safe, otherwise just the escaped text. */
export function link(text: string, url: unknown): string {
  const safe = safeUrl(url);
  return safe ? `<a href="${esc(safe)}">${esc(text)}</a>` : esc(text);
}
