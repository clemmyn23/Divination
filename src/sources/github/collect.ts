import { readJson, writeJson } from "../../core/store.ts";
import type { Context } from "../../core/types.ts";
import { classifyRequest } from "./classify.ts";
import { type Github, createGithub } from "./client.ts";
import { rankPull, sortPulls } from "./rank.ts";
import { findSignal, reviewPosts } from "./slack-signal.ts";
import type { CheckRun, Ci, CombinedStatus, Facts, GithubData, PullRequest, QueueHit } from "./types.ts";

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
  const { skipReactions } = ctx.config.github.slackSignal;

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
      request: classifyRequest(facts.requests, login, ctx.config.github.rotationTeam),
      reviewedByMeAtHead: facts.reviewedByMeAtHead,
      ...(signal ? { signal } : {}),
    };
    return { ...pr, rank: rankPull(pr, ctx.config.github.rank, login, ctx.now()) };
  });

  writeJson(cachePath, kept);
  return { login, prs: sortPulls(prs) };
}
