import { readJson, writeJson } from "../../core/store.ts";
import type { Context } from "../../core/types.ts";
import { classifyRequest } from "./classify.ts";
import { type Github, createGithub } from "./client.ts";
import { lastWord, reviewState, sortMine, unanswered, waitsOn } from "./mine.ts";
import { rankPull, sortPulls } from "./rank.ts";
import { findSignal, reviewPosts } from "./slack-signal.ts";
import type { CheckRun, Ci, CombinedStatus, Facts, GithubData, MyFacts, MyPull, PullRequest, QueueHit } from "./types.ts";

const AT_ONCE = 5;
const FAILED_RUNS = ["failure", "timed_out", "cancelled"];

/** One CI word from a commit's check runs and its combined status. */
export function ciState(runs: CheckRun[], combined: CombinedStatus): Ci {
  if (runs.some((r) => FAILED_RUNS.includes(r.conclusion ?? ""))) return "fail";
  if (combined.state === "failure" || combined.state === "error") return "fail";
  if (runs.some((r) => r.status !== "completed")) return "pending";
  if (combined.state === "pending" && combined.total_count > 0) return "pending";
  if (runs.length > 0 || combined.total_count > 0) return "pass";
  return "none";
}

/** Run `fn` over the items a few at a time, keeping their order. */
async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

async function fetchFacts(gh: Github, hit: QueueHit, login: string): Promise<Facts> {
  const [pull, paths, requests, reviews] = await Promise.all([
    gh.pull(hit.repo, hit.number),
    gh.files(hit.repo, hit.number),
    gh.timeline(hit.repo, hit.number),
    gh.reviews(hit.repo, hit.number),
  ]);
  return {
    updatedAt: hit.updatedAt,
    headSha: pull.head.sha,
    additions: pull.additions,
    deletions: pull.deletions,
    changedFiles: pull.changed_files,
    paths,
    requests,
    reviewedByMeAtHead: reviews.some((r) => r.user?.login === login && r.commit_id === pull.head.sha),
  };
}

async function fetchMyFacts(gh: Github, hit: QueueHit, headSha: string): Promise<MyFacts> {
  const [reviews, comments, pushedAt] = await Promise.all([
    gh.reviews(hit.repo, hit.number),
    gh.comments(hit.repo, hit.number),
    gh.committedAt(hit.repo, headSha),
  ]);
  // A review nobody has submitted yet has no time and is nobody's word.
  const submitted = reviews.flatMap((r) => {
    const at = Date.parse(r.submitted_at ?? "");
    return Number.isFinite(at) ? [{ login: r.user?.login ?? "unknown", bot: r.user?.type === "Bot", state: r.state, at }] : [];
  });
  return {
    updatedAt: hit.updatedAt,
    headSha,
    pushedAt,
    verdicts: submitted.map(({ login, state, at }) => ({ login, state, at })),
    said: [
      ...comments.map((c) => ({ login: c.user?.login ?? "unknown", bot: c.user?.type === "Bot", at: Date.parse(c.created_at) })),
      // A comment on a line of code, and a reply to one, each arrive as a review that only comments.
      ...submitted.filter((r) => r.state === "COMMENTED").map(({ login, bot, at }) => ({ login, bot, at })),
    ],
  };
}

/**
 * My own open PRs, each with what it is waiting on. What was said on a PR is cached and
 * only fetched again when its `updated_at` or its head commit moves; whether it conflicts
 * and its CI are asked for every time, because neither moves `updated_at`.
 */
async function collectMine(gh: Github, ctx: Context, login: string): Promise<MyPull[]> {
  const hits = await gh.mine(login);
  const ignore = ctx.config.github.mine.ignoreCommenters;

  const cachePath = ctx.paths.cache("github", "mine.json");
  const cached = readJson<Record<string, MyFacts>>(cachePath, {});
  const kept: Record<string, MyFacts> = {};

  const prs = await inBatches(hits, AT_ONCE, async (hit): Promise<MyPull> => {
    const pull = await gh.pull(hit.repo, hit.number);
    const headSha = pull.head.sha;
    const known = cached[hit.key];
    const fresh = known && known.updatedAt === hit.updatedAt && known.headSha === headSha;
    const [facts, { runs, combined }] = await Promise.all([fresh ? known : fetchMyFacts(gh, hit, headSha), gh.ci(hit.repo, headSha)]);
    kept[hit.key] = facts;

    const ci = ciState(runs, combined);
    const review = reviewState(facts.verdicts, login);
    const conflicts = pull.mergeable === false;
    const count = unanswered(facts.said, login, facts.pushedAt, ignore);
    return {
      key: hit.key,
      repo: hit.repo,
      number: hit.number,
      title: hit.title,
      url: hit.url,
      headSha,
      createdAt: hit.createdAt,
      updatedAt: hit.updatedAt,
      draft: hit.draft,
      additions: pull.additions,
      deletions: pull.deletions,
      ci,
      review: review.state,
      conflicts,
      unanswered: count,
      waits: waitsOn({
        draft: hit.draft,
        ci,
        review: review.state,
        reviewAnswered: lastWord(facts.said, login, facts.pushedAt) > review.at,
        conflicts,
        blocked: pull.mergeable_state === "blocked",
        unanswered: count,
      }),
    };
  });

  writeJson(cachePath, kept);
  return sortMine(prs);
}

/**
 * The open PRs waiting on my review, tagged, ranked and sorted. Facts are cached per PR
 * and only fetched again when the PR's `updated_at` moves; CI is asked for every time.
 */
export async function collectGithub(ctx: Context): Promise<GithubData> {
  const gh = createGithub(ctx);
  const login = await gh.login();
  const hits = await gh.queue(login);

  // What the review channel says about each PR, read once for the whole queue.
  const review = await reviewPosts(ctx);
  // With no crew configured all three are empty: no rotation picks, no crew members, no signals.
  const { rotationTeam, members, reviewChannel } = ctx.config.github.crew;
  const { skipReactions } = reviewChannel;
  const crew = new Set(members.map((name) => name.toLowerCase()));

  const cachePath = ctx.paths.cache("github", "facts.json");
  const cached = readJson<Record<string, Facts>>(cachePath, {});
  const kept: Record<string, Facts> = {};

  const prs = await inBatches(hits, AT_ONCE, async (hit): Promise<PullRequest> => {
    const known = cached[hit.key];
    const facts = known && known.updatedAt === hit.updatedAt ? known : await fetchFacts(gh, hit, login);
    kept[hit.key] = facts;

    const { runs, combined } = await gh.ci(hit.repo, facts.headSha);
    const signal = findSignal(hit.url, review.posts, ctx.config.slack.userId, skipReactions, review.names, review.linkFor);

    const pr: Omit<PullRequest, "rank"> = {
      key: hit.key,
      repo: hit.repo,
      number: hit.number,
      title: hit.title,
      url: hit.url,
      author: hit.author,
      headSha: facts.headSha,
      createdAt: hit.createdAt,
      updatedAt: hit.updatedAt,
      draft: hit.draft,
      additions: facts.additions,
      deletions: facts.deletions,
      changedFiles: facts.changedFiles,
      paths: facts.paths,
      ci: ciState(runs, combined),
      request: classifyRequest(facts.requests, login, rotationTeam),
      reviewedByMeAtHead: facts.reviewedByMeAtHead,
      ...(signal ? { signal } : {}),
      ...(crew.has(hit.author.toLowerCase()) ? { byCrew: true } : {}),
    };
    return { ...pr, rank: rankPull(pr, ctx.config.github.rank, login, ctx.now()) };
  });

  writeJson(cachePath, kept);
  return { login, prs: sortPulls(prs), mine: await collectMine(gh, ctx, login) };
}
