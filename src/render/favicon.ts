// The tab icon: the crystal ball, small. A favicon cannot see the page's colour tokens,
// so its colours are written out here; they are the daytime ones from tokens.css and
// read well on both light and dark tab bars.

const BALL = "#dccfff";
const BALL_EDGE = "#ab96ee";
const STAND = "#d9ae76";
const FACE = "#4a3566";
const ACCENT = "#e0568b";

/** The icon as SVG. A pink badge replaces the sparkle when something needs you. */
export function faviconSvg(needsYou: number): string {
  const corner =
    needsYou > 0
      ? `<circle class="badge" cx="51" cy="13" r="11" fill="${ACCENT}" stroke="#fff" stroke-width="3"/>`
      : `<path d="M52 3l2.4 6 6 2.4-6 2.4-2.4 6-2.4-6-6-2.4 6-2.4z" fill="${ACCENT}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<path d="M17 51h30l5 11H12z" fill="${STAND}"/>
<circle cx="32" cy="29" r="24" fill="${BALL}" stroke="${BALL_EDGE}" stroke-width="3"/>
<path d="M15 22q4-9 12-12" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round"/>
<circle cx="24" cy="33" r="2.8" fill="${FACE}"/>
<circle cx="40" cy="33" r="2.8" fill="${FACE}"/>
<path d="M27 38q5 5 10 0" fill="none" stroke="${FACE}" stroke-width="2.6" stroke-linecap="round"/>
${corner}
</svg>`;
}

/** The icon as a `data:` address, so the page stays one self-contained file. */
export function faviconHref(needsYou: number): string {
  return `data:image/svg+xml,${encodeURIComponent(faviconSvg(needsYou))}`;
}
