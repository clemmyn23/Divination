import type { Http } from "./types.ts";

const MAX_RETRIES = 3;
const BODY_LIMIT = 200;

/** A non-2xx answer. It never carries request headers, so a token cannot leak through it. */
export class HttpError extends Error {
  status: number;
  url: string;
  body: string;

  constructor(status: number, url: string, body: string) {
    super(`HTTP ${status} from ${url}${body ? `: ${body}` : ""}`);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A small JSON client. A 429 waits for `Retry-After` (one second if absent) and tries
 * again, up to three retries. Anything else outside 2xx is an HttpError.
 */
export function createHttp(fetchImpl: typeof fetch = fetch, sleep: (ms: number) => Promise<void> = realSleep): Http {
  return {
    async json<T>(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
      for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
          res = await fetchImpl(url, { method: init.method ?? "GET", headers: init.headers, body: init.body });
        } catch (e) {
          throw new Error(`cannot reach ${hostOf(url)}: ${(e as Error).message}`);
        }

        if (res.status === 429 && attempt < MAX_RETRIES) {
          const seconds = Number(res.headers.get("retry-after"));
          await sleep((Number.isFinite(seconds) && seconds > 0 ? seconds : 1) * 1000);
          continue;
        }
        if (!res.ok) {
          const body = (await res.text().catch(() => "")).slice(0, BODY_LIMIT);
          throw new HttpError(res.status, url, body);
        }

        const text = await res.text();
        try {
          return { data: JSON.parse(text) as T, headers: res.headers };
        } catch {
          throw new HttpError(res.status, url, "response was not JSON");
        }
      }
    },
  };
}
