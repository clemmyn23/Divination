import { setDone } from "../../../core/done.ts";
import type { Context } from "../../../core/types.ts";
import { cacheGet, hashOf } from "../../../enrich/cache.ts";
import { type Github, type ReviewComment, createGithub } from "../client.ts";
import { place, reviewBody, rightLines } from "./anchor.ts";

// Posting a drafted review to its PR. Only a press of Post in a review's dialog leads
// here, through `POST /api/review/post`; no timer, refresh or LLM call does. What is
// posted is what was ticked: the page sends which notes and their words, and where each
// note goes is read from the stored draft, never from the page.

export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

export interface PostRequest {
  /** The draft's key: `owner/repo#number@commit`. */
  key: string;
  event: ReviewEvent;
  /** My own words. They go first in the review's overall comment. */
  message: string;
  /** The draft's summary as I left it, when it was ticked. */
  summary?: string;
  /** The ticked notes: each one's place in the draft, and its text as I left it. */
  notes: { index: number; text: string }[];
}

export interface PostResult {
  /** Notes posted as comments on lines of the diff. */
  comments: number;
  /** Notes that had no line in the diff, and went in the overall comment. */
  inBody: number;
  url?: string;
}

/** The post was refused before anything was sent to the PR. */
export class Refusal extends Error {}

/** The done mark that records a posted review. It includes the commit, like the draft's key. */
export const postedKey = (reviewKey: string): string => `posted:${reviewKey}`;

const KEY = /^([\w.-]+\/[\w.-]+)#(\d{1,9})@([0-9A-Za-z]{1,64})$/;
const EVENTS: ReviewEvent[] = ["COMMENT", "APPROVE", "REQUEST_CHANGES"];
const KEY_MAX = 300;
const TEXT_MAX = 10_000;
const NOTES_MAX = 100;

const isText = (value: unknown): value is string => typeof value === "string" && value.length <= TEXT_MAX;

/** Read a request's fields. A string back is what is wrong with them. */
export function parsePost(fields: Record<string, unknown>): PostRequest | string {
  const { key, event, message = "", summary, notes = [] } = fields;
  if (typeof key !== "string" || key.length > KEY_MAX || !KEY.test(key)) return '"key" must be a drafted review, as owner/repo#number@commit';
  if (!EVENTS.includes(event as ReviewEvent)) return '"event" must be COMMENT, APPROVE or REQUEST_CHANGES';
  if (!isText(message)) return '"message" must be text, at most 10,000 characters';
  if (summary !== undefined && !isText(summary)) return '"summary" must be text, at most 10,000 characters';
  if (!Array.isArray(notes) || notes.length > NOTES_MAX) return '"notes" must be a list of at most 100 notes';
  const read: PostRequest["notes"] = [];
  for (const note of notes as unknown[]) {
    const { index, text } = (typeof note === "object" && note !== null ? note : {}) as { index?: unknown; text?: unknown };
    if (!Number.isSafeInteger(index) || (index as number) < 0 || read.some((earlier) => earlier.index === index) || !isText(text) || text.trim() === "") {
      return 'each of "notes" must be a different note of the draft, with its text';
    }
    read.push({ index: index as number, text });
  }
  return { key, event: event as ReviewEvent, message, ...(summary !== undefined ? { summary } : {}), notes: read };
}

interface Finding {
  file: string;
  line: string;
}

/** The stored draft's notes, if it is a draft at all. */
function findingsOf(draft: unknown): Finding[] | undefined {
  const findings = (draft as { findings?: unknown } | undefined)?.findings;
  if (!Array.isArray(findings)) return undefined;
  if (!findings.every((f) => typeof f === "object" && f !== null && typeof f.file === "string" && typeof f.line === "string")) return undefined;
  return findings as Finding[];
}

/**
 * Post one review to one PR, under my name.
 *
 * In order: the draft must be in the cache; the PR must be open and still at the commit
 * the draft was written for; each ticked note is placed on its line of the diff, or in
 * the overall comment when it has none; a comment or a change request with nothing to say
 * is refused. Then one review is posted, and the post is marked so the page can say so.
 * Throws a `Refusal` when nothing was sent; anything else thrown is GitHub's own answer.
 */
export async function postReview(ctx: Context, req: PostRequest, deps: { github?: (ctx: Context) => Github } = {}): Promise<PostResult> {
  const named = KEY.exec(req.key);
  if (!named) throw new Refusal(`${req.key} is not a drafted review`);
  const repo = named[1]!;
  const number = Number(named[2]);
  const sha = named[3]!;

  const findings = findingsOf(cacheGet(ctx, "pr-review", hashOf(req.key)));
  if (!findings) throw new Refusal("there is no drafted review for this PR at that commit");
  const missing = req.notes.find((note) => note.index >= findings.length);
  if (missing) throw new Refusal(`the draft has no note ${missing.index + 1}; reload the page`);

  const gh = (deps.github ?? createGithub)(ctx);
  const pull = await gh.pull(repo, number);
  if (pull.state !== "open") throw new Refusal("the PR is no longer open");
  if (pull.head.sha !== sha) throw new Refusal("the PR has new commits since this draft was written; rerun the review");

  const files = new Map((await gh.patches(repo, number)).map((file) => [file.filename, rightLines(file.patch)]));
  const comments: ReviewComment[] = [];
  const loose: { file: string; line: string; text: string }[] = [];
  for (const note of req.notes) {
    const finding = findings[note.index]!;
    const at = place(finding, files);
    if (!at) {
      loose.push({ file: finding.file, line: finding.line, text: note.text });
      continue;
    }
    const range = at.start_line !== undefined ? { start_line: at.start_line, start_side: "RIGHT" as const } : {};
    comments.push({ path: at.path, line: at.line, side: "RIGHT", ...range, body: note.text.trim() });
  }
  const body = reviewBody(req.message, req.summary, loose);
  if (req.event !== "APPROVE" && body === "" && comments.length === 0) {
    throw new Refusal("there is nothing to post: tick a note or write a message");
  }

  const posted = await gh.review(repo, number, { commit_id: sha, event: req.event, body, comments });

  try {
    setDone(ctx, postedKey(req.key), true);
  } catch {
    // The review is on the PR whether or not the mark could be written.
  }
  // Which PR, what kind and how many: never the words.
  ctx.log("review-post", { key: `${repo}#${number}`, event: req.event.toLowerCase(), comments: comments.length, inBody: loose.length });

  const url = typeof posted.html_url === "string" && posted.html_url.startsWith(`https://${ctx.config.github.host}/`) ? posted.html_url : undefined;
  return { comments: comments.length, inBody: loose.length, ...(url ? { url } : {}) };
}
