# Posting a drafted review: design

## Intent

A drafted review is shown folded inside its line in the Review queue, which is too small to
read. I want to open it in a dialog, tick the notes that are real problems, add a line of my
own, and post the result to the PR as a review, without leaving the page.

## Goals

- An **Open review** button under each draft opens it in a dialog.
- Each note has a checkbox. Nothing is ticked to start. Each note's text can be edited.
- The draft's summary is one more tickable, editable entry. Ticked, it goes in the review's
  overall comment.
- Beside the Post button: a small box for my own message, and a choice of Comment, Approve or
  Request changes. Comment is always the one selected to start; the draft's verdict is shown
  but never preselected.
- **Post** sends one review to the PR under my name: my message first, then the ticked
  summary, with each ticked note as a comment on its file and line.

## Non-goals

- No posting from the command line, no posting of more than one PR at a time.
- No replying to, editing or deleting anything already on a PR.
- Claude is not involved in posting. The review run stays read-only and its prompt is unchanged.

## Anti-goals

- Nothing is ever posted without a press of Post in the dialog. No timer, refresh, rerun or
  other route leads to a post.
- Nothing the user did not tick is posted. File and line always come from the stored draft,
  never from the page.
- A review is never posted against a commit the draft was not written for.

## Constraints

- This is the tool's first write to someone else's PR. The only GitHub writes are now: a
  fix's push to one of my own PRs, and one `POST /repos/{repo}/pulls/{n}/reviews` per press of
  Post. Still no merge, no reaction, no issue comment.
- The token is the one `gh` already holds, sent only to the configured host.
- The route has the same guards as every other: loopback host, the page's token.
- Comment text never reaches `ctx.log`: only the PR, the kind of review and the counts.

## Approaches

1. **One review, built by the tool's code (chosen).** The server reads the PR's diff, places
   each ticked note on its line, and posts a single review. A note whose line is not in the
   diff goes in the overall comment, because GitHub rejects the whole review otherwise.
2. A pending review left on GitHub to submit there. Safer, but it is the second step this
   feature exists to remove.
3. One comment per note, posted separately. Sends a notification per note and cannot carry
   an approval.

For the kind of review: a chooser with Comment preselected (chosen by the owner) over
always-Comment.

## Design

- **Panel.** After the folded draft: `Open review`, then `Rerun review`. The dialog is
  rendered with the line, one per draft, and carries the draft's key and a fingerprint of
  its content. A posted draft shows `Posted HH:MM` under it.
- **Page script.** Opens and closes the dialog; keeps the Post button's label true
  (`Post 3 comments · Approve`) and off when there is nothing to send; sends the post and
  shows the answer inside the dialog. While a dialog is open the page does not reload
  itself; it reloads when the dialog closes. Ticks, edits, the message and the choice are
  kept in session storage against the draft's fingerprint, so they survive a reload and are
  dropped when the draft is rerun or posted.
- **Route.** `POST /api/review/post { key, event, message, summary?, notes: [{ index, text }] }`,
  answered when GitHub has answered: `200 { comments, inBody, url }`, `400` for a bad
  request, `409 { error }` when the post was refused before it was sent, `502 { error }`
  when GitHub refused it. It does not run as a job, so it works while a refresh runs.
- **Posting.** In order: the draft for `key` must be in the cache; the PR must be open and
  its head must be the commit in `key`; the PR's files are read and each ticked note is
  placed (end of its range, else start, else the overall comment; a range in one hunk is a
  multi-line comment); a Comment or Request changes with nothing to say is refused; the
  review is posted with `commit_id` set to the draft's commit; the post is recorded as a
  done mark `posted:<key>` and the page is redrawn.

## Left to the builder

Names, CSS, the wording of refusals, how the fake page in the script's tests grows.
