---
name: pr-shepherd
description: Takes a finished eve branch through review to green CI. Opens the PR early, runs a fresh-context reviewer subagent, fixes critical findings, addresses, replies to, and resolves review comments, pushes, and monitors CI, rerunning flaky jobs or fixing real failures. Use after the initial implementation is complete, or when asked to open, babysit, land, or "get a PR green".
metadata:
  internal: true
---

# PR shepherd

Start after the first implementation is complete and checked locally. Finish
when the PR has no unresolved review threads, no unanswered comments, and green
CI on the latest head commit.

Open the PR first. Review bots and teammates comment while the rest of the work
runs, so an early PR gets more feedback in each round.

## 1. Open the PR

1. Make sure the branch is committed with `git commit -s` and that commits are
   signed (see [`AGENTS.md`](../../../AGENTS.md)). Add a changeset if the change
   touches the published `eve` package.
2. Run the fast checks from `AGENTS.md`: `pnpm fmt`, `pnpm lint`,
   `pnpm typecheck`, plus the narrowest relevant unit tests.
3. Push the branch, then open the PR. Use the
   [`gh-pr-description`](../gh-pr-description/SKILL.md) skill for the body and
   pass it with `--body-file`. Open it ready for review, not as a draft, unless
   the user asks for a draft.
4. Record the PR number. Every later step uses it.

If a PR already exists for the branch (`gh pr view --json number,url`), reuse it.

## 2. Fresh-context review

Spawn one reviewer subagent with no conversation history. Give it the PR number
and the branch, not your reasoning. A fresh reviewer catches what the author
explains away. Use a prompt like this one:

> Review PR #<n> in this repository (`gh pr view <n>`, `gh pr diff <n>`). Read
> `AGENTS.md` first and apply its coding, security, testing, docs, and changeset
> rules. Read surrounding code as needed to verify behavior. Do not edit files.
> Report findings ordered by severity (critical, important, minor). For each
> finding, give the file and line, the concrete failure or risk, and a suggested
> fix. Say plainly when you find nothing critical.

While the reviewer runs, you can already collect PR comments (step 3).

Triage the findings yourself. Verify each one against the code before you act.

- Fix: correctness bugs, races, security or data-loss risks, broken public
  behavior or docs, missing tests for changed behavior, a missing changeset,
  and invariant violations.
- Skip: style nits, speculative refactors, and scope creep. Mention notable
  skipped items to the user in the final report.

## 3. Address PR comments

Collect all feedback. Review bots such as `roboeve[bot]` and Vercel Agent
Review often post a few minutes after the PR opens or after a push.

Unresolved inline review threads, with the IDs you need to reply and resolve:

```sh
gh api graphql -F owner='{owner}' -F repo='{repo}' -F number=<n> -f query='
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          id isResolved isOutdated path line
          comments(first: 50) { nodes { databaseId author { login } body url } }
        }
      }
    }
  }
}' --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not)'
```

Top-level comments and review summaries (these cannot be resolved):

```sh
gh pr view <n> --json comments,reviews \
  --jq '.comments[], .reviews[] | select(.body != "") | {author: .author.login, body}'
```

Ignore informational bot posts such as Vercel deployment and bundle analysis
comments, unless they report a problem this PR caused.

For each thread, decide: fix, decline with a reason, or defer to a follow-up.
Apply the same triage bar as step 2. Bot suggestions get the same scrutiny as
human ones; confirm the problem is real before you change code. If a comment
needs a product or design decision only the user can make, ask the user.

## 4. Commit, push, reply, resolve

1. Combine the fixes from steps 2 and 3. Rerun the fast checks and the
   narrowest tests that cover the fixes.
2. Commit with `git commit -s` and push. Add new commits instead of amending or
   force-pushing, so reply SHAs stay valid. Force-push only when the user asks
   or to repair signing or DCO.
3. If the fixes changed behavior that the PR body describes, update the body
   with `gh-pr-description`.
4. Reply in each thread after the fix is on the remote. Keep replies short and
   specific, in the style already used on eve PRs:
   - `Fixed in <sha>. <What changed, in one or two sentences.>`
   - `Not changing this: <reason grounded in the code or a repo rule>.`
   - `Agreed, this is a real gap. Tracking it in a follow-up: <scope>.`

   ```sh
   gh api repos/{owner}/{repo}/pulls/<n>/comments/<databaseId>/replies -f body='Fixed in abc1234. ...'
   ```

5. Resolve each thread once it is fixed and pushed, declined with a reason, or
   deferred:

   ```sh
   gh api graphql -f id='<thread id>' -f query='
   mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }'
   ```

   Leave a human reviewer's thread open only when it still waits on their
   decision, and list it in the final report.

6. Answer top-level comments that ask for a change or a question with
   `gh pr comment <n> --body-file <file>`.

## 5. Monitor CI

Wait for checks on the new head commit. It can take a minute for them to
register after a push.

```sh
gh pr checks <n> --watch --interval 60
```

If your shell cannot block that long, poll `gh pr checks <n>` on an interval.
The e2e workflows (`e2e-local`, `e2e-vercel`, `e2e-postgres`) take the longest.

For each failure, read the log before you act:

```sh
gh run view <run-id> --log-failed
gh run view <run-id> --json jobs --jq '.jobs[] | select(.conclusion == "failure") | {name, databaseId}'
```

Classify the failure:

- Real: the failure relates to the diff, reproduces locally with the tier
  config from `AGENTS.md`, or fails the same way on rerun. Fix it, then go back
  to step 4.
- Flaky: the failure does not relate to the diff, and it shows timeouts,
  network or provider errors, or a live-model e2e variance. It also counts as
  flaky when the same job fails on `main`
  (`gh run list --branch main --workflow <file> --limit 10`). Rerun only the
  failed jobs:

  ```sh
  gh run rerun <run-id> --failed
  ```

Rerun a flaky job at most twice. If it fails a third time, treat it as real or
report it to the user with the evidence. Do not run whole integration, scenario,
or e2e tiers locally. Scope local runs to the failing file and test name.

## 6. Loop until done

After each push, return to step 3: new commits often trigger new bot reviews.
Stop when all of these are true for the latest head commit:

- All checks are green, or the only failures are documented as unrelated and the
  user knows about them.
- There are no unresolved review threads, except ones that wait on a human
  decision.
- No new comments arrived since your last pass.

## Final report

Give the user the PR URL and a short account of the work:

- Reviewer findings you fixed, and notable ones you skipped and why.
- Comments you addressed, declined, or deferred, plus threads still open.
- CI status on the head SHA, flaky reruns with job names, and real failures
  you fixed.
