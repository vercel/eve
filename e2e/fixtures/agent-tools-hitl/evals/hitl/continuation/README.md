# User-message continuation

Every accepted user message must reach its own answer, required input request, or explicit failure/cancellation. An older unanswered request cannot silently stop that message's work.

This directory contains **37 scripted evals: 23 regressions and 14 controls**. They exercise the HTTP session, approval, tool, workflow, and event-stream paths. A deterministic model chooses calls and constructs answers from the results it receives. There is no model judge and no manually seeded pending state.

These sessions select the scripted model through a fixture-only header in **every** CI world, including Local. The sibling [`pending-approval-tool-followup.eval.ts`](../pending-approval-tool-followup.eval.ts) adds two cases using the CI-selected model: real models in Local, the fixture mock in Postgres and Vercel. Passing scripted cases does not establish live-model coverage of the whole matrix.

Start with [`read.eval.ts`](./read.eval.ts): leave a change's approval pending, ask for a draft status, require its answer, then approve the saved change. Other cases vary the pending requests, delivery order, or result type.

## Scenario syntax and classification

Each body uses **Given / When / Then** comments to identify the initial state, accepted input, and observable outcome. `defineEval.description` names the scenario. Native `tags` classify role (`regression` or `control`), triggering input (`user-message` or `input-response`), and behavior (`tool-result`, `tool-error`, `validation`, `workflow`, `provider-result`, `approval`, `authorization`, `partial-approval`, `stale-response`, `budget`, or `text-reply`). Every case also carries `hitl` and `continuation`.

The tags are filters, not expected verdicts: every case must pass. `eve eval --tag regression`, `--tag control`, or `--tag partial-approval` selects the corresponding conversations. This is ordinary executable `defineEval` code with native assertions; Given / When / Then is not a separate executable spec language.

## What makes a passing answer

[`expectReply`](./helpers.ts) requires exactly one matching `message.completed`, followed by exactly one `turn.completed`, both attributed to the same turn. A tool result, unrelated reply, or completion without an answer cannot pass. New messages use their own `message.received` turn ID. Approval responses require successful resolution of the saved request before its matching reply and completion in the delivery's resumed turn. Multiple responses accepted together can resolve across several steps of that one turn; a later resolution need not emit another `turn.started`.

Each approval ID is saved when emitted. The driver's latest-turn request list is not treated as durable pending state. Tests check that unrelated replies do not execute the old change, then generally approve the saved request and require its execution and completed reply. Budget cases require the next budget request instead of an answer beyond the granted limit.

## Regressions

Each row maps to exactly one eval. “Response authorization” here means the fixture checks the authenticated responder's principal; it does not exercise an OAuth callback.

| Conversation                                                             | Required outcome                                                                         | Eval                                                                 |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Read while A waits                                                       | Report returned status; A remains answerable                                             | [read](./read.eval.ts)                                               |
| Write while A waits                                                      | Confirm exactly one write; A remains answerable                                          | [write](./write.eval.ts)                                             |
| Parallel read and write while A waits                                    | Report both results                                                                      | [parallel tools](./parallel-tools.eval.ts)                           |
| Tool throws while A waits                                                | Explain the actual error                                                                 | [tool error](./tool-error.eval.ts)                                   |
| Invalid tool input while A waits                                         | Correct input and report the result                                                      | [invalid input](./invalid-input.eval.ts)                             |
| Response-authorized approval waits                                       | Finish an unrelated read                                                                 | [authorized pending](./authorized-pending.eval.ts)                   |
| Approve newer B while A waits                                            | Execute B, read, and reply                                                               | [approve sibling](./approve-sibling.eval.ts)                         |
| Cancel newer B while A waits                                             | Leave B unexecuted, read, and reply                                                      | [cancel sibling](./cancel-sibling.eval.ts)                           |
| Approve newer response-authorized request while A waits                  | Settle authorization, read, and reply                                                    | [authorized sibling](./authorized-sibling.eval.ts)                   |
| Approve older response-authorized request while newer A waits            | Read and reply; A remains answerable                                                     | [authorized older sibling](./authorized-older-sibling.eval.ts)       |
| Approve older ordinary A while a newer response-authorized request waits | Reply for A; newer request remains answerable                                            | [ordinary older sibling](./ordinary-older-sibling.eval.ts)           |
| Workflow completes while A waits                                         | Interpret its result                                                                     | [workflow result](./workflow-result.eval.ts)                         |
| Provider supplies a tool result while A waits                            | Report the distinct provider result                                                      | [provider result](./provider-result.eval.ts)                         |
| Submit A from a same-batch A+B pair, then request a read                 | Complete the read; later B executes both changes once and completes a reply              | [partial approval, tool](./partial-approval-tool.eval.ts)            |
| Submit A from a same-batch A+B pair, then request text only              | Complete a reply without tools; later B executes both changes once and completes a reply | [partial approval, text](./partial-approval-text.eval.ts)            |
| Repeat a resolved response while A waits                                 | Process the new input without authorizing A                                              | [stale response](./stale-response.eval.ts)                           |
| Grant another budget window while A waits                                | Run one tool, then request the next required grant                                       | [budget grant](./budget-grant.eval.ts)                               |
| Submit A and B from one batch in separate deliveries                     | Accumulate both responses, execute both once, and reply                                  | [separate approval responses](./separate-approval-responses.eval.ts) |

## Controls

| Conversation                                            | Required outcome                                                                 | Eval                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Read without older input                                | Report returned status                                                           | [read](./read.control.eval.ts)                                   |
| Write without older input                               | Confirm exactly one write                                                        | [write](./write.control.eval.ts)                                 |
| Parallel tools without older input                      | Report both results                                                              | [parallel tools](./parallel-tools.control.eval.ts)               |
| Tool throws without older input                         | Explain the error                                                                | [tool error](./tool-error.control.eval.ts)                       |
| Invalid input without older input                       | Correct input and report result                                                  | [invalid input](./invalid-input.control.eval.ts)                 |
| Workflow without older input                            | Interpret its result                                                             | [workflow result](./workflow-result.control.eval.ts)             |
| Provider result without older input                     | Report distinct provider result                                                  | [provider result](./provider-result.control.eval.ts)             |
| Budget renewal without older approval                   | Run one tool, then request next grant                                            | [budget grant](./budget-grant.control.eval.ts)                   |
| Text-only message while A waits                         | Reply without tools; A remains answerable                                        | [text only](./text-only.control.eval.ts)                         |
| Resolve the only approval                               | Execute, read, and reply                                                         | [resolve only approval](./resolve-only-approval.control.eval.ts) |
| Approve both calls together                             | Execute each once and reply                                                      | [approve both](./approve-both.control.eval.ts)                   |
| Workflow finishes beside an approval from the same turn | Observe workflow completion before approval; require approval before final reply | [same-turn workflow](./same-turn-workflow.control.eval.ts)       |

## Evidence boundaries

The [adversarial integration probes](../../../../../../packages/eve/src/harness/issue-3494-adversarial.integration.test.ts) also cover `final_output` with an older approval, multiple independent approvals plus an internally deferred message, and a complete independent batch beside a partially answered batch. Those exact scenarios are **integration-only**, not extra E2E cases. Integration workflow results are injected at runtime boundaries; the E2E cases execute fixture tools through the durable runtime.

Partial approvals in E2E use an accepted HTTP response followed by a separate user message; the API rejects combined message/response payloads. The provider cases supply a provider-executed result at the scripted model stream boundary; they do not contact a provider that performs the tool. Budget scripts report synthetic token usage against the fixture's one-million-output-token limit.

These tests serialize inputs. They do not establish restart/replay safety, concurrent-delivery correctness, child-agent settlement, OAuth recovery, or every provider/channel combination. Run E2E only in CI. A timeout identifies a runtime regression only when the captured events establish that the intended setup and tool path ran; a fixture error is not such evidence.
