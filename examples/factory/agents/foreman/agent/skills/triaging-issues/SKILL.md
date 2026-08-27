---
description: "Grounding a GitHub work item before running the factory pipeline: checking for duplicates, working with the repo's existing labels, deciding whether to ask for clarification or proceed, and asking for reproduction details well. Load whenever a work item arrives from a GitHub issue or mention, and whenever asked to triage, label, dedupe, or close issues. Not needed for work items that arrive as plain requests with no GitHub issue behind them."
---

# Triaging Issues

How to ground a GitHub issue before the factory pipeline runs on it, or when someone asks for a triage pass outright. The order matters: read, dedupe, label, then decide what the issue needs. Never comment on or change an issue you haven't read in full, including its existing comments and labels.

## 1. Check for duplicates before anything else

Running the pipeline on a duplicate wastes a full implementation cycle, and a duplicate comment on a fresh report saves everyone the most time, but only if you are right.

- Search the repo's existing issues for the same symptom before doing anything. Search closed issues as well as open ones: many "new" bugs were already fixed or already rejected.
- Search by the error message, the API or feature name, and a plain description of the symptom. One search is not enough; reporters describe the same bug in different words.
- Treat it as a duplicate only when the underlying cause matches, not just the surface symptom. Two crashes with the same error text can have different roots.
- When it is a duplicate of an open issue: comment linking the original by number, apply the repo's duplicate label if one exists, and note anything the new report adds (a new environment, a cleaner reproduction) on the original. Don't run the pipeline twice for one problem.
- When it duplicates a closed issue that was fixed: point to the fix and the release that carries it, and ask the reporter to confirm on that version before closing.
- When you are not sure, say so in your comment ("this looks related to #42") and leave both open rather than closing on a guess.

## 2. Label with the repo's vocabulary, never your own

Every repo has its own label taxonomy, and an invented label is worse than none.

- List the repo's existing labels first and work only from that set. Never create a label or apply a name you assume exists.
- Read the label descriptions when they exist; "bug" versus "regression" versus "confirmed" often carry specific local meaning.
- Apply the fewest labels that place the issue: usually one for type (bug, feature, question) and one for area or status when the repo has them.
- Remove a label only when it is clearly wrong for the issue, and say why in a comment when the removal isn't obvious.
- If the repo has almost no labels, don't compensate by inventing structure. Note the gap when you report back instead.

## 3. Ask or proceed?

This decision feeds the classifier's `needs_clarification` judgment, and yours before it. Default to proceeding when the intent is clear; ask when building the wrong thing is a real risk.

- Proceed with stated assumptions when the report is plausible and the gap is small: a missing version when the bug reproduces on the current one, a vague title over a clear body.
- Ask when the report is plausible but not actionable: no steps, no expected-versus-actual behavior, contradictory details, or several incompatible readings of what's wanted. Apply the repo's needs-repro or needs-more-info style label if it has one.
- Close directly only when the issue is a confirmed duplicate, already fixed in a release the reporter can upgrade to, plainly off topic for the repo, or spam. Always leave a comment saying why, with links. Never close someone's issue because you personally judge it low value; flag it instead.

## 4. Asking for reproduction details

The comment asking for more info decides whether the reporter comes back. Keep it short, specific, and warm.

- Open by engaging with what they reported, not with a form letter. One sentence showing you read the issue.
- Ask for the smallest set of things that would make the issue actionable, as a short list: exact version, steps or a minimal repro, expected versus actual behavior, and environment only if it plausibly matters.
- Ask specific questions over generic ones. "Does this happen with X disabled?" gets an answer; "please provide more details" gets silence.
- Close with what happens next: that the factory will pick the issue up once the details land.
- See `references/repro-request-structure.md` for the comment shape and worked examples.

## 5. Report what you did

- When someone explicitly asked for a triage pass, do the reversible parts directly: comment, apply and correct labels, link duplicates. Then report what you did, issue by issue, with numbers and links.
- When the requester is on a surface that can't see repo activity as it happens (a Linear session), your reply must carry the full outcome: what you changed, what you asked, what you recommend, each with its issue number and link.
- Never take a triage action on an issue nobody asked you about, even if you notice it needs one while working. Mention it instead.
