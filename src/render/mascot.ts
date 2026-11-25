export type Mood = "sleepy" | "awake" | "alarmed";

/** How the crystal ball feels about the number of things that need you. */
export function mascotMood(needsYou: number): Mood {
  if (needsYou <= 0) return "sleepy";
  if (needsYou <= 3) return "awake";
  return "alarmed";
}

// The face is small, low on the ball and wide-set: dot eyes, a little mouth, soft cheeks.
// Eyes are never bigger than a dot, whatever the mood.
const FACE: Record<Mood, string> = {
  // eyes closed in two soft curves, a tiny smile
  sleepy: `<path class="lid" d="M38 66 q5 4 10 0" /><path class="lid" d="M72 66 q5 4 10 0" /><path class="mouth" d="M56 71 q4 3 8 0" />`,
  // dot eyes and a smile
  awake: `<circle class="eye" cx="43" cy="66" r="3.2" /><circle class="eye" cx="77" cy="66" r="3.2" /><path class="mouth" d="M55 69 q5 6 10 0" />`,
  // the same dot eyes, worried brows and a wobbly mouth
  alarmed: `<path class="brow" d="M37 58 l10 -3" /><path class="brow" d="M83 58 l-10 -3" /><circle class="eye" cx="43" cy="66" r="3.4" /><circle class="eye" cx="77" cy="66" r="3.4" /><path class="mouth" d="M53 72 q3.5 -4 7 0 q3.5 4 7 0" />`,
};

const EXTRAS: Record<Mood, string> = {
  sleepy: `<text class="zzz" x="93" y="24">z</text><text class="zzz" x="102" y="13">z</text>`,
  awake: `<path class="star" d="M101 16 l2 5 5 2 -5 2 -2 5 -2 -5 -5 -2 5 -2z" />`,
  alarmed: `<path class="drop" d="M97 30 q5 8 0 11 q-5 -3 0 -11z" /><path class="star" d="M17 24 l2 4.5 4.5 2 -4.5 2 -2 4.5 -2 -4.5 -4.5 -2 4.5 -2z" />`,
};

/** The crystal ball, drawn inline. Its face follows the mood; the page shows the count beside it. */
export function mascotSvg(needsYou: number): string {
  const mood = mascotMood(needsYou);
  const label = `${needsYou} ${needsYou === 1 ? "thing needs" : "things need"} you`;
  return `<svg class="mascot mascot-${mood}" viewBox="0 0 120 130" width="120" height="130" role="img" aria-label="${label}">
<path class="stand" d="M36 106 h48 l7 16 h-62z" />
<rect class="stand-top" x="40" y="100" width="40" height="8" rx="4" />
<circle class="ball" cx="60" cy="60" r="44" />
<ellipse class="glow" cx="60" cy="50" rx="30" ry="24" />
<path class="shine" d="M31 42 q6 -14 19 -19" />
<ellipse class="cheek" cx="33" cy="73" rx="6.5" ry="4" />
<ellipse class="cheek" cx="87" cy="73" rx="6.5" ry="4" />
<g class="face">${FACE[mood]}</g>
<g class="extras">${EXTRAS[mood]}</g>
</svg>`;
}
