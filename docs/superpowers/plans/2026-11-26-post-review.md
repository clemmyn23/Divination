# Posting a drafted review: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open a drafted review in a dialog, tick and edit its notes, and post the ticked ones to the PR as one review.

**Architecture:** Pure rules place notes on diff lines and build the overall comment. One function posts a review through the GitHub client. A synchronous route calls it. The panel renders a dialog per draft; the page script drives it.

**Tech Stack:** Node 24 running TypeScript, `node:test`, no new dependency.

**Spec:** `docs/superpowers/specs/2026-11-26-post-review-design.md`

## Global Constraints

- Nothing posts without `POST /api/review/post`. File and line come from the stored draft only.
- Comment text never reaches `ctx.log`.
- Invented names only in tests and docs (`o/r`, `acme/monolith`).
- Each task: tests first, watched failing. `pnpm test` and `pnpm typecheck` green at each commit. No co-author line.

## Review Focus

- A note whose line is not in the diff, or whose file has no patch: it must land in the overall comment, never sink the post.
- A PR that moved or closed since the draft: refused before anything is sent.
- Note text holding `<`, `&`, quotes or `</textarea>`: drawn escaped in the dialog.
- The page reloading itself while a dialog is open: ticks and edits must survive.
- A request naming a note index that is out of range, repeated, or not an integer.

---

### Task 1: Placing notes on the diff

**Files:** Create `src/sources/github/review/anchor.ts`, `src/sources/github/review/anchor.test.ts`

**Interfaces (produces):**
- `rightLines(patch: string | undefined): Map<number, number>`: new-file line → hunk index, for context and added lines.
- `lineRange(text: string): { start: number; end: number } | undefined`: first and last whole number in the text, ordered.
- `interface Placed { path: string; line: number; start_line?: number }`
- `place(note: { file: string; line: string }, files: Map<string, Map<number, number>>): Placed | undefined`: end line, else start line; `start_line` only when both are in one hunk and differ.
- `reviewBody(message: string, summary: string | undefined, loose: { file: string; line: string; text: string }[]): string`: parts joined by a blank line; a loose note is `` **`file:line`** `` then its text.

- [ ] Tests: hunks with context, added and removed lines; two hunks; no patch; `42`, `42-48`, `L42–L48`, `48-42`, no number; range across hunks falls back to the end line; file not in the diff; body with every combination of parts, trimmed, empty when nothing.
- [ ] Run, see fail. Implement. Run, see pass. Commit `feat: place review notes on a PR's diff`.

### Task 2: The GitHub client can read patches and post a review

**Files:** Modify `src/sources/github/client.ts`, `test/helpers.ts` (`fakeHttp` gains `sent: { url; method; body? }[]`); Test `src/sources/github/client.test.ts` (create if missing)

**Interfaces (produces):**
- `patches(repo, number): Promise<{ filename: string; patch?: string }[]>` (paged, at most 3000).
- `review(repo, number, review: { commit_id: string; event: string; body: string; comments: { path: string; line: number; side: "RIGHT"; start_line?: number; start_side?: "RIGHT"; body: string }[] }): Promise<{ html_url?: string }>`: one POST to `/repos/{repo}/pulls/{number}/reviews`, JSON body, same auth headers plus `content-type`.

- [ ] Tests: `review` sends one POST to that path on the configured host with the JSON body; `patches` follows pages. Run, fail, implement, pass. Commit `feat: the GitHub client can post a review`.

### Task 3: Posting a review

**Files:** Create `src/sources/github/review/post.ts`, `src/sources/github/review/post.test.ts`

**Interfaces (produces):**
- `type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES"`
- `interface PostRequest { key: string; event: ReviewEvent; message: string; summary?: string; notes: { index: number; text: string }[] }`
- `parsePost(fields: Record<string, unknown>): PostRequest | string` (a string is what is wrong). Limits: texts ≤ 10 000 chars, ≤ 100 notes, indices whole, ≥ 0 and unique, note text not blank.
- `class Refusal extends Error`: thrown when nothing was sent.
- `postedKey(reviewKey: string): string` → `posted:<reviewKey>`.
- `postReview(ctx, req, deps?: { github?: (ctx) => Github }): Promise<{ comments: number; inBody: number; url?: string }>`

Order: key shape → draft in cache (`cacheGet(ctx, "pr-review", hashOf(key))`) → indices in range → `pull` open and `head.sha` equal → `patches` → place → nothing-to-say check (not for APPROVE) → `review` → `setDone(ctx, postedKey(key), true)` → `ctx.log("review-post", { key: "o/r#1", event, comments, inBody })`.

- [ ] Tests: happy path body and comments; loose note in body; each refusal sends nothing; bare approval allowed; GitHub's error surfaces and nothing is marked; the log holds no text; `parsePost` cases.
- [ ] Run, fail, implement, pass. Commit `feat: post a drafted review`.

### Task 4: The route

**Files:** Modify `src/server/server.ts`, `src/server/activity.ts`; Test `src/server/server.test.ts`, `src/server/activity.test.ts`

- Route `POST /api/review/post`; `createApp` deps gain `post?: typeof postReview`. Body cap for this path 200 000, others unchanged, in both `handle` and `listen`. `400` from `parsePost`, `409` for `Refusal`, `502` otherwise; on success `renderSite` and `200 { comments, inBody, url }`.
- Activity line for `review-post`: `posted a review on o/r#1: approve, 3 comments`.

- [ ] Tests, fail, implement, pass. Commit `feat: the route that posts a review`.

### Task 5: The dialog in the panel

**Files:** Modify `src/sources/github/panel.ts`, `src/render/theme/panels.css`, `test/fixtures/page/entries.ts`; Test `src/sources/github/panel.test.ts`

Markup, per drafted PR, after `</details>`:
`<button type="button" data-review-open="KEY">Open review</button>`, the dialog, then the rerun button, then `<p class="fix-note">Posted HH:MM</p>` when `view.done[postedKey(KEY)]` is set.

Dialog: `<dialog class="review-dialog" data-review="KEY" data-draft="HASH">`; `h2` title; meta line with `Draft says: <verdict>`; one `.finding` per entry holding `<input type="checkbox" data-pick="summary|N">`, a `<textarea data-text>`, and for notes `<button type="button" data-copy-text>Copy</button>`; footer with three radios `name="event:KEY"` (`COMMENT` checked), `<textarea data-message>`, `<button type="button" data-review-post disabled>Post</button>`, `<button type="button" data-review-close>Close</button>`; `<p class="review-status" role="status">`.

- [ ] Tests: button order; nothing `checked` but the Comment radio; text escaped (including `</textarea>`); posted note; no dialog without a draft. Fail, implement, pass. Commit `feat: a drafted review opens in a dialog`.

### Task 6: The page script

**Files:** Modify `src/render/client/app.js`; Test `src/render/client/app.test.ts`

Behaviour: open, close; `data-copy-text` copies its entry's current text; label and enabled state follow ticks, message and choice; Post sends the request and writes the answer into `.review-status`, then stays off; a changed page waits for the dialog to close before reloading; state saved under `divination-review` in session storage by key and fingerprint, restored on load, dropped after a post; Post is off with the server down.

- [ ] Tests, fail, implement, pass. Commit `feat: tick, edit and post a review from the page`.

### Task 7: Docs

**Files:** Modify `README.md` (opening, Safety, new "Posting a review"), any other doc that says the tool never posts.

- [ ] Commit `docs: posting a review`.
