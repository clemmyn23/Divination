import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tick } from "../cli/commands/tick.ts";
import { DONE_KEY_MAX, setDone } from "../core/done.ts";
import { HttpError } from "../core/http.ts";
import { readEnvelope, transportOf } from "../core/pipeline.ts";
import type { Context, Source } from "../core/types.ts";
import { enrichOnDemand } from "../enrich/on-demand.ts";
import { pageHtml, renderSite } from "../render/site.ts";
import { sweepWorktrees } from "../sources/github/fix/git.ts";
import { type FixProgress, fixJob } from "../sources/github/fix/job.ts";
import { type fixOne, workRoot } from "../sources/github/fix/run.ts";
import { Refusal, parsePost, postReview } from "../sources/github/review/post.ts";
import { type ActivityUpdate, createActivity } from "./activity.ts";
import { createFeeder } from "./feed.ts";
import { createJobs } from "./jobs.ts";
import { type Timers, createLive } from "./live.ts";

const MAX_BODY = 10_000;
const MAX_FIELD = 300;
/** A review's notes are paragraphs, not fields: the one route that posts them takes a larger body. */
const REVIEW_PATH = "/api/review/post";
const MAX_REVIEW_BODY = 200_000;
const maxBody = (path: string) => (path === REVIEW_PATH ? MAX_REVIEW_BODY : MAX_BODY);
const ERROR_MAX = 300;
const TOKEN_PLACEHOLDER = "__DIVINATION_TOKEN__";
/** One of my PRs (`owner/repo#number`), or every fixable one. */
const FIX_KEY = /^(?:all|[\w.-]+\/[\w.-]+#\d{1,9})$/;

/**
 * The page is self-contained: it may run the one script it carries (named by its hash, so
 * nothing injected into the page could run), use its own inline styles and talk to this
 * server, and nothing else. It may not be shown inside a frame on another page.
 */
function pagePolicy(html: string): string {
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
  const hash = createHash("sha256").update(script).digest("base64");
  return `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${hash}'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

export interface AppRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
}

export interface AppResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /**
   * For an answer that stays open: called once the headers are sent, with a function that
   * writes to the page. It returns a function to call when the page goes away.
   */
  stream?: (write: (chunk: string) => void) => () => void;
}

/** One update in the form a page's EventSource reads. Only a whole line carries an id to resume from. */
function sseEvent(update: ActivityUpdate): string {
  if (update.type === "line") return `event: line\nid: ${update.line.id}\ndata: ${JSON.stringify(update.line)}\n\n`;
  return `event: more\ndata: ${JSON.stringify({ id: update.id, text: update.text })}\n\n`;
}

const json = (status: number, value: unknown): AppResponse => ({
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  body: JSON.stringify(value),
});
const refuse = (status: number, error: string) => json(status, { error });

const ROUTES: Record<string, "GET" | "POST"> = {
  "/": "GET",
  "/api/status": "GET",
  "/api/activity": "GET",
  "/api/activity/stream": "GET",
  "/api/live": "POST",
  "/api/tick": "POST",
  "/api/enrich": "POST",
  "/api/done": "POST",
  "/api/fix": "POST",
  "/api/fix/stop": "POST",
  [REVIEW_PATH]: "POST",
};

/**
 * The local page server, as a function from request to response.
 *
 * It serves the page, owns the live-update timer, and is the only way a button press
 * reaches an LLM: a sparkle button through `enrichOnDemand`, Refresh now through `feed`, a
 * Fix button through `fixJob`. Two buttons change something outside this machine, and
 * nothing else here does: a Fix button pushes a commit to one of my own PRs, and the Post
 * button in a drafted review's dialog posts that review to its PR. It answers only
 * requests addressed to its own loopback address, and only acts on a POST that carries the
 * token it put in the page.
 */
export function createApp(
  base: Context,
  sources: Source<any>[],
  token: string,
  timers?: Timers,
  deps: { fix?: typeof fixOne; post?: typeof postReview } = {},
) {
  // Everything the tool reports through `log` is also kept for the page's activity view.
  const activity = createActivity(
    base.now,
    sources.map((source) => {
      const envelope = readEnvelope(source, base);
      return {
        id: source.id,
        title: source.title,
        state: envelope.ok ? ("ok" as const) : ("failed" as const),
        at: envelope.collectedAt,
        ...(envelope.ok || !envelope.error ? {} : { error: envelope.error }),
        ...(transportOf(base.config, source.id) === "inbox" ? { byHand: true } : {}),
      };
    }),
  );
  const ctx: Context = {
    ...base,
    log(event, fields) {
      base.log(event, fields);
      activity.record(event, fields);
    },
  };

  const jobs = createJobs(ctx.now);
  // The fix that is running, if one is: which PR it is on, and whether a Fix all has been asked to stop.
  let fixing: FixProgress | null = null;
  let stopping = false;
  // Reviews on their way to GitHub. A post is not a job, but it is work in hand: a server
  // stopped in the middle of one would leave the page not knowing whether it went.
  let posting = 0;
  // A fix that was killed with the server leaves its worktree behind. Nothing waits on this.
  void sweepWorktrees(ctx.exec, Object.values(ctx.config.github.fix.clones), workRoot(ctx));
  const feed = createFeeder();
  const startedAt = ctx.now(); // changes on every restart, which tells an open page to reload
  const port = ctx.config.server.port;
  const ownHosts = [`127.0.0.1:${port}`, `localhost:${port}`];

  const live = createLive(
    ctx,
    () => {
      jobs.run("tick", () => tick(ctx, sources));
    },
    timers,
  );

  const status = () => ({
    ...live.state(),
    renderedAt: existsSync(ctx.paths.site) ? statSync(ctx.paths.site).mtimeMs : 0,
    startedAt,
    sources: activity.sources(),
    job: jobs.current(),
    lastJob: jobs.last(),
    fix: fixing ? { ...fixing, stopping } : null,
  });

  async function handle(req: AppRequest): Promise<AppResponse> {
    if (!ownHosts.includes(req.headers.host ?? "")) return refuse(403, "wrong host");

    const method = ROUTES[req.path];
    if (method === undefined) return refuse(404, "not found");
    if (req.method !== method) return refuse(405, "method not allowed");

    if (req.method === "POST") {
      if (token === "" || req.headers["x-divination-token"] !== token) return refuse(403, "missing or wrong token");
    }

    let body: unknown = {};
    if (req.method === "POST" && req.body !== "") {
      if (req.body.length > maxBody(req.path)) return refuse(400, "body too large");
      try {
        body = JSON.parse(req.body);
      } catch {
        return refuse(400, "body must be JSON");
      }
      if (typeof body !== "object" || body === null) return refuse(400, "body must be a JSON object");
    }
    const fields = body as Record<string, unknown>;

    switch (req.path) {
      case "/": {
        if (!existsSync(ctx.paths.site)) renderSite(ctx, sources);
        // Drawn afresh for each visit, so its date and what it calls stale are true now,
        // not when a refresh last ran. The page file is left alone: rewriting it here
        // would make every other open tab reload.
        const html = pageHtml(ctx, sources);
        return {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "content-security-policy": pagePolicy(html),
            "x-content-type-options": "nosniff",
            "x-frame-options": "DENY",
          },
          body: html.replaceAll(TOKEN_PLACEHOLDER, token),
        };
      }

      case "/api/status":
        return json(200, status());

      case "/api/activity":
        return json(200, { lines: activity.lines() });

      // The log as it is written: what has happened so far (or, for a page reconnecting,
      // what it missed), then every update until the page closes the connection.
      case "/api/activity/stream": {
        const seen = Number(req.headers["last-event-id"] ?? Number.NaN);
        return {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" },
          body: "",
          stream(write) {
            const send = (update: ActivityUpdate) => write(sseEvent(update));
            for (const line of Number.isFinite(seen) ? activity.linesAfter(seen) : activity.lines()) send({ type: "line", line });
            return activity.subscribe(send);
          },
        };
      }

      case "/api/live": {
        if (typeof fields.on !== "boolean") return refuse(400, '"on" must be true or false');
        if (fields.on) live.start();
        else live.pause();
        return json(200, status());
      }

      // Refresh now: the plain refresh first, then (only here, never on the timer, and only
      // with `claudeReads.onRefresh`) Claude reads the sources that are otherwise fed by hand.
      case "/api/tick": {
        const started = jobs.run("tick", async () => {
          await tick(ctx, sources, { force: true });
          const failures = await feed(ctx, sources);
          if (failures.length > 0) throw new Error(failures.join("; "));
        });
        return started ? json(202, status()) : refuse(409, "busy");
      }

      case "/api/done": {
        const { key, done } = fields;
        if (typeof key !== "string" || key === "" || key.length > DONE_KEY_MAX || typeof done !== "boolean") {
          return refuse(400, '"key" must be a short string and "done" true or false');
        }
        setDone(ctx, key, done);
        renderSite(ctx, sources); // the page file changes, so open pages reload and show it
        return json(200, status());
      }

      case "/api/enrich": {
        const { enricher, key, again } = fields;
        const valid = (v: unknown): v is string => typeof v === "string" && v !== "" && v.length <= MAX_FIELD;
        if (!valid(enricher) || !valid(key)) return refuse(400, '"enricher" and "key" must be short strings');
        // A rerun button: send the item to Claude even though it has an answer already.
        if (again !== undefined && typeof again !== "boolean") return refuse(400, '"again" must be true or false');
        const started = jobs.run(`enrich:${enricher}:${key}`, async () => {
          await enrichOnDemand(ctx, sources, enricher, key, { again: again === true });
          renderSite(ctx, sources);
        });
        return started ? json(202, status()) : refuse(409, "busy");
      }

      // The Fix button: Claude edits files in a throwaway worktree and this tool pushes the
      // result to that PR's branch. Like enrich, nothing but a press reaches it.
      case "/api/fix": {
        const { key } = fields;
        if (typeof key !== "string" || key.length > MAX_FIELD || !FIX_KEY.test(key)) return refuse(400, '"key" must be a PR, as owner/repo#number, or "all"');
        const started = jobs.run(`fix:${key}`, async () => {
          try {
            await fixJob(ctx, sources, key, {
              shouldStop: () => stopping,
              onProgress: (progress) => {
                fixing = progress;
              },
              ...(deps.fix ? { fix: deps.fix } : {}),
            });
          } finally {
            fixing = null;
            stopping = false;
          }
        });
        return started ? json(202, status()) : refuse(409, "busy");
      }

      // Stop a Fix all after the PR it is on. The one route that acts while a job runs; a
      // fix in hand is never cut short.
      case "/api/fix/stop": {
        if (jobs.current()?.name !== "fix:all") return refuse(409, "nothing to stop");
        stopping = true;
        return json(200, status());
      }

      // The Post button in a drafted review's dialog: the ticked notes go to the PR as one
      // review, under my name. Nothing but that press reaches this, and no LLM is involved.
      // It is answered when GitHub has answered, and is not a job: it does not wait for a
      // refresh that happens to be running.
      case REVIEW_PATH: {
        const request = parsePost(fields);
        if (typeof request === "string") return refuse(400, request);
        let posted: Awaited<ReturnType<typeof postReview>>;
        posting++;
        try {
          posted = await (deps.post ?? postReview)(ctx, request);
        } catch (e) {
          const error = (e instanceof Error ? e.message : String(e)).slice(0, ERROR_MAX);
          if (e instanceof Refusal) return refuse(409, error);
          // GitHub's answer is shown in the dialog. The log gets only its status: an answer
          // may quote what it was sent, and a review's words are never logged.
          try {
            ctx.log("review-post-failed", { key: request.key.split("@")[0], error: e instanceof HttpError ? `GitHub answered ${e.status}` : error });
          } catch {
            // The log could not be written; the answer below says what happened.
          }
          return refuse(502, error);
        } finally {
          posting--;
        }
        // The review is on the PR. A page that cannot be redrawn must not turn that into a
        // failure, which would invite a second press and a second review.
        try {
          renderSite(ctx, sources); // the page file changes, so open pages show that it was posted
        } catch {
          // The next refresh redraws it.
        }
        return json(200, posted);
      }
    }
    return refuse(404, "not found");
  }

  /** Whether anything is in hand that a restart should wait for: a job, or a review being posted. */
  const busy = () => jobs.current() !== null || posting > 0;

  return { handle, live, status, busy };
}

/** Put the app on `127.0.0.1` only. Resolves once it is listening. */
export function listen(app: { handle(req: AppRequest): Promise<AppResponse> }, port: number): Promise<() => void> {
  const server = createServer((req, res) => {
    let body = "";
    let tooLarge = false;
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      if (body.length + chunk.length > maxBody((req.url ?? "/").split("?")[0]!)) tooLarge = true;
      else body += chunk;
    });
    req.on("end", async () => {
      let out: AppResponse;
      try {
        out = await app.handle({
          method: req.method ?? "GET",
          path: (req.url ?? "/").split("?")[0]!,
          headers: req.headers as Record<string, string | undefined>,
          body: tooLarge ? "x".repeat(MAX_REVIEW_BODY + 1) : body,
        });
      } catch (e) {
        out = refuse(500, e instanceof Error ? e.message : String(e));
      }
      res.writeHead(out.status, out.headers);
      if (out.stream === undefined) {
        res.end(out.body);
        return;
      }
      res.flushHeaders(); // the page should know it is connected before there is anything to say
      const stop = out.stream((chunk) => res.write(chunk));
      res.on("close", stop);
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(() => server.close()));
  });
}
