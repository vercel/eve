---
issue: https://github.com/vercel/eve/issues/876
status: implemented
last_updated: "2026-09-04"
---

# Multi-call Workflow steps

## Summary

Today one eve model step — one turn-model call and the inline tool calls it
makes — runs in one durable Workflow step. This gives every model step its own
checkpoint, but it also pays Workflow scheduling and persistence overhead
between sequential tool cycles.

Add an experimental per-agent option that runs up to N adjacent model steps in
one Workflow step:

```ts
import { defineAgent } from "eve";

export default defineAgent({
  model: "openai/gpt-5.6-luna",
  experimental: {
    maxModelCallsPerWorkflowStep: 4,
  },
});
```

The default remains `1`. The value is a positive integer and is a ceiling: a
turn that finishes or must park after fewer calls exits the Workflow step
immediately.

This option deliberately widens the replay unit. If call 3 is interrupted,
calls 1–3 in that Workflow step may run again, including their inline tools.
Authors opting in must make affected side effects idempotent and must accept
duplicate model spend and stream events after recovery.

## Execution boundary

Keep `createToolLoopHarness` at `stopWhen: isStepCount(1)`. It remains the owner
of exactly one logical eve step, including step events, tool execution,
compaction, dynamic capability resolution, session limits, and result handling.

Add only a bounded loop around the existing harness invocation in
`turnStep`:

```text
one durable Workflow turnStep
  ├─ existing harness step 0
  ├─ existing harness step 1
  ├─ ... up to configured N
  └─ return one durable result to the turn workflow
```

After each model call, run the existing framework context-provider commit in
memory and feed its returned session into the next call. These intermediate
sessions are visible to later calls in the same batch but are not durable until
`turnStep` returns successfully.

Continue inside the current Workflow step only when all are true:

- the harness returned `next: runStep` with no pending input request;
- fewer than N model calls have run; and
- the result did not start a background task that needs the parent commit
  barrier.

Every other result returns to the turn workflow immediately. Existing paths
therefore keep a durable boundary before external coordination:

- approval, question, and authorization parks;
- blocking workflow-tool and subagent dispatch;
- background-task acknowledgement;
- cancellation, failure, and terminal turn settlement.

Provider-executed tools and ordinary authored tools remain inline and do not
force an early checkpoint. eve does not attempt to infer whether a tool is
idempotent; the agent-level opt-in is the entire policy.

## Observable semantics

Logical eve steps do not change. Each model call still increments `stepIndex`
and emits its own `step.started`, action events, `step.completed`, usage, and
instrumentation. History and state observed by the next model call are the same
as with `1`.

Only durability changes:

| Behavior                 | Default (`1`)                             | Experimental (`N > 1`)                              |
| ------------------------ | ----------------------------------------- | --------------------------------------------------- |
| Workflow checkpoint      | after every model call                    | after at most N model calls                         |
| Crash replay             | current model/tool cycle                  | every uncommitted cycle in the batch                |
| Inline tool side effects | may repeat for the interrupted cycle      | may repeat for earlier cycles in the batch          |
| Model charges            | current interrupted call may repeat       | earlier calls in the batch may also repeat          |
| Stream recovery          | interrupted step events may be duplicated | events from the uncommitted batch may be duplicated |
| Approval/auth/task waits | durable boundary                          | unchanged durable boundary                          |

Compaction summary calls and in-process retries do not consume the N budget;
the setting counts completed turn-model steps. A cancellation rolls session
state back to the beginning of the Workflow step, while already completed
external effects and stream writes remain observable, matching existing
interrupted-step semantics over a larger unit.

## Implementation

1. Add `experimental.maxModelCallsPerWorkflowStep?: number` to the public agent
   definition and carry it through compiled-manifest validation, cloning, and
   runtime resolution. Reject non-positive, non-integer values. Static root and
   subagent definitions may select it; dynamic subagent configuration continues
   to reject all experimental fields.
2. In `execution/workflow-steps.ts`, extract the current single harness
   invocation into a small helper and call it in a bounded loop. Re-enter
   `runBackgroundStep` for every logical model step so session, connection,
   sandbox, and background-tool providers retain their existing per-step
   lifecycle. Stop before another model call when the result carries
   `backgroundTasks` or its session still has a pending input batch.
3. Leave the harness, `StepResult`, turn-workflow protocol, durable session
   schema, stream protocol, and AI SDK `stopWhen` unchanged. No scheduler,
   batch object, tool annotation, or recovery path is added.
4. Document the option beside Workflow configuration and replace the blanket
   one-call durability statement with the default plus the explicit opt-in
   replay tradeoff. Add a patch changeset.

## Verification

- Public-definition and manifest tests accept positive integers, reject invalid
  values, and preserve the default when omitted.
- Focused `turnStep` tests prove a configured batch can complete three ordered
  model steps in one call, the omitted option preserves one step, and pending
  input or a background task ends the batch.
- The `agent-tools` end-to-end fixture enables a three-call ceiling and runs its
  deterministic sequential two-tool eval through the compiled public config.
- Before the option is recommended beyond experiments, a hosted paired runtime
  benchmark should compare `1`, `2`, `4`, and `8` on a deterministic sequential
  tool chain. It should show the expected reduction in `turnStep` count and a
  material latency improvement without changing model call count or protocol
  output.

## Out of scope

- Automatic idempotency, exactly-once side effects, or per-tool eligibility.
- Batching across a park, background-task commit barrier, or runtime-action
  dispatch.
- Changing model parallel tool-call behavior within one model response.
- Changing the default from `1` or promising a stable experimental API.
