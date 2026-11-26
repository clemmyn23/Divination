import assert from "node:assert/strict";
import { test } from "node:test";
import { HOST } from "../../../../test/fixtures/github/api.ts";
import { contextWith } from "../../../../test/helpers.ts";
import { readDone } from "../../../core/done.ts";
import { cachePut, hashOf } from "../../../enrich/cache.ts";
import type { Github, NewReview } from "../client.ts";
import { type PostRequest, Refusal, parsePost, postReview, postedKey } from "./post.ts";

const KEY = "o/r#1@aaa111";
const DRAFT = {
  verdict: "request_changes",
  summary: "Adds an avatar menu.",
  findings: [
    { file: "src/a.ts", line: "3", severity: "blocker", comment: "The handler is never removed." },
    { file: "src/a.ts", line: "2-4", severity: "nit", comment: "Rename `x`." },
    { file: "src/b.ts", line: "90", severity: "should-fix", comment: "Not in the diff." },
  ],
};
const PATCH = "@@ -1,3 +1,4 @@\n one\n+two\n three\n four";

function setup(over: { pull?: object; draft?: unknown; review?: (review: NewReview) => Promise<{ html_url?: string }>; logBroken?: boolean } = {}) {
  const logged: { event: string; fields?: object }[] = [];
  const ctx = contextWith(
    { github: { host: HOST } },
    {
      log: (event, fields) => {
        if (over.logBroken) throw new Error("ENOSPC: the log could not be written");
        logged.push({ event, ...(fields ? { fields } : {}) });
      },
    },
  );
  if (over.draft !== null) cachePut(ctx, "pr-review", hashOf(KEY), over.draft ?? DRAFT);
  const posted: { repo: string; number: number; review: NewReview }[] = [];
  const asked: string[] = [];
  const github = () =>
    ({
      pull: async () => {
        asked.push("pull");
        return { state: "open", head: { sha: "aaa111" }, ...over.pull };
      },
      patches: async () => {
        asked.push("patches");
        return [{ filename: "src/a.ts", patch: PATCH }, { filename: "logo.png" }];
      },
      review: async (repo: string, number: number, review: NewReview) => {
        posted.push({ repo, number, review });
        return over.review ? over.review(review) : { html_url: `https://${HOST}/o/r/pull/1#pullrequestreview-9` };
      },
    }) as unknown as Github;
  const post = (req: Partial<PostRequest>) =>
    postReview(ctx, { key: KEY, draft: hashOf(over.draft ?? DRAFT), event: "COMMENT", message: "", notes: [], ...req }, { github });
  return { ctx, post, posted, asked, logged };
}

test("ticked notes are posted as one review: each on its line, at the draft's commit", async () => {
  const { post, posted } = setup();
  const result = await post({ notes: [{ index: 0, text: "The handler is never removed.\n" }, { index: 1, text: "Rename `y`." }] });

  assert.deepEqual(result, { comments: 2, inBody: 0, url: `https://${HOST}/o/r/pull/1#pullrequestreview-9` });
  assert.equal(posted.length, 1);
  assert.equal(posted[0]!.repo, "o/r");
  assert.equal(posted[0]!.number, 1);
  assert.deepEqual(posted[0]!.review, {
    commit_id: "aaa111",
    event: "COMMENT",
    body: "",
    comments: [
      { path: "src/a.ts", line: 3, side: "RIGHT", body: "The handler is never removed." },
      { path: "src/a.ts", line: 4, side: "RIGHT", start_line: 2, start_side: "RIGHT", body: "Rename `y`." }, // my edit, not the draft's text
    ],
  });
});

test("my message comes first, then the ticked summary, then a note that has no line in the diff", async () => {
  const { post, posted } = setup();
  const result = await post({ event: "REQUEST_CHANGES", message: "lgtm, mostly", summary: "Adds an avatar menu.", notes: [{ index: 2, text: "Not in the diff." }] });

  assert.equal(result.comments, 0);
  assert.equal(result.inBody, 1);
  assert.equal(posted[0]!.review.event, "REQUEST_CHANGES");
  assert.equal(posted[0]!.review.body, "lgtm, mostly\n\nAdds an avatar menu.\n\n**`src/b.ts:90`**\n\nNot in the diff.");
  assert.deepEqual(posted[0]!.review.comments, []);
});

test("a note that was not ticked is not posted, and neither is the summary", async () => {
  const { post, posted } = setup();
  await post({ message: "lgtm", notes: [{ index: 0, text: "x" }] });
  const sent = JSON.stringify(posted[0]!.review);
  assert.ok(!sent.includes("Rename"));
  assert.ok(!sent.includes("Not in the diff"));
  assert.ok(!sent.includes("avatar menu"));
});

test("an approval may be bare", async () => {
  const { post, posted } = setup();
  assert.deepEqual(await post({ event: "APPROVE" }), { comments: 0, inBody: 0, url: `https://${HOST}/o/r/pull/1#pullrequestreview-9` });
  assert.deepEqual(posted[0]!.review, { commit_id: "aaa111", event: "APPROVE", body: "", comments: [] });
});

test("a comment or a change request with nothing to say is refused, and nothing is sent", async () => {
  for (const event of ["COMMENT", "REQUEST_CHANGES"] as const) {
    const { post, posted } = setup();
    await assert.rejects(post({ event, message: "  " }), (e: unknown) => e instanceof Refusal && /nothing to post/.test(e.message));
    assert.equal(posted.length, 0);
  }
});

test("with no draft for that PR at that commit, nothing is asked of GitHub", async () => {
  const { post, posted, asked } = setup({ draft: null });
  await assert.rejects(post({ message: "lgtm" }), (e: unknown) => e instanceof Refusal && /no drafted review/.test(e.message));
  assert.deepEqual(asked, []);
  assert.equal(posted.length, 0);
});

test("a stored draft in the wrong shape is no draft", async () => {
  const { post, posted } = setup({ draft: { verdict: "comment" } });
  await assert.rejects(post({ message: "lgtm" }), Refusal);
  assert.equal(posted.length, 0);
});

test("a draft that was rerun since its dialog was drawn is refused: its notes are not the ones I ticked", async () => {
  const { post, posted, asked } = setup();
  await assert.rejects(post({ draft: "0123456789abcdef", notes: [{ index: 0, text: "x" }] }), (e: unknown) => e instanceof Refusal && /rerun/.test(e.message));
  assert.deepEqual(asked, []);
  assert.equal(posted.length, 0);
});

test("once the review is on the PR, a log that cannot be written does not make the post look failed", async () => {
  const { post, posted } = setup({ logBroken: true });
  assert.deepEqual(await post({ message: "lgtm" }), { comments: 0, inBody: 0, url: `https://${HOST}/o/r/pull/1#pullrequestreview-9` });
  assert.equal(posted.length, 1);
});

test("a note the draft does not have is refused before GitHub is asked anything", async () => {
  const { post, posted, asked } = setup();
  await assert.rejects(post({ notes: [{ index: 3, text: "x" }] }), (e: unknown) => e instanceof Refusal && /no note 4/.test(e.message));
  assert.deepEqual(asked, []);
  assert.equal(posted.length, 0);
});

test("a PR with new commits since the draft is refused: the draft was written for another commit", async () => {
  const { post, posted } = setup({ pull: { head: { sha: "bbb222" } } });
  await assert.rejects(post({ message: "lgtm" }), (e: unknown) => e instanceof Refusal && /new commits/.test(e.message));
  assert.equal(posted.length, 0);
});

test("a PR that is no longer open is refused", async () => {
  const { post, posted } = setup({ pull: { state: "closed" } });
  await assert.rejects(post({ message: "lgtm" }), (e: unknown) => e instanceof Refusal && /no longer open/.test(e.message));
  assert.equal(posted.length, 0);
});

test("a key that is not a draft's key is refused", async () => {
  const { post, asked } = setup();
  for (const key of ["o/r#1", "all", "../x#1@aaa", "o/r#1@aaa111 "]) {
    await assert.rejects(post({ key, message: "lgtm" }), Refusal);
  }
  assert.deepEqual(asked, []);
});

test("a posted review is marked, so the page can say so", async () => {
  const { ctx, post } = setup();
  assert.equal(readDone(ctx)[postedKey(KEY)], undefined);
  await post({ message: "lgtm" });
  assert.equal(readDone(ctx)[postedKey(KEY)], ctx.now());
  assert.equal(postedKey(KEY), "posted:o/r#1@aaa111");
});

test("when GitHub refuses the review, its answer is the error and nothing is marked", async () => {
  const { ctx, post } = setup({
    review: async () => {
      throw new Error("HTTP 422 from https://git.example.com/api/v3/repos/o/r/pulls/1/reviews: Unprocessable Entity");
    },
  });
  await assert.rejects(post({ message: "lgtm" }), (e: unknown) => !(e instanceof Refusal) && /HTTP 422/.test((e as Error).message));
  assert.equal(readDone(ctx)[postedKey(KEY)], undefined);
});

test("the log says which PR, what kind of review and how many notes, and none of the words", async () => {
  const { post, logged } = setup();
  await post({ event: "APPROVE", message: "secret words", summary: "more words", notes: [{ index: 0, text: "note words" }, { index: 2, text: "loose words" }] });
  assert.deepEqual(logged, [{ event: "review-post", fields: { key: "o/r#1", event: "approve", comments: 1, inBody: 1 } }]);
});

test("a link from GitHub that does not point at the configured host is dropped", async () => {
  const { post } = setup({ review: async () => ({ html_url: "https://evil.example/o/r/pull/1" }) });
  assert.deepEqual(await post({ message: "lgtm" }), { comments: 0, inBody: 0 });
});

// ---- Reading the request ----

const PRINT = "0123456789abcdef";
const GOOD = { key: KEY, draft: PRINT, event: "APPROVE", message: "lgtm", summary: "Fine.", notes: [{ index: 0, text: "x" }] };

test("a well-formed request is read as it is", () => {
  assert.deepEqual(parsePost(GOOD), GOOD);
  assert.deepEqual(parsePost({ key: KEY, draft: PRINT, event: "COMMENT" }), { key: KEY, draft: PRINT, event: "COMMENT", message: "", notes: [] });
});

test("a malformed request is described, not read", () => {
  const bad: [object, RegExp][] = [
    [{ ...GOOD, key: 7 }, /"key"/],
    [{ ...GOOD, key: "o/r#1" }, /"key"/],
    [{ ...GOOD, draft: undefined }, /"draft"/],
    [{ ...GOOD, draft: "print" }, /"draft"/],
    [{ ...GOOD, draft: 7 }, /"draft"/],
    [{ ...GOOD, event: "MERGE" }, /"event"/],
    [{ ...GOOD, event: "approve" }, /"event"/],
    [{ ...GOOD, message: 7 }, /"message"/],
    [{ ...GOOD, message: "x".repeat(10_001) }, /"message"/],
    [{ ...GOOD, summary: 7 }, /"summary"/],
    [{ ...GOOD, notes: "all" }, /"notes"/],
    [{ ...GOOD, notes: [{ index: 0.5, text: "x" }] }, /"notes"/],
    [{ ...GOOD, notes: [{ index: -1, text: "x" }] }, /"notes"/],
    [{ ...GOOD, notes: [{ index: "0", text: "x" }] }, /"notes"/],
    [{ ...GOOD, notes: [{ index: 0, text: "  " }] }, /"notes"/],
    [{ ...GOOD, notes: [{ index: 0, text: 7 }] }, /"notes"/],
    [{ ...GOOD, notes: [null] }, /"notes"/],
    [
      {
        ...GOOD,
        notes: [
          { index: 0, text: "x" },
          { index: 0, text: "y" },
        ],
      },
      /"notes"/,
    ],
    [{ ...GOOD, notes: Array.from({ length: 101 }, (_, index) => ({ index, text: "x" })) }, /"notes"/],
  ];
  for (const [fields, what] of bad) {
    const read = parsePost(fields as Record<string, unknown>);
    assert.equal(typeof read, "string", JSON.stringify(fields).slice(0, 80));
    assert.match(read as string, what);
  }
});
