# Editing existing eve documentation

## 1. Triage the edit

Choose the smallest effective change:

| Level           | Signal                                                     | Action                                 |
| --------------- | ---------------------------------------------------------- | -------------------------------------- |
| Quick fix       | Incorrect command, broken link, typo, or stale name        | Correct the affected text              |
| Copy edit       | Ambiguous wording, weak hierarchy, or inconsistent terms   | Improve clarity without changing scope |
| Structural edit | Missing workflow stage, failure mode, or misplaced content | Reshape the affected page              |
| Rewrite         | The page no longer serves its primary task                 | Use the writing workflow               |

Feedback frequency helps rank work, but severity also matters. A single security, data-governance, or destructive-workflow issue can justify a high-priority correction.

## 2. Preserve context

Before editing:

- Read the full page and nearby pages.
- Search for incoming links and repeated claims.
- Preserve route paths and heading anchors when possible.
- Check whether the request is a docs gap, product gap, or both.
- Identify the exact source that verifies each changed behavior.

## 3. Edit around the reader's task

- Keep the established page structure unless it blocks the task.
- Make the supported happy path primary.
- Put alternatives after the happy path.
- Add limitations next to the workflow they constrain.
- Add troubleshooting to the page that owns the failing workflow.
- Prefer one focused example over a new page.

When support feedback drove the edit, deduplicate incidents into user problems before writing. Do not quote internal discussion or expose implementation history unless it helps the reader act.

## 4. Verify accuracy

Check commands against CLI help or their implementation. Check API examples against public exports and tests. Check deployment behavior against eve source and authoritative Vercel platform documentation.

If product semantics remain unsettled, document only the stable boundary. Route recovery flows, guarantees, or matrices to the responsible product owner instead of guessing.

## 5. Check adjacent content

Search for:

- Contradictory statements
- Old command names or flags
- Pages that describe the same workflow
- Links to changed headings
- Reference pages that need the same limitation or behavior
