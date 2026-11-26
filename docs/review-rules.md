# Review rules the dashboard knows about

House rules for code review that the review queue applies. Each one
names where it lives, so it can be changed in one place.

All three are rules of a review crew, and all three are switched on by the `github.crew`
block in config. That block is optional. Someone who is not in a crew leaves it out, and
then none of this applies: a review asked of them by name is direct, one that reaches
them through a team is the team's, nobody is marked as a crew member, and no review
channel is read.

## Rotation

A review asked of the whole crew team and of me by the same person at the same moment is
a rotation pick: it is mine. Asked of the team alone, it is the team's. Asked of me alone,
it is direct.

- Team name: `github.crew.rotationTeam` in config.
- Code: `src/sources/github/classify.ts`.

## Crew members may bypass the crew's review

A pull request raised by a member of the review crew may go ahead without the crew's
review. For example: if Ana is the frontend crew's captain, a frontend review she raises
can bypass the frontend crew's review.

The dashboard still lists these pull requests, in the same place and order as any other.
It marks each with a lozenge, **raised by crew member**, on its line in the review queue
and in its reason under "Needs you", so I can decide whether to spend time on it.

- Who counts: `github.crew.members` in config, a list of GitHub usernames. Nothing keeps
  it in step with the crew: it is copied by hand from wherever the crew's membership is
  kept (the members of its Slack channel, say), so update it when that changes.
- Code: `byCrew` in `src/sources/github/collect.ts`, drawn in `src/sources/github/panel.ts`.

## Signals from the review channel

A pull request's post in the review channel can take it off my plate or flag it:

- a 🛑 reaction: not for this crew, so it is skipped;
- 👀 from someone other than me: already picked up, so it is skipped;
- replies under the post: there is a discussion, so it is flagged.

These signals need the review channel's posts with who reacted. They work when Slack is
read through the Web API. When Slack is fed by hand with `/slack-sweep`, the sweep does
not collect them yet, so no pull request is skipped or flagged this way.

- Channel and reactions: `github.crew.reviewChannel` in config.
- Code: `src/sources/github/slack-signal.ts`.
