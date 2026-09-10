# Task eval transitions

## Completion batching measurement

`task.parent.wake.emitted-ready.batching.eval.ts` launches ten children behind
approval gates. The burst case releases nine together; the staggered case releases
each child only after the parent has finished responding to the previous one.
The last child stays blocked while the eval verifies silence and sends a user
question, then completes to produce a report containing all ten distinct results.

Each case logs a JSON `task-batching` record with completion-driven parent turns,
model steps, silent and visible messages, and completions per turn. Setup wakes
and the user question are excluded. The scripted model always obeys the silence
policy, so this measures the runtime cost of perfect compliance; the real-model
prompt ablation lives in `agent-task-reporting`.

Batching is automatic. Both schedules run against the same runtime.
The first completion's mock model call takes ten seconds, allowing later burst
completions to enter the active parent's buffer. This delay belongs to the test
model; the runtime adds no timer. The cases allow three minutes because the
Vercel staggered run exceeded the previous two-minute timeout.

At `76a18ee1`, the same burst workload with the previous option off/on took
10/4 parent model steps in the local world. The staggered control took 10/10.
Those measurements are retained in PR #3144; future runs exercise the default
behavior and log their actual counts.

Callback timing still varies across workflow worlds. Compare the observed batch
sizes and model-step counts, not an assumed ten-to-one gain. The unit test at the
delivery boundary separately proves that 100 buffered sibling completions become
one parent turn with every payload and its metadata preserved.
Counts are measurements, not fixed assertions that would prohibit improvements.
The staggered case is a control for active-parent coalescing: it intentionally
leaves no opportunity to merge adjacent completions. A policy that withholds all
intermediate deliveries until cohort settlement needs a different driver because
this case waits for each delivery before releasing the next child.

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
