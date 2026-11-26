// Where a review's notes go: on a line of the PR's diff when they can, and in the review's
// overall comment when they cannot. GitHub rejects a whole review if one of its comments
// names a line that is not in the diff, so nothing is placed on trust.

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * The lines of the new file that a comment can sit on, each with the number of the hunk
 * it is in: the context lines and the added lines of a file's patch. A file with no
 * patch (a binary file, or one too large for GitHub to show) has none.
 */
export function rightLines(patch: string | undefined): Map<number, number> {
  const lines = new Map<number, number>();
  if (!patch) return lines;
  let hunk = -1;
  let next = 0;
  const rows = patch.split("\n");
  rows.forEach((row, i) => {
    const header = HUNK.exec(row);
    if (header) {
      hunk++;
      next = Number(header[1]);
      return;
    }
    if (hunk < 0) return;
    // A blank context line is a single space, but one that arrives with the space stripped
    // is still a line: skipping it would put every later comment one line too high. Only
    // the empty row after the patch's last line break is nothing.
    const blank = row === "" && i < rows.length - 1;
    if (row.startsWith("+") || row.startsWith(" ") || blank) lines.set(next++, hunk);
    // A removed line and the "no newline" marker are not lines of the new file.
  });
  return lines;
}

/** A note's line as written in a draft (`42`, `42-48`, `L42–L48`): its first and last whole number, in order. */
export function lineRange(text: string): { start: number; end: number } | undefined {
  const numbers = (text.match(/\d+/g) ?? []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
  if (numbers.length === 0) return undefined;
  const first = numbers[0]!;
  const last = numbers.at(-1)!;
  return { start: Math.min(first, last), end: Math.max(first, last) };
}

/** A comment's place in the new file. `start_line` is there only for a comment on several lines. */
export interface Placed {
  path: string;
  line: number;
  start_line?: number;
}

/**
 * Where a note can be placed, if anywhere: on its whole range when that lies in one hunk,
 * else on its last line, else on its first. `files` maps each file in the PR to its
 * `rightLines`.
 */
export function place(note: { file: string; line: string }, files: Map<string, Map<number, number>>): Placed | undefined {
  const lines = files.get(note.file);
  const range = lineRange(note.line);
  if (!lines || !range) return undefined;
  const startHunk = lines.get(range.start);
  const endHunk = lines.get(range.end);
  if (endHunk !== undefined) {
    const whole = range.start !== range.end && startHunk === endHunk;
    return { path: note.file, line: range.end, ...(whole ? { start_line: range.start } : {}) };
  }
  if (startHunk !== undefined) return { path: note.file, line: range.start };
  return undefined;
}

/**
 * The review's overall comment: my own message first, then the draft's summary if it was
 * ticked, then each ticked note that has no line to sit on, under its file and line.
 */
export function reviewBody(message: string, summary: string | undefined, loose: { file: string; line: string; text: string }[]): string {
  const label = (note: { file: string; line: string }) => `**\`${`${note.file}:${note.line}`.replaceAll("`", "'")}\`**`;
  return [message, summary ?? "", ...loose.map((note) => `${label(note)}\n\n${note.text.trim()}`)]
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join("\n\n");
}
