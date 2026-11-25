export type Mood = "sleepy" | "awake" | "alarmed";

/** How the crystal ball feels about the number of things that need you. */
export function mascotMood(needsYou: number): Mood {
  if (needsYou <= 0) return "sleepy";
  if (needsYou <= 3) return "awake";
  return "alarmed";
}

const EYES: Record<Mood, string> = {
  // closed arcs
  sleepy: `<path d="M41 56 q7 6 14 0" /><path d="M65 56 q7 6 14 0" />`,
  // dots
  awake: `<circle cx="48" cy="56" r="3.5" /><circle cx="72" cy="56" r="3.5" />`,
  // wide, with a sparkle
  alarmed: `<circle cx="48" cy="55" r="7" /><circle cx="72" cy="55" r="7" /><circle class="glint" cx="50.5" cy="52.5" r="2.2" /><circle class="glint" cx="74.5" cy="52.5" r="2.2" />`,
};

const MOUTH: Record<Mood, string> = {
  sleepy: `<path d="M55 66 q5 3 10 0" />`,
  awake: `<path d="M53 65 q7 7 14 0" />`,
  alarmed: `<ellipse cx="60" cy="67" rx="4" ry="5" />`,
};

const EXTRAS: Record<Mood, string> = {
  sleepy: `<text class="zzz" x="92" y="26">z</text><text class="zzz" x="101" y="15">z</text>`,
  awake: `<path class="star" d="M100 20 l2 5 5 2 -5 2 -2 5 -2 -5 -5 -2 5 -2z" />`,
  alarmed: `<path class="star" d="M100 18 l2.5 6 6 2.5 -6 2.5 -2.5 6 -2.5 -6 -6 -2.5 6 -2.5z" /><path class="star" d="M16 30 l2 4.5 4.5 2 -4.5 2 -2 4.5 -2 -4.5 -4.5 -2 4.5 -2z" />`,
};

/** The crystal ball, drawn inline. Its face follows the mood and the count sits inside it. */
export function mascotSvg(needsYou: number): string {
  const mood = mascotMood(needsYou);
  const label = `${needsYou} ${needsYou === 1 ? "thing needs" : "things need"} you`;
  return `<svg class="mascot mascot-${mood}" viewBox="0 0 120 130" width="120" height="130" role="img" aria-label="${label}">
<path class="stand" d="M34 104 h52 l8 18 h-68z" />
<rect class="stand-top" x="38" y="98" width="44" height="9" rx="4.5" />
<circle class="ball" cx="60" cy="60" r="44" />
<path class="shine" d="M30 44 q6 -16 22 -22" />
<ellipse class="cheek" cx="38" cy="66" rx="6" ry="3.5" />
<ellipse class="cheek" cx="82" cy="66" rx="6" ry="3.5" />
<g class="eyes">${EYES[mood]}</g>
<g class="mouth">${MOUTH[mood]}</g>
<text class="mascot-count" x="60" y="92" text-anchor="middle">${needsYou}</text>
<g class="extras">${EXTRAS[mood]}</g>
</svg>`;
}
