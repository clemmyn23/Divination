import type { Context } from "../../core/types.ts";
import type { CheckRun, CombinedStatus, QueueHit, TimelineEvent } from "./types.ts";

const MAX_FILES = 300;
const QUEUE_LIMIT = 50;

interface SearchItem {
  number: number;
  title: string;
  html_url: string;
  repository_url: string;
  created_at: string;
  updated_at: string;
  draft?: boolean;
  user?: { login: string };
}

export interface PullDetail {
  additions: number;
  deletions: number;
  changed_files: number;
  /** "open" or "closed". */
  state?: string;
  draft?: boolean;
  user?: { login: string };
  /** `repo` is null when the PR came from a fork that has since been deleted. */
  head: { sha: string; ref?: string; repo?: { full_name: string } | null };
  base?: { ref: string; repo?: { full_name: string } };
  /** False when it conflicts with its base; null until GitHub has worked it out. */
  mergeable?: boolean | null;
  /** "blocked" when something required is missing: an approval, a required check. */
  mergeable_state?: string;
}

/** "Bot" for an app's account; a person, or a machine user signed up as one, is "User". */
interface Account {
  login: string;
  type?: string;
}

export interface Review {
  user?: Account;
  commit_id?: string;
  state: string;
  /** Missing on a review that has not been submitted yet. */
  submitted_at?: string;
}

export interface IssueComment {
  user?: Account;
  created_at: string;
}

/** The URL marked `rel="next"` in a Link header, if any. */
function nextLink(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) return match[1];
  }
  return undefined;
}

/**
 * A read-only client for the GitHub REST API on the configured host. The token comes
 * from the `gh` CLI, is asked for once, and is only ever sent to that host.
 */
export function createGithub(ctx: Context) {
  const host = ctx.config.github.host;
  if (!host) throw new Error("github.host is not set in config/local.yaml");
  const origin = `https://${host}/`;
  const base = `${origin}api/v3`;

  let token: Promise<string> | undefined;
  const getToken = () =>
    (token ??= (async () => {
      const res = await ctx.exec("gh", ["auth", "token", "--hostname", host]);
      const value = res.stdout.trim();
      if (res.code !== 0 || !value) throw new Error(`gh is not logged in to ${host}`);
      return value;
    })());

  async function get<T>(pathOrUrl: string) {
    const url = pathOrUrl.startsWith("https://") ? pathOrUrl : base + pathOrUrl;
    return ctx.http.json<T>(url, {
      headers: { authorization: `Bearer ${await getToken()}`, accept: "application/vnd.github+json" },
    });
  }

  /** Follow `rel="next"` links on the same host until there are no more, or `limit` items are in hand. */
  async function paged<T>(path: string, limit: number): Promise<T[]> {
    const all: T[] = [];
    let next: string | undefined = path;
    while (next !== undefined && all.length < limit) {
      const res: { data: T[]; headers: Headers } = await get<T[]>(next);
      all.push(...res.data);
      const link = nextLink(res.headers.get("link"));
      next = link !== undefined && link.startsWith(origin) ? link : undefined;
    }
    return all.slice(0, limit);
  }

  /** Open PRs matching the search, as the API orders them. */
  async function search(query: string): Promise<QueueHit[]> {
    const q = encodeURIComponent(`is:open is:pr ${query} archived:false`);
    const { data } = await get<{ items: SearchItem[] }>(`/search/issues?q=${q}&per_page=${QUEUE_LIMIT}`);
    return data.items.map((item) => {
      const repo = item.repository_url.split("/").slice(-2).join("/");
      return {
        key: `${repo}#${item.number}`,
        repo,
        number: item.number,
        title: item.title,
        url: item.html_url,
        author: item.user?.login ?? "unknown",
        draft: item.draft === true,
        createdAt: Date.parse(item.created_at),
        updatedAt: Date.parse(item.updated_at),
      };
    });
  }

  return {
    host,

    async login(): Promise<string> {
      return (await get<{ login: string }>("/user")).data.login;
    },

    /** Open PRs where a review is requested from `login`. */
    queue: (login: string) => search(`review-requested:${login}`),

    /** Open PRs that `login` raised. */
    mine: (login: string) => search(`author:${login}`),

    async pull(repo: string, number: number): Promise<PullDetail> {
      return (await get<PullDetail>(`/repos/${repo}/pulls/${number}`)).data;
    },

    async files(repo: string, number: number): Promise<string[]> {
      const files = await paged<{ filename: string }>(`/repos/${repo}/pulls/${number}/files?per_page=100`, MAX_FILES);
      return files.map((f) => f.filename);
    },

    async ci(repo: string, sha: string): Promise<{ runs: CheckRun[]; combined: CombinedStatus }> {
      const [runs, combined] = await Promise.all([
        get<{ check_runs: CheckRun[] }>(`/repos/${repo}/commits/${sha}/check-runs`),
        get<CombinedStatus>(`/repos/${repo}/commits/${sha}/status`),
      ]);
      return { runs: runs.data.check_runs ?? [], combined: combined.data };
    },

    /** The PR's `review_requested` events, oldest first. */
    async timeline(repo: string, number: number): Promise<TimelineEvent[]> {
      const events = await paged<TimelineEvent>(`/repos/${repo}/issues/${number}/timeline?per_page=100`, 1000);
      return events
        .filter((e) => e.event === "review_requested")
        .map((e) => ({
          event: e.event,
          created_at: e.created_at,
          ...(e.actor ? { actor: { login: e.actor.login } } : {}),
          ...(e.requested_team ? { requested_team: { slug: e.requested_team.slug } } : {}),
          ...(e.requested_reviewer ? { requested_reviewer: { login: e.requested_reviewer.login } } : {}),
        }));
    },

    async reviews(repo: string, number: number): Promise<Review[]> {
      return paged<Review>(`/repos/${repo}/pulls/${number}/reviews?per_page=100`, 500);
    },

    /** The comments on the PR's conversation. Comments on lines of code arrive as reviews instead. */
    async comments(repo: string, number: number): Promise<IssueComment[]> {
      return paged<IssueComment>(`/repos/${repo}/issues/${number}/comments?per_page=100`, 500);
    },

    /** When the commit was made. A rebase or an amend moves it, so for a head commit it stands for the last push. */
    async committedAt(repo: string, sha: string): Promise<number> {
      const { data } = await get<{ commit: { committer?: { date?: string } } }>(`/repos/${repo}/commits/${sha}`);
      return Date.parse(data.commit.committer?.date ?? "") || 0;
    },
  };
}

export type Github = ReturnType<typeof createGithub>;
