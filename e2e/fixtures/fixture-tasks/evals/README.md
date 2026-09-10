# Task eval transitions

## Full-cohort completion barrier

`task.parent.wake.emitted-ready.conditional-delivery.eval.ts` routes Alice and
Bob's inventory handoff to the real CI model for both delegation and reporting.
It is tagged `real-model`, so world suites exclude it. The existing fanout workers
remain deterministic; each needs a separate approval before returning its marked
result. No parent responder scripts silence or supplies an empty-delivery sentinel.

The eval starts three distinct tasks in one parent turn. It releases two in
sequence, observes their completed child turns, and asks an unrelated user question
while the third approval remains pending. It then releases the final child. The
parent stream is read from the cursor captured before those releases, not from a
new tail: an intermediate model turn fails even if it produces no visible text.
The only parent model steps after setup must be the user answer and one cohort
report. Every known task ID and all three distinct outputs must appear once.

`task.parent.wake.emitted-ready.batching.eval.ts` uses the same driver for ten
scripted children in burst and staggered release schedules. The driver sends
approval responses without waiting for a parent model turn and observes child
completion before advancing. Both schedules require zero intermediate completion
model steps and one full-cohort report. The mock no longer delays inference or
returns a silence sentinel; an incomplete-cohort model invocation is an error.
Each case still logs its `task-batching` metrics.

`task.join.evaluate.observed-partial.eval.ts` establishes partial completion on
one child's stream while the other still awaits approval. An independent user
status request receives WAITING without a completion-driven model step. Releasing
the remaining sibling then delivers both task IDs in one COMPLETE turn. The
transition metadata separates lifecycle readiness from parent admission: successes
wait for all original siblings, even across unrelated user turns and cohorts;
input, authorization, failures, and cancellation bypass that hold.

The separate `agent-task-reporting` fixture uses the same approval-gated approach
with real models for the parent, children, and a nested warehouse lookup. It covers
an intervening user answer and compaction without waiting for partial parent wakes.

## Remote callback routing regression

`task.input.answer.accepted-complete.remote.eval.ts` reuses the existing remote
HITL and completion round trip to cover the callback-prefix bug from
[eve #3047](https://github.com/vercel/eve/pull/3047). The fixture's `vercel.json`
sets the service route to `/eve/v1`.

The eval uses event assertions labeled "remote input callback reaches the parent"
and "remote completion callback reaches the parent". It also logs which delivery
it is waiting for. These assertions check the live round trip through the public
eval APIs; they do not inspect the generated callback URL.

The [build scenario](../../../../packages/eve/src/internal/nitro/host/build-application.scenario.test.ts)
separately checks that this service route adds no extra public prefix. Local and
Postgres runs exercise the remote round trip, but only the Vercel build exercises
service-prefix inference.

## Child tool surface and completion

`task.lifecycle.complete.accepted-nonterminal.child-tool-surface.eval.ts` uses a
mock child in every suite to report its actual advertised tool names. It checks
that `task_update` is absent and the final report reaches the parent with the
correct task identity. Tool and workflow progress remain covered separately by
`agent-background-tools` and `agent-workflow-tools`.

## Transition declarations

These evals are executable evidence for the background-task contract. They do
not define that contract.

When sources disagree, use this precedence:

1. `research/tools-as-tasks.md` for settled externally observable intent.
2. Public tool and protocol contracts.
3. `packages/eve/src/tasks/types.ts` and `transitions.ts` for executable
   lifecycle semantics.
4. Evals and lower-level implementation as evidence.

Every `*.eval.ts` case uses `defineTaskEval` and declares exactly one primary
transition. The canonical specification in `task-transition.ts` supplies its
pre-state, semantic input, guards, outcome, post-state, events, and side
effects. `setup` records prerequisite transitions but does not claim coverage
for them.

Transition anchors follow:

```text
<machine>.<entity>.<input>.<outcome>[-<guard>]
```

Anchors describe semantics, never document order. Scenario variants such as
local and remote transport share an anchor and use a filename suffix plus the
`dimensions` declaration. Presentation labels such as A2 or C7 are not stable
identity.

State is factored across lifecycle, outstanding input, executor binding,
dispatch admission, agent occupancy, parent phase, transport, ownership, and
usage. A scenario declares only dimensions relevant to its primary transition;
it must not enumerate their Cartesian product.

`pnpm validate:transitions` enforces declaration and filename identity. The
fixture `typecheck` command runs that validation before building and checking
TypeScript.
