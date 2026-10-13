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

Collect all feedback.

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

Expect two review bots:

- `roboeve[bot]` reviews once, on the commit that opened the PR, usually within
  2–15 minutes. It does not review later pushes.
- Vercel Agent Review (`vercel[bot]`) runs as a check on every push and can post
  new threads on later commits. It re-checks its own threads after a fix and
  resolves them itself, so skip threads it already resolved.

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
   force-pushing, so reply SHAs stay valid. PRs are squash-merged and `main`
   does not require branches to be up to date, so do not rebase only to catch
   up. If `gh pr view <n> --json mergeable` reports `CONFLICTING`, merge
   `origin/main` into the branch with `git merge --signoff origin/main`. Rebase
   or force-push only when the user asks or to repair signing or DCO.
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
A full round takes about 10–15 minutes, and `test-scenario` and the e2e shards
finish last. `gh pr checks <n> --required` shows only the checks that block
merge. Advisory checks such as Bundle Analysis and the eve-code benchmark
should still pass, but they come second to required checks.

For each failure, find the real error before you act. Integration tests log
many expected errors, so the first `Error:` lines in a failed log are usually
noise. Look for the vitest summary instead:

```sh
gh run view <run-id> --log-failed | grep -aE 'Failed Tests|FAIL |Test Files|Unhandled'
```

If every test passed but the job still failed, read the end of the log for a
teardown error, hang, or timeout.

Classify the failure:

- Real: the failure relates to the diff, reproduces locally with the tier
  config from `AGENTS.md`, or fails the same way on rerun. Fix it, then go back
  to step 4.
- Flaky: the failure does not relate to the diff, and it shows timeouts,
  network, provider, or deploy errors. It also counts as flaky when the same
  job fails on `main` (`gh run list --branch main --workflow <file> --limit 10`).
  Most flakes come from `test-integration` on either OS, `test-scenario`, and
  `e2e-vercel` or `e2e-postgres` fixture deploys. `e2e-local` uses live models,
  so it can also vary between runs.

Rerun only the failed jobs. GitHub refuses a rerun while any job in that
workflow run is still in progress, so wait for the run to finish:

```sh
gh run rerun <run-id> --failed
```

Rerun a flaky job at most twice per head commit. If it fails a third time,
treat it as real, or report it to the user with the failing test names. Do not
run whole integration, scenario, or e2e tiers locally. Scope local runs to the
failing file and test name.

## 6. Loop until done

After each push, return to step 3. Teammates may comment at any time, and
Vercel Agent Review reviews each new commit. Stop when all of these are true for
the latest head commit:

- All checks are green, including the Vercel Agent Review check, or the only
  failures are documented as unrelated and the user knows about them.
- There are no unresolved review threads, except ones that wait on a human
  decision.
- No new comments arrived since your last pass.

## Final report

Give the user the PR URL and a short account of the work:

- Reviewer findings you fixed, and notable ones you skipped and why.
- Comments you addressed, declined, or deferred, plus threads still open.
- CI status on the head SHA, flaky reruns with job names, and real failures
  you fixed.
