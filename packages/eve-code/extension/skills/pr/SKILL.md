---
name: pr
description: Prepare and publish a draft pull request with a signed commit, motivation-led description, testable hypothesis, and validation evidence.
---

# Publish a proposal

Fetch the current base immediately before publication. Rebase onto it, or replay only the intended diff onto a clean checkout when local commits are unavailable. Stop on conflicts, stale refs, unexpected paths, or unrelated reversions.

Stage only the intended changes. Repositories that require verified commits must use:

```sh
gh-signed-commit --repo owner/name --branch <branch> --base <base> -m "<headline>" [-b "<body>"]
```

The command commits only staged changes and synchronizes the checkout to the signed remote commit. Then write the PR body to a file and create one draft:

```sh
gh pr create --draft --title "<title>" --body-file <path> --base <base> --head <branch>
```

Use a specific title that names the behavior or problem. Never use placeholders such as `prepare changes`. Keep secrets, private context, credentials, and requester identity out of public metadata.

Write directly and top-down. Start with impact, then explain the essential decisions and why this shape tests the hypothesis. Prefer simple English and brief context over a wall of generated prose. Include truthful reproduction and validation evidence.

A useful description answers:

1. Why the change is necessary.
2. Why this approach is the smallest sound solution.
3. Which entry points and data flows change.
4. What evidence verifies the expected outcome.

Prefer this shape unless the repository has a required template:

```markdown
[One-line summary of what changed and why]

**Why**

[Observed problem, evidence, and impact]

**Approach**

Because [cause], changing [mechanism] should [expected outcome].

**Validation**

[Focused checks and results]

**Relevant context**

[Only the implementation or data-flow details reviewers need]
```
