import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tick } from "../cli/commands/tick.ts";
import type { Context, Source } from "../core/types.ts";
import { enrichOnDemand } from "../enrich/on-demand.ts";
import { renderSite } from "../render/site.ts";
import { createJobs } from "./jobs.ts";
import { type Timers, createLive } from "./live.ts";

const MAX_BODY = 10_000;
const MAX_FIELD = 300;
const TOKEN_PLACEHOLDER = "__DIVINATION_TOKEN__";

// The page is self-contained, so it may run its own inline code and talk to this server, and nothing else.
const PAGE_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'";

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
  "/api/live": "POST",
  "/api/tick": "POST",
  "/api/enrich": "POST",
};

/**
 * The local page server, as a function from request to response.
 *
 * It serves the page, owns the live-update timer, and is the only way a button press
 * reaches `enrichOnDemand`. It answers only requests addressed to its own loopback
 * address, and only acts on a POST that carries the token it put in the page.
 */
export function createApp(ctx: Context, sources: Source<any>[], token: string, timers?: Timers) {
  const jobs = createJobs(ctx.now);
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
        return {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "content-security-policy": PAGE_POLICY,
            "x-content-type-options": "nosniff",
          },
          body: readFileSync(ctx.paths.site, "utf8").replaceAll(TOKEN_PLACEHOLDER, token),
        };
      }

      case "/api/status":
        return json(200, status());

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
      res.end(out.body);
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(() => server.close()));
  });
}
