---
description: "Playbook for triaging GitHub issues: checking for duplicates, applying the repo's existing labels, deciding whether to ask for a reproduction or close, and choosing when to act directly versus report back first. Load whenever asked to triage, label, dedupe, or close issues, whether the request came from a GitHub mention, an email reply, or a Linear delegation. Not needed for composing the weekly digest, answering general questions on a thread, or creating Linear issues."
---
# Triaging Issues

How to work through a GitHub issue (or a batch of them) when someone asks you to triage. The order matters: read, dedupe, label, then decide what the issue needs. Never comment on or change an issue you haven't read in full, including its existing comments and labels.

## 1. Check for duplicates before anything else

A duplicate comment or label applied to a fresh report saves everyone the most time, but only if you are right.

- Search the repo's existing issues for the same symptom before writing anything. Search closed issues as well as open ones: many "new" bugs were already fixed or already rejected.
- Search by the error message, the API or feature name, and a plain description of the symptom. One search is not enough; reporters describe the same bug in different words.
- Treat it as a duplicate only when the underlying cause matches, not just the surface symptom. Two crashes with the same error text can have different roots.
- When it is a duplicate of an open issue: comment linking the original by number, apply the repo's duplicate label if one exists, and note anything the new report adds (a new environment, a cleaner reproduction) on the original.
- When it duplicates a closed issue that was fixed: point to the fix and the release that carries it, and ask the reporter to confirm on that version before closing.
- When you are not sure, say so in your comment ("this looks related to #42") and leave both open rather than closing on a guess.

## 2. Label with the repo's vocabulary, never your own

Every repo has its own label taxonomy, and an invented label is worse than none.

- List the repo's existing labels first and work only from that set. Never create a label or apply a name you assume exists.
- Read the label descriptions when they exist; "bug" versus "regression" versus "confirmed" often carry specific local meaning.
- Apply the fewest labels that place the issue: usually one for type (bug, feature, question) and one for area or status when the repo has them.
- Remove a label only when it is clearly wrong for the issue, and say why in a comment when the removal isn't obvious.
- If the repo has almost no labels, don't compensate by inventing structure. Triage with comments instead and mention the gap when you report back.

## 3. Ask for more info, or close?

Default to asking. Closing is for issues that are already resolved elsewhere, not for issues that are merely thin.

- Ask the reporter for more when the report is plausible but not actionable: no version, no steps, no expected-versus-actual behavior. Apply the repo's needs-repro or needs-more-info style label if it has one.
- Close directly only when the issue is a confirmed duplicate, already fixed in a release the reporter can upgrade to, plainly off topic for the repo, or spam. Always leave a comment saying why, with links.
- An issue that got a request for info and no reply is a candidate to close, but only after real time has passed, and note in the closing comment that it can be reopened with the missing details.
- Never close someone's issue because you personally judge it low value. That call belongs to the maintainers; flag it to the user instead.

## 4. Asking for reproduction details

The comment asking for more info decides whether the reporter comes back. Keep it short, specific, and warm.

- Open by engaging with what they reported, not with a form letter. One sentence showing you read the issue.
- Ask for the smallest set of things that would make the issue actionable, as a short list: exact version, steps or a minimal repro, expected versus actual behavior, and environment only if it plausibly matters.
- Ask specific questions over generic ones. "Does this happen with X disabled?" gets an answer; "please provide more details" gets silence.
- Close with what happens next: that you or the maintainers will pick it up once the details land.
- See `references/repro-request-structure.md` for the comment shape and worked examples.

## 5. Act directly or surface to the user?

Who asked, and what they asked for, sets how much you do on your own.

- When someone explicitly asked you to triage, do the reversible parts directly: comment, apply and correct labels, link duplicates. Then report what you did, issue by issue, with numbers and links.
- Closing an issue is harder to walk back socially, even though it can be reopened. Close on your own only for the clear cases in section 3; for anything debatable, recommend the close to the user with your reasoning and let them decide.
- For a large batch, share your plan in summary before executing ("I'd mark #3 and #7 as duplicates of #1, label #4 and #5 as bugs, and ask #9 for a repro") when the request left room for judgment.
- When the request came by email or from Linear, the requester can't see the repo activity as it happens, so your reply must carry the full outcome: what you changed, what you asked, what you recommend, each with its issue number and link.
- Never take a triage action on an issue nobody asked you about, even if you notice it needs one while working. Mention it to the user instead.
