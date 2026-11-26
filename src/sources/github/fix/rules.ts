import { matchesGlob } from "node:path";

// The rules of a PR fix that need nothing but their arguments.

/** The TeamCity build a failing status links to: the last part of the link, when it is a number. */
export function buildIdOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return undefined;
  }
  const last = path.split("/").filter(Boolean).at(-1) ?? "";
  return /^\d+$/.test(last) ? last : undefined;
}

const LOG_MAX_BYTES = 60_000;
const LINE_MAX_BYTES = 1000;
const TAIL_LINES = 200;
const AROUND = 2;
const GAP = "…";
const FAILURE = /error|fail|exception|\[ERR\]/i;

const bytes = (text: string) => Buffer.byteLength(text);

/** As much of the start of a line as fits, never ending in half a character. */
function clip(line: string, max: number): string {
  if (bytes(line) <= max) return line;
  let out = "";
  let used = 0;
  for (const char of line) {
    used += bytes(char);
    if (used > max) break;
    out += char;
  }
  return out;
}

/**
 * A build log cut to what a fix needs: the lines that look like failures with two either
 * side, and the last 200 lines, in their original order with each gap marked. A log that
 * already fits is kept whole. The tail may use half the room; failure lines, from the
 * first, get the rest.
 */
export function cutLog(text: string, maxBytes: number = LOG_MAX_BYTES): string {
  if (bytes(text) <= maxBytes) return text;

  const lines = text.split("\n").map((line) => clip(line, Math.min(LINE_MAX_BYTES, maxBytes)));
  // What a kept line costs: itself, its line break, and a gap marker it may sit behind.
  const cost = (i: number) => bytes(lines[i]!) + 1 + bytes(GAP) + 1;

  const keep = new Set<number>();
  let used = 0;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - TAIL_LINES); i--) {
    if (used + cost(i) > maxBytes / 2) break;
    keep.add(i);
    used += cost(i);
  }

  const wanted = new Set<number>();
  lines.forEach((line, i) => {
    if (!FAILURE.test(line)) return;
    for (let j = Math.max(0, i - AROUND); j <= Math.min(lines.length - 1, i + AROUND); j++) wanted.add(j);
  });
  for (const i of [...wanted].sort((a, b) => a - b)) {
    if (keep.has(i)) continue;
    if (used + cost(i) > maxBytes) break;
    keep.add(i);
    used += cost(i);
  }

  const out: string[] = [];
  let previous = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i !== previous + 1) out.push(GAP);
    out.push(lines[i]!);
    previous = i;
  }
  return out.join("\n");
}

const TICKET = /^[A-Z][A-Z0-9]+-\d+/;
const NAMED_CHECKS = 3;
const SUMMARY_MAX = 500;

/**
 * The message of a fix's commit. The code writes it; Claude supplies only the summary,
 * which is flattened to one paragraph so nothing in it can pass for a second header.
 */
export function commitMessage(
  what: "ci" | "conflicts",
  pr: { title: string; headRef: string; baseRef: string },
  checks: string[],
  summary: string,
): string {
  let subject: string;
  if (what === "conflicts") subject = `Merge ${pr.baseRef} into ${pr.headRef}`;
  else {
    const named = checks.slice(0, NAMED_CHECKS).join(", ") || "CI";
    const more = checks.length > NAMED_CHECKS ? ` and ${checks.length - NAMED_CHECKS} more` : "";
    const ticket = TICKET.exec(pr.title)?.[0];
    subject = ticket ? `${ticket}: fix ${named}${more}` : `Fix ${named}${more}`;
  }
  const body = summary.replace(/\s+/g, " ").trim().slice(0, SUMMARY_MAX).trim();
  return body ? `${subject}\n\n${body}` : subject;
}

/**
 * The first of the paths that matches one of the patterns a fix may never touch. A pattern
 * ending in `/**` is a folder and covers everything under it, whatever it is called: a
 * glob alone lets dot files and dot folders through.
 */
export function touched(paths: string[], patterns: string[]): string | undefined {
  const covers = (pattern: string, path: string) => (pattern.endsWith("/**") && path.startsWith(pattern.slice(0, -2))) || matchesGlob(path, pattern);
  return paths.find((path) => patterns.some((pattern) => covers(pattern, path)));
}

/** Whether a clone's `origin` address points at this repository on this host, in any form git writes it. */
export function originIs(url: string, host: string, repo: string): boolean {
  let foundHost: string;
  let path: string;
  if (url.includes("://")) {
    try {
      const parsed = new URL(url);
      foundHost = parsed.hostname;
      path = parsed.pathname;
    } catch {
      return false;
    }
  } else {
    // The short form: git@host:owner/repo.git
    const short = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(url.trim());
    if (!short) return false;
    foundHost = short[1]!;
    path = short[2]!;
  }
  const found = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
  return foundHost.toLowerCase() === host.toLowerCase() && found.toLowerCase() === repo.toLowerCase();
}

/** How many attempts a PR has had, in the words used at the limit: "tried twice". */
export const tried = (times: number): string => `tried ${times === 1 ? "once" : times === 2 ? "twice" : `${times} times`}, over to you`;

/** A folder name for a PR's worktree: `acme/monolith#501` becomes `acme-monolith-501`. */
export function worktreeName(key: string): string {
  return key
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replaceAll("..", "")
    .replace(/^[.-]+/, "");
}
