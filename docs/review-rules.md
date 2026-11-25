# Review rules the dashboard knows about

House rules for code review at Campaign Monitor that the review queue applies. Each one
names where it lives, so it can be changed in one place.

## Rotation

A review asked of the whole crew team and of me by the same person at the same moment is
a rotation pick: it is mine. Asked of the team alone, it is the team's. Asked of me alone,
it is direct.

- Team name: `github.rotationTeam` in config.
- Code: `src/sources/github/classify.ts`.

## Crew members may bypass the crew's review

A pull request raised by a member of the review crew may go ahead without the crew's
review. For example: Sha is the JS crew's captain, so a JavaScript review she raises can
bypass the JS crew review.

The dashboard still lists these pull requests, in the same place and order as any other.
It marks each with a lozenge, **raised by crew member**, on its line in the review queue
and in its reason under "Needs you", so I can decide whether to spend time on it.

- Who counts: `github.crewMembers` in config, a list of GitHub usernames. For the JS crew
  it is the membership of the Slack channel `#js-crew-members`, copied by hand; update the
  list when that channel's membership changes.
- Code: `byCrew` in `src/sources/github/collect.ts`, drawn in `src/sources/github/panel.ts`.

## Signals from the review channel

A pull request's post in the review channel can take it off my plate or flag it:

- a 🛑 reaction: not for this crew, so it is skipped;
- 👀 from someone other than me: already picked up, so it is skipped;
- replies under the post: there is a discussion, so it is flagged.

These signals need the review channel's posts with who reacted. They work when Slack is
read through the Web API. When Slack is fed by hand with `/slack-sweep`, the sweep does
not collect them yet, so no pull request is skipped or flagged this way.

- Channel and reactions: `github.slackSignal` in config.
- Code: `src/sources/github/slack-signal.ts`.
