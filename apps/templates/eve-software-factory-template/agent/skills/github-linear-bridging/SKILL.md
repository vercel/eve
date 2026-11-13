---
description: "Conventions for bridging GitHub and Linear: creating Linear issues from GitHub issues, cross-referencing the two trackers, and checking whether a GitHub issue is already tracked in Linear. Load when asked to create Linear issues from GitHub issues, link the trackers in either direction, or report tracking status. Not needed for work that stays inside one tracker."
---
# GitHub to Linear Bridging

Rules for carrying a GitHub issue into Linear and keeping the two sides pointing at each other. The goal is one clear Linear issue per GitHub issue, findable from either end, with no duplicate tracking and no noise copied across.

## Check for an existing Linear issue first

Before creating a Linear issue for a GitHub issue, search Linear for it. Search by the GitHub issue number (for example "#42"), the issue title, and the GitHub issue URL; any of the three may appear in an existing Linear issue's title, description, or comments.

- If a match exists, don't create a duplicate. Report the existing Linear issue with its link and current status, and add the GitHub link to it if it's missing.
- If the match is uncertain (similar title, no explicit reference), say what you found and ask before creating anything.

## What a well-formed bridged issue looks like

- Title: carry the GitHub issue's title over, cleaned up if it's vague or noisy. A reader should recognize it as the same issue from either tracker.
- Description: a short summary of the substance, in your own words. State the problem or request, the key facts from the discussion, and any decision or reproduction detail that matters. Never paste the whole GitHub thread.
- Backlink: include the full URL of the GitHub issue in the description, near the top, so the Linear side always leads back to the source.
- Assignee: set the assignee the user asked for. If they named someone you can't resolve in Linear, say so and ask instead of picking someone else or leaving it silently unassigned.

## Choosing the Linear team

- If the user's stored preferences include a default Linear team, use it.
- Otherwise ask which team the issue belongs to. Never guess a team from its name, and never pick the first team in the list.
- If the user states a lasting default while answering ("always use the Platform team"), persist it as a preference so you don't ask again.

## Cross-link both directions

After creating the Linear issue, the GitHub side should point at it too, when a comment there is appropriate: the requester maintains the repo, or they asked you to note the tracking. Post a short comment on the GitHub issue with the Linear issue's identifier and link, one line, nothing more. Skip the comment when it would be noise, for example on a repo the requester doesn't maintain or when they asked for private tracking; in that case just report the link back to them.

## Mirror only meaningful state

The two trackers stay loosely coupled. Carry over what changes decisions, not metadata.

- Don't sync labels wholesale. Mention a label in the summary only when it carries meaning (a severity, a confirmed bug), and only set a Linear label when the user asks for one.
- Don't mirror every comment or status change. When asked for status, read both sides live and report the current state rather than copying updates across.
- When a bridged issue closes on one side, note it on the other only when the user asks or the workflow they described calls for it.
