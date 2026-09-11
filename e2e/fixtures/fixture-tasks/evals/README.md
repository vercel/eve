# Task eval transitions

## Full-cohort completion barrier

This fixture uses a static mock model for scripted orchestration checks. Real-model
coverage lives separately in [`agent-task-reporting`](../../agent-task-reporting/evals/README.md),
whose agent uses `defineAgent(e2eAgentConfig())` without scenario-based routing.

`task.parent.wake.emitted-ready.batching.eval.ts` releases ten scripted children
in burst and staggered schedules. Each child needs a separate approval before
returning its marked result. The driver sends approval responses without waiting
for a parent model turn and observes child completion before advancing. It retains
the parent stream cursor from before the releases, so an intermediate completion-driven
model turn fails even if it emits no text. Both schedules require zero intermediate
completion model steps and one full-cohort turn. Every known task ID must be
delivered once, and the report must contain each distinct output once. Both cases
also require an unrelated user answer while the last child remains blocked. The
mock neither delays inference nor returns a silence sentinel; a completion-driven
model invocation before settlement is an error. Each case still logs its
`task-batching` metrics.

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

## Lifecycle ordering and overlapping launches

`task.parent.wake.emitted-ready.lifecycle-order.eval.ts` holds an unrelated parent
turn in a blocking Workflow hook. Task A returns successfully before B's child is
released. The fixture waits for A's task owner (not its child stream) to finish:
that owner awaits its real terminal inbox wake before returning. B then receives a
permanent mock-provider rejection after a successful metered model step. Its
background workflow catches the expected child failure and completes successfully.
The task owner's recorded forwarding steps must show invocation, settlement, then
completion, and the parent hook must still be active after both owners finish.
This establishes A completed → B agent-settled → B completed in the real queue.

The report must contain exactly both task receipts and outputs, once, through a
subsequent user-message acknowledgment. A separate follow-up turn echoes the actual
framework-rendered handle announcement: B's terminal child must not remain as an
available handle. Another check crosses the parent's configured one-million-input-token
budget: B supplies 211 input tokens, all ordinary parent responses supply zero,
and an accounting turn supplies 999,790. The next request must produce the
runtime-authored session-limit prompt with exactly 1,000,001 used tokens. Dropping
B's settlement therefore fails usage accounting even if the union report looks
correct. The enlarged fixture context window prevents this metered probe from
triggering compaction. B's terminal failure and original 211/37 token step are
also asserted on its real child stream.

`task.parent.wake.emitted-ready.cross-turn-cohort.eval.ts` launches A, acknowledges
its pending gate, then launches B in a different user turn. Both task-owner
creating-turn IDs must match their respective launch events and be distinct. The
two cases release A first and B first respectively. After the first owner's
completion acknowledgment, an independent user checkpoint must run without any
completion delivery while the other gate remains active. The final delivery is
exactly the union, never one report per creating turn. The mock reports received
notifications immediately; it does not implement its own cohort barrier.

The `/task-lifecycle/:sessionId/:action` channel is fixture-only. Random per-eval
keys scope control-stream reads; releases validate gate metadata against that key
and parent session. Reads, bodies, and owner-log audits are bounded. The route
only releases authored hooks and reads actual Workflow owner metadata; it never
inserts task lifecycle payloads, edits session state, or calls production routing
helpers. No production hook or internal/testing package export is needed. These
evals run only in CI, without timing sleeps or external services.

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
