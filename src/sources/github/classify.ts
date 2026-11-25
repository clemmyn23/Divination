import type { Request, TimelineEvent } from "./types.ts";

/** GitHub stamps the requests made in one action up to a second or so apart. */
const BATCH_WINDOW_MS = 5000;

/** Two requests made by the same person in the same action. */
function sameBatch(a: TimelineEvent, b: TimelineEvent): boolean {
  if ((a.actor?.login ?? "") !== (b.actor?.login ?? "")) return false;
  if (a.created_at === b.created_at) return true;
  const gap = Math.abs(Date.parse(a.created_at) - Date.parse(b.created_at));
  return Number.isFinite(gap) && gap <= BATCH_WINDOW_MS;
}

/**
 * Why this PR is in my queue, read from its `review_requested` events:
 *
 * - `rotation`: the rotation team and I were requested in one batch (the same person,
 *   within a few seconds). The team request may have been removed since; the batch
 *   still counts.
 * - `direct`: I was requested by name, but not in such a batch.
 * - `team`: I was never requested by name, so I am here through some team.
 * - `ambiguous`: there are no request events to go on.
 */
export function classifyRequest(events: TimelineEvent[], me: string, rotationTeam: string): Request {
  const requests = events.filter((e) => e.event === "review_requested");
  if (requests.length === 0) return "ambiguous";

  const mine = requests.filter((e) => e.requested_reviewer?.login === me);
  if (mine.length === 0) return "team";

  const rotation = requests.filter((e) => rotationTeam !== "" && e.requested_team?.slug === rotationTeam);
  return mine.some((m) => rotation.some((r) => sameBatch(m, r))) ? "rotation" : "direct";
}
