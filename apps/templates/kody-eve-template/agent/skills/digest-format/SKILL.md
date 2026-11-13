---
description: "How to compose or revise the weekly digest email of a repository's open issues: subject line, grouping, one-line issue summaries, needs-attention and stale criteria, citation format, and the closing invitation to reply. Load when composing this week's digest or reworking a draft of it. Not for other emails, replies, or GitHub and Linear comments."
---
# Digest Format

The weekly digest is one email a maintainer skims in their inbox. Everything here serves that: short, grouped, every issue cited as #N with a link, and a clear way to act by replying.

## Before composing

- Check the user's saved preferences first. A preference like "group the digest by label" or a preferred level of detail overrides the defaults below; everything a preference doesn't cover follows this skill.
- Work only from issues fetched in this run. Never carry over counts, titles, or numbers from earlier context.

## Subject line

- Name the repository and anchor the week: "Weekly issues digest: owner/repo" followed by the date, for example "Weekly issues digest: acme/widgets, June 22 2026".
- If a scheduled task dictates an exact subject format, follow the task; it wins over this default.

## Structure

Open with a one-paragraph overview: total open issues, what changed since last week (new, closed, spikes), and any theme worth a sentence. Then the groups, then the closing invitation.

Default grouping, in this order:

1. Needs attention: issues a maintainer should look at first.
2. Recent activity: new this week or updated this week, ordered by most recent activity.
3. Stale: open with no activity in 30 or more days. If this group is long, list the five oldest and give a count for the rest.

When the user prefers a different grouping (by label, by assignee, by milestone), use theirs and keep the needs-attention issues at the top of whatever group they land in, marked as such.

Skip any group that would be empty rather than showing an empty heading. If the repo has no open issues at all, send a short note saying so instead of the grouped digest.

## What qualifies where

Needs attention, any of:

- Labeled as urgent by the repo's own convention (bug plus high-priority, regression, security, or similar).
- A question or report from a user that has sat without a maintainer response for a week or more.
- Heated or fast-moving: many new comments in the past week with no resolution.
- Blocking something the thread names: a release, another issue, a downstream user.

Stale: no comments, label changes, or other activity in 30 or more days. Staleness is about silence, not age; an old issue with fresh discussion belongs in recent activity.

An issue appears in exactly one group. Needs attention wins over the others.

## Summarizing an issue in one line

Each issue gets one line: the citation, the title or a tightened version of it, then the state of play.

- The state of play is where the thread stands now, not a recap: "fix proposed, awaiting review", "reporter went quiet after repro request", "two users confirmed on 3.2".
- For a long or noisy thread, read the most recent maintainer or reporter comments and state the current position; skip the back-and-forth that led there.
- Never paste issue bodies or comment text. Numbers help ("14 comments this week") when the volume itself is the news.

Example line: [#42](https://github.com/acme/widgets/issues/42) Crash on empty config: fix proposed, awaiting maintainer review.

## Citations

- Cite every issue by number in #N form, and make the #N a link to the issue on GitHub. The number is what readers use in replies ("create Linear issues for #1 and #2"), so it must be present and correct on every mention.
- Use only numbers and links from issues fetched this run. Never guess or reconstruct a URL.

## Scannability

- The reader is triaging their inbox. Group headings, one line per issue, no walls of text.
- Keep the overview to one paragraph and each issue to one line. If an issue truly needs more, one extra clause beats a second paragraph.
- Plain text and simple lists render everywhere; skip tables and heavy formatting.

## Closing

End every digest by inviting the reader to reply to act, naming the concrete options: ask for detail on an issue, have you comment on one, or have you create Linear issues from it. Reference a real issue number from this digest in the example so the reply pattern is obvious, for example "reply with 'create Linear issues for #12 and #17'".
