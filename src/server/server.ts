import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tick } from "../cli/commands/tick.ts";
import { DONE_KEY_MAX, setDone } from "../core/done.ts";
import { readEnvelope, transportOf } from "../core/pipeline.ts";
import type { Context, Source } from "../core/types.ts";
import { enrichOnDemand } from "../enrich/on-demand.ts";
import { pageHtml, renderSite } from "../render/site.ts";
import { type ActivityUpdate, createActivity } from "./activity.ts";
import { createJobs } from "./jobs.ts";
import { type Timers, createLive } from "./live.ts";

const MAX_BODY = 10_000;
const MAX_FIELD = 300;
const TOKEN_PLACEHOLDER = "__DIVINATION_TOKEN__";

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
};

/**
 * The local page server, as a function from request to response.
 *
 * It serves the page, owns the live-update timer, and is the only way a button press
 * reaches `enrichOnDemand`. It answers only requests addressed to its own loopback
 * address, and only acts on a POST that carries the token it put in the page.
 */
export function createApp(base: Context, sources: Source<any>[], token: string, timers?: Timers) {
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
      if (req.body.length > MAX_BODY) return refuse(400, "body too large");
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

      case "/api/tick": {
        const started = jobs.run("tick", () => tick(ctx, sources, { force: true }));
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
        const { enricher, key } = fields;
        const valid = (v: unknown): v is string => typeof v === "string" && v !== "" && v.length <= MAX_FIELD;
        if (!valid(enricher) || !valid(key)) return refuse(400, '"enricher" and "key" must be short strings');
        const started = jobs.run(`enrich:${enricher}:${key}`, async () => {
          await enrichOnDemand(ctx, sources, enricher, key);
          renderSite(ctx, sources);
        });
        return started ? json(202, status()) : refuse(409, "busy");
      }
    }
    return refuse(404, "not found");
  }

  return { handle, live, status };
}

/** Put the app on `127.0.0.1` only. Resolves once it is listening. */
export function listen(app: { handle(req: AppRequest): Promise<AppResponse> }, port: number): Promise<() => void> {
  const server = createServer((req, res) => {
    let body = "";
    let tooLarge = false;
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      if (body.length + chunk.length > MAX_BODY) tooLarge = true;
      else body += chunk;
    });
    req.on("end", async () => {
      let out: AppResponse;
      try {
        out = await app.handle({
          method: req.method ?? "GET",
          path: (req.url ?? "/").split("?")[0]!,
          headers: req.headers as Record<string, string | undefined>,
          body: tooLarge ? "x".repeat(MAX_BODY + 1) : body,
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
