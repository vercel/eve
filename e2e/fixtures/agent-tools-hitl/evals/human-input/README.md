# Human input

One eval per rule of eve's human input (`packages/eve/src/harness/human-input/`):
tool approvals, response policies, the budget question, sign-ins, and requests
relayed from child sessions and workflow runs. Each eval drives a real session
over HTTP and asserts on its event stream.

Every eval here is deterministic in every world. Sessions select the scripted
`human-input` model with the `x-eve-fixture-model` header
([`agent/lib/human-input`](../../agent/lib/human-input)), so they need no
`real-model` tag. That model also fails the turn if its history ever carries an
AI SDK approval part. eve runs approved calls itself, so a passing run also shows
that history has no such part.

People are named by the fixture's `x-eve-fixture-user` header: Alice asks, Bob
is someone else in the session, and `e2e-approval-responder` is the release
manager whom the fixture's response policies allow. `x-eve-fixture-flag` lets a
caller turn on a change freeze (`frozen-change`) or retire a step tool
(`retiring-change`).

Relayed rules live with the fixtures that own children and workflow tools:
[`agent-subagents-hitl/evals/human-input`](../../../agent-subagents-hitl/evals/human-input)
and [`agent-workflow-tools/evals/human-input`](../../../agent-workflow-tools/evals/human-input).

## Coverage

| Rule                                                                  | Eval                                                                                                           |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Approve runs the call in eve, result before the next step             | [approve-runs-the-call](./approvals/approve-runs-the-call.eval.ts)                                             |
| Deny resolves `denied` and records a not-run result                   | [deny-records-not-run](./approvals/deny-records-not-run.eval.ts)                                               |
| A partial answer keeps the turn held, with no model call              | [partial-answer-keeps-turn-held](./approvals/partial-answer-keeps-turn-held.eval.ts)                           |
| A typed reply naming an option answers                                | [typed-approve-answers](./approvals/typed-approve-answers.eval.ts)                                             |
| A typed reply answers only what it matches                            | [typed-reply-answers-only-what-matches](./approvals/typed-reply-answers-only-what-matches.eval.ts)             |
| Steering ignores unanswered approvals and keeps given answers         | [steer-ignores-unanswered](./approvals/steer-ignores-unanswered.eval.ts)                                       |
| Someone else's message waits for the held turn                        | [other-person-message-waits](./approvals/other-person-message-waits.eval.ts)                                   |
| Cancel resolves each approval once as `cancelled`                     | [cancel-resolves-each-request](./approvals/cancel-resolves-each-request.eval.ts)                               |
| An answer to a request that is not open authorizes nothing            | [stale-answer-authorizes-nothing](./approvals/stale-answer-authorizes-nothing.eval.ts)                         |
| A `once()` grant is reused                                            | [once-grant-is-reused](./approvals/once-grant-is-reused.eval.ts)                                               |
| An approved call runs with the asking step's tools                    | [approved-call-uses-asking-step-tools](./approvals/approved-call-uses-asking-step-tools.eval.ts)               |
| The approval policy is checked again at run time                      | [recheck-denies-at-run-time](./approvals/recheck-denies-at-run-time.eval.ts)                                   |
| A rejected responder leaves the approval open                         | [rejected-responder-leaves-approval-open](./response-policies/rejected-responder-leaves-approval-open.eval.ts) |
| An allowed responder settles the approval                             | [allowed-responder-settles](./response-policies/allowed-responder-settles.eval.ts)                             |
| The settling candidate makes competitors stale                        | [competing-candidate-goes-stale](./response-policies/competing-candidate-goes-stale.eval.ts)                   |
| A responder's sign-in, then settlement                                | [responder-sign-in-then-settles](./response-policies/responder-sign-in-then-settles.eval.ts)                   |
| A typed reply never answers a policy-gated approval                   | [typed-reply-never-answers-policy-gated](./response-policies/typed-reply-never-answers-policy-gated.eval.ts)   |
| The budget question holds the turn                                    | [budget-question-holds-the-turn](./budget/budget-question-holds-the-turn.eval.ts)                              |
| Continue runs the stopped model call in the same turn                 | [continue-runs-the-same-call](./budget/continue-runs-the-same-call.eval.ts)                                    |
| Stop cancels the turn, resolving once                                 | [stop-cancels-once](./budget/stop-cancels-once.eval.ts)                                                        |
| A message behind the question is received now and read after Continue | [message-waits-behind-budget](./budget/message-waits-behind-budget.eval.ts)                                    |
| No step starts behind the budget question (known bug, skipped)        | [no-step-behind-budget](./budget/no-step-behind-budget.eval.ts)                                                |
| A typed `continue` answers                                            | [typed-continue-answers](./budget/typed-continue-answers.eval.ts)                                              |
| Cancel withdraws the budget question                                  | [cancel-withdraws-budget-question](./budget/cancel-withdraws-budget-question.eval.ts)                          |
| A late budget answer is dropped (known bug, skipped)                  | [stale-budget-answer-dropped](./budget/stale-budget-answer-dropped.eval.ts)                                    |
| A sign-in holds the turn; the callback resumes it as the requester    | [sign-in-holds-then-resumes-as-requester](./sign-ins/sign-in-holds-then-resumes-as-requester.eval.ts)          |
| A newer attempt supersedes the open one                               | [newer-attempt-supersedes](./sign-ins/newer-attempt-supersedes.eval.ts)                                        |
| Steering declines a sign-in and tells the model                       | [steer-declines-sign-in](./sign-ins/steer-declines-sign-in.eval.ts)                                            |
| Cancel declines a sign-in                                             | [cancel-declines-sign-in](./sign-ins/cancel-declines-sign-in.eval.ts)                                          |
| An approved call that needs a sign-in                                 | [approved-call-needs-sign-in](./sign-ins/approved-call-needs-sign-in.eval.ts)                                  |

The rule that the model never runs while a request is open is checked inside
the evals above by `expectNoModelCallWhileOpen` and
`expectNoModelCallDuringSignIn` ([helpers](./helpers.ts)).

Known-bug evals skip unless `EVE_E2E_KNOWN_BUGS=1`; each carries a `// BUG:`
note with the runtime location.

## Not covered here

- **Candidate expiry.** A candidate times out after a 10-minute wall-clock
  TTL, and e2e cannot advance the clock. Covered by
  `harness/human-input/index.test.ts`.
- **A `once()` grant hidden while an approval for its key waits.** Policies
  only run at a step's start or right before an approved call, and neither
  happens while that approval waits, so HTTP cannot observe the hiding.
  Covered by `index.test.ts`.
- **An approved tool removed before the answer.** Step tools persist with
  their step, so only a redeploy between the ask and the answer removes one.
  Local e2e cannot redeploy.
- **A fresh relayed batch replacing an older one.** This needs a child or
  remote agent to ask again from the same source while its earlier batch is
  open. Each workflow `ctx.ask()` is its own source. Covered by `index.test.ts`.
- **Handoff blocked while a request is open.** This needs a deployment
  handoff, which only the Vercel redeploy suite performs.
