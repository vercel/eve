# Background subagent steering

Steering must reach the existing background child before its original work completes, preserve its context, and produce one result reflecting the updated instructions; an unrelated follow-up must leave that work running.

This is a provisional acceptance contract for steering an
already-delegated assignment. These evals use synthetic assignments to detect
duplicate delegation and superseded results.

## Cases

[background-steering.eval.ts][eval] exports three cases:

| Case   | Parent when the follow-up arrives     | Expected child behavior                                                          |
| ------ | ------------------------------------- | -------------------------------------------------------------------------------- |
| `0000` | Finished acknowledging the delegation | Apply the steering message to the same child session.                            |
| `0001` | Waiting in its own tool call          | Cancel the parent turn and apply the steering message to the same child session. |
| `0002` | Waiting in its own tool call          | Answer an unrelated question; the original child finishes normally.              |

The eval observes the child's pending tool call before sending the follow-up
with the eval session driver's `start(message, { turnPolicy: "steer" })`.
The steering message is “Actually, use STEERED instead of ORIGINAL.” It does
not name the worker, repeat the memo, or tell the parent how to route it. The
unrelated follow-up asks “What is 2 + 2?” without instructions about background
work. The
[worker][worker] uses the same real matrix model as the parent and the existing
bounded [cancellation wait][wait] (90 seconds). Its [instructions][instructions]
ask it to return `WORKER-RESULT:ORIGINAL:<memo>` unless steering replaces
the label. The model must interpret the steering message, retain the original memo,
and return `WORKER-RESULT:STEERED:<memo>`; no scripted responder selects the
answer.

Assertions inspect the child stream and the parent's result-bearing task wake.
A parent acknowledgment alone cannot pass. All observed delegations must retain
the original `agentId` and `childSessionId`; the original child must not emit the
superseded result, and the parent must emit the expected result exactly once
through a subsequent queued checkpoint. This also catches duplicate result
wakes queued before that checkpoint; it does not prove absence of arbitrarily
late delivery.
The unrelated case must finish normally. Reset cleans up admitted tasks even
when an assertion fails.

Same-child continuation is provisional. The eval permits either in-turn
steering or cancellation followed by a new turn in that same child session;
it does not fix the task-id lifetime or require a particular steering tool.
It permits an acknowledgment of the steering message; acknowledgment wording and
count are outside this contract.

Both parent and child use the matrix model: the parent must identify and route
the steering message, and the child must apply it while retaining context. These cases carry `real-model`, so
mock world suites exclude them. They are acceptance tests, not assertions that
the existing limitation should remain. No expected-failure inversion or skip
hides a failure. Run them in CI from this fixture with
`pnpm exec eve eval --strict --tag background-steering`.

## Options to evaluate against these cases

| Option                                                        | Decision criterion                              | Boundary to verify                                                                                                                                                               |
| ------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parent calls `task_cancel`, then continues the same `agentId` | Smallest public API change: uses existing tools | Cancellation requests the child's stop, but continuation must wait until the old owner releases its claim. The eval must establish that this sequence is reliable.               |
| Explicit steering addressed to a busy `agentId`               | One model action with runtime-owned ordering    | Preserve the child and serialize cancellation/delivery with the existing task owner; prevent the superseded result from settling the new operation. The exact API shape is open. |
| Automatically propagate parent steering to children           | Least work for the parent model                 | A parent message contains no target child. Blanket propagation fails case `0002`; targeted propagation still needs a rule for selecting the affected assignment.                 |

Current source rejects a continuation claimed by another operation as
[`busy`][claim], mapped to [`AGENT_BUSY`][busy].
[`cancelBackgroundAgentTask`][cancel] requests cancellation of the owned child
turn; [`agent-settled`][settle] is a separate owner-release path. These are
source observations, not a measured verdict for the new evals. CI results are
needed before choosing whether existing composition is sufficient or a new
runtime operation is warranted.

[eval]: ./background-steering.eval.ts
[worker]: ../../agent/subagents/steering-worker/agent.ts
[instructions]: ../../agent/subagents/steering-worker/instructions.md
[wait]: ../../agent/subagents/sleeper/tools/wait-for-cancellation.ts
[claim]: ../../../../../packages/eve/src/subagents/handles/transitions.ts
[busy]: ../../../../../packages/eve/src/execution/tools/subagent/invoke-step.ts
[cancel]: ../../../../../packages/eve/src/execution/tools/subagent/task-cancel.ts
[settle]: ../../../../../packages/eve/src/execution/tools/subagent/task-agent-requests.ts
