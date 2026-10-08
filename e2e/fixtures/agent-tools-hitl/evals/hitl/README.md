# Human input

One eval per rule of eve's human input (`packages/eve/src/harness/hitl/`):
tool approvals, response policies, the budget question, authorizations, and requests
relayed from child sessions and workflow runs. Each eval drives a real session
over HTTP and asserts on its event stream.

Every eval here is deterministic in every world. Sessions select the scripted
`hitl` model with the `x-eve-fixture-model` header
([`agent/lib/hitl`](../../agent/lib/hitl)), so they need no
`real-model` tag. That model also fails the turn if its history ever carries an
AI SDK approval part. eve runs approved calls itself, so a passing run also shows
that history has no such part.

People are named by the fixture's `x-eve-fixture-user` header: Alice asks, Bob
is someone else in the session, and `e2e-approval-responder` is the release
manager whom the fixture's response policies allow. `x-eve-fixture-flag` lets a
caller retire a step tool (`retiring-change`).

Relayed rules live with the fixtures that own children and workflow tools:
[`agent-subagents-hitl/evals/hitl`](../../../agent-subagents-hitl/evals/hitl)
and [`agent-workflow-tools/evals/hitl`](../../../agent-workflow-tools/evals/hitl).

## Coverage

| Rule                                                                      | Eval                                                                                                                    |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Approve runs the call in eve, result before the next step                 | [approve-runs-the-call](./approvals/approve-runs-the-call.eval.ts)                                                      |
| Approval beside runtime work reports tasks, then input                    | [approval-runtime-park-emits-waiting](./continuation/approval-runtime-park-emits-waiting.eval.ts)                       |
| Runtime workflow parks report waiting on tasks                            | [runtime-park-emits-waiting](./continuation/runtime-park-emits-waiting.eval.ts)                                         |
| Deny resolves `denied` and records a not-run result                       | [deny-records-not-run](./approvals/deny-records-not-run.eval.ts)                                                        |
| A partial answer keeps the turn held, with no model call                  | [partial-answer-keeps-turn-held](./approvals/partial-answer-keeps-turn-held.eval.ts)                                    |
| A typed reply naming an option answers                                    | [typed-approve-answers](./approvals/typed-approve-answers.eval.ts)                                                      |
| A typed reply answers only what it matches                                | [typed-reply-answers-only-what-matches](./approvals/typed-reply-answers-only-what-matches.eval.ts)                      |
| Steering ignores unanswered approvals and keeps given answers             | [steer-ignores-unanswered](./approvals/steer-ignores-unanswered.eval.ts)                                                |
| Someone else's message waits for the held turn                            | [other-person-message-waits](./approvals/other-person-message-waits.eval.ts)                                            |
| An answer to a request that is not open authorizes nothing                | [stale-answer-authorizes-nothing](./approvals/stale-answer-authorizes-nothing.eval.ts)                                  |
| A `once()` grant is reused                                                | [once-grant-is-reused](./approvals/once-grant-is-reused.eval.ts)                                                        |
| An approved call runs with the asking step's tools                        | [approved-call-uses-asking-step-tools](./approvals/approved-call-uses-asking-step-tools.eval.ts)                        |
| Approval keeps the requester's identity and permissions                   | [approved-call-keeps-requester](./approvals/approved-call-keeps-requester.eval.ts)                                      |
| A recheck denies a change frozen for the requester                        | [recheck-denies-at-run-time](./approvals/recheck-denies-at-run-time.eval.ts)                                            |
| A typed reply cannot answer a policy-gated approval                       | [typed-reply-never-answers-policy-gated](./response-policies/typed-reply-never-answers-policy-gated.eval.ts)            |
| A rejected responder leaves the approval open                             | [rejected-responder-leaves-approval-open](./response-policies/rejected-responder-leaves-approval-open.eval.ts)          |
| An allowed responder settles the approval                                 | [allowed-responder-settles](./response-policies/allowed-responder-settles.eval.ts)                                      |
| A responder's authorization, then settlement                              | [responder-authorization-then-settles](./response-policies/responder-authorization-then-settles.eval.ts)                |
| Budget question holds the turn                                            | [budget-question-holds-the-turn](./budget/budget-question-holds-the-turn.eval.ts)                                       |
| Continue resumes the same turn                                            | [continue-runs-the-same-call](./budget/continue-runs-the-same-call.eval.ts)                                             |
| Message waits behind the budget question                                  | [message-waits-behind-budget](./budget/message-waits-behind-budget.eval.ts)                                             |
| Typed Continue answers the budget question                                | [typed-continue-answers](./budget/typed-continue-answers.eval.ts)                                                       |
| Cancel withdraws the budget question                                      | [cancel-withdraws-budget-question](./budget/cancel-withdraws-budget-question.eval.ts)                                   |
| Stop cancels the turn, resolving once                                     | [stop-cancels-once](./budget/stop-cancels-once.eval.ts)                                                                 |
| No step starts behind the budget question                                 | [no-step-behind-budget](./budget/no-step-behind-budget.eval.ts)                                                         |
| A late budget answer is dropped                                           | [stale-budget-answer-dropped](./budget/stale-budget-answer-dropped.eval.ts)                                             |
| An authorization holds the turn; the callback resumes it as the requester | [authorization-holds-then-resumes-as-requester](./authorizations/authorization-holds-then-resumes-as-requester.eval.ts) |
| Steering declines an authorization and tells the model                    | [steer-declines-authorization](./authorizations/steer-declines-authorization.eval.ts)                                   |
| Cancel declines an authorization                                          | [cancel-declines-authorization](./authorizations/cancel-declines-authorization.eval.ts)                                 |
| An approved call that needs an authorization                              | [approved-call-needs-authorization](./authorizations/approved-call-needs-authorization.eval.ts)                         |

| A sibling sign-in is emitted beside an approval; newer attempts replace older ones | [newer-attempt-supersedes](./authorizations/newer-attempt-supersedes.eval.ts) |

The rule that the model never runs while a request is open is checked inside
the evals above by `expectNoModelCallWhileOpen` and
`expectNoModelCallDuringAuthorization` ([helpers](./helpers.ts)).

## Not covered here

- **Candidate expiry.** A candidate times out after a 10-minute wall-clock
  TTL, and e2e cannot advance the clock. Covered by
  `harness/hitl/candidates.test.ts` ("expires only candidates whose deadline
  has passed") and `harness/hitl/coordinator.test.ts` ("completes an expired
  candidate without executing policy").
- **A `once()` grant hidden while an approval for its key waits.** Policies
  only run at a step's start or right before an approved call, and neither
  happens while that approval waits, so HTTP cannot observe the hiding.
  Covered by `harness/session-machine/machine.test.ts` ("grants a once()
  approval's key, except to a call still asking for it").
- **An approved tool removed before the answer.** Step tools persist with
  their step, so only a redeploy between the ask and the answer removes one.
  Local e2e cannot redeploy.
- **A fresh relayed batch replacing an older one.** This needs a child or
  remote agent to ask again from the same source while its earlier batch is
  open. Each workflow `ctx.ask()` is its own source. Covered by
  `harness/proxy-input-requests.test.ts` ("replaces prior entries for the same
  child continuation token").
- **Handoff blocked while a request is open.** This needs a deployment
  handoff, which only the Vercel redeploy suite performs.
