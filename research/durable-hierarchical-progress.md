---
issue: https://github.com/vercel/eve/issues/1673
status: proposed
last_updated: "2026-08-14"
---

# Durable hierarchical progress

## Summary

eve should maintain a durable, framework-owned work graph for the active turn
and its delegated work. The graph should derive from authoritative runtime
lifecycle state, compose through child sessions, and remain independent of
channel effects. A root channel can render a selected view without rebuilding
execution ownership from raw streams.

```text
runtime lifecycle + task updates
                │
                ▼
       durable work graph
                │
                ▼
    channel-specific presentation
```

The implementation experiment validated the main boundary:

- ordinary turn, step, action, blocker, and child-task state can reduce into a
  useful graph without authored progress calls;
- Slack can render compact status and hierarchical activity from the same graph;
- channel presentation state needs explicit ownership across parent and
  rendering workflows;
- polling child streams adds orchestration and does not scale to background or
  remote work, so it should not be part of the proposed architecture.

Since the original proposal, eve also gained child-authored `task_update`
notifications for background tasks in [PR #2113](https://github.com/vercel/eve/pull/2113).
Those updates provide immediate semantic milestones over the existing task
transport. They complement rather than replace the observed work graph: a task
update says what the child chooses to report, while the graph records what the
runtime can verify.

The next design step should combine those sources before adding a broad public
progress API. In particular, this proposal no longer recommends introducing
`ctx.reportProgress()` as the immediate next layer.

## Problem

Channels currently infer progress independently from low-level stream events.
Slack, for example, can derive status text from turn start, reasoning, assistant
narration, action requests, visible output, and terminal events. That state is
implicit and channel-local.

Delegated sessions make the gap clearer. A parent owns a child action and
receives its terminal result, but the child's ordinary step and action lifecycle
does not appear in the parent session stream. A channel that wants to show
parallel delegated work must otherwise attach to child streams and reconstruct
ownership, ordering, and terminal state itself.

The missing primitive is durable work ownership:

> What work is currently active, blocked, or terminal, and what direct child
> work does it own?

A free-form status message alone cannot answer that question. Conversely, an
observed graph cannot always explain the child's semantic goal. eve needs a
clear boundary between observed execution facts, child-authored milestones,
and presentation.

## Design principles

1. **Observed work is the core.** The graph records runtime truth: the active
   turn, model steps, actions, blockers, and delegated children.
2. **Authored updates annotate observed work.** A child milestone may add useful
   text to its owning action, but it does not redefine lifecycle phase.
3. **Plans are separate intent.** A todo list may attach to a turn, but it does
   not define execution truth or imply action-to-plan-item edges.
4. **The graph is desired state, not history.** The durable event stream remains
   the complete audit trail.
5. **Reduction is framework-owned.** Agents do not customize graph invariants,
   child revisions, retention, or terminal precedence.
6. **Task runs own child delivery.** Parents consume durable task views and
   deduplicated task notifications rather than raw child events.
7. **Reuse task delivery.** Terminal results, input, authorization, and explicit
   task updates use the existing task inbox or callback transport. Progress
   must not introduce child-stream readers or polling workflows.
8. **Presentation belongs to channels.** The graph contains no Slack blocks,
   message IDs, API operations, or presentation timers.
9. **Blockers are first-class.** Waiting for input, authorization, or approval is
   authoritative state, not an absence of progress.
10. **Terminal state wins.** Late or replayed updates cannot resurrect settled
    actions or channel activity.

## Proposed core semantics

### Session-relative work graph

The initial graph should remain small and internal. A session-relative shape is
sufficient. Delegated task nodes provide hierarchy without importing a child's
raw event stream:

```ts
type WorkPhase = "queued" | "running" | "blocked" | "completed" | "failed" | "cancelled";

interface WorkGraph {
  readonly revision: number;
  readonly turn?: WorkTurn;
}

interface WorkTurn {
  readonly id: string;
  readonly phase: WorkPhase;
  readonly steps: readonly WorkStep[];
  readonly blockers: readonly WorkBlocker[];
}

interface WorkStep {
  readonly stepIndex: number;
  readonly phase: WorkPhase;
  readonly actions: readonly WorkAction[];
}

interface WorkAction {
  readonly callId: string;
  readonly kind: "tool-call" | "load-skill" | "subagent-call" | "remote-agent-call";
  readonly name: string;
  readonly phase: WorkPhase;
  readonly detail?: string;
  readonly update?: WorkUpdate;
  readonly task?: {
    readonly taskId: string;
    readonly sessionId?: string;
    readonly phase: WorkPhase;
  };
}

interface WorkUpdate {
  readonly id: string;
  readonly message: string;
  readonly source: "task-update";
}

interface WorkBlocker {
  readonly id: string;
  readonly kind: "input" | "authorization" | "approval";
  readonly phase: "blocked" | "completed" | "cancelled";
  readonly ownerCallId?: string;
}
```

The exact serialization and public names are not committed here. The graph
should remain internal until its lifecycle and presentation consumers
stabilize.

### Planless turns

Every turn already has model-step and action boundaries. A planless graph uses
those boundaries directly:

```text
turn [running]
├── step 0 [completed]
│   ├── search docs [completed]
│   └── read source [completed]
└── step 1 [running]
    ├── run reproduction [running]
    └── researcher [running]
        └── Inspecting the deployment trace
```

Actions observed under the same `stepIndex` are siblings. A delegated action
owns a task node whose lifecycle comes from the durable task view and whose
current semantic detail may come from `task_update`. Tool inputs may contribute
bounded deterministic detail when a renderer-safe field is known, but the graph
must not expose arbitrary arguments or infer future work.

The graph does not infer a plan, user intent, or a relationship between an
action and a hypothetical task.

### Blocked work

A blocker belongs to the turn and may identify its owning action:

```text
turn [blocked]
├── update feature flag [blocked]
└── approval [blocked]
    └── owner: update feature flag
```

When the blocker resolves, the same blocker settles and the turn resumes. It is
not replaced with an unrelated status.

### Scope compaction

The live graph is not an audit log:

- retain active and blocked actions;
- retain completed actions while their surrounding work remains useful to the
  active presentation;
- collapse completed step internals as the turn advances;
- retain failure or cancellation detail needed to explain the outcome;
- retain active task nodes until their owning action settles;
- remove the completed turn from live session state after settlement;
- preserve the full sequence in the existing durable event stream.

The implementation experiment retained completed child actions so Slack could
show observed stage history. Without child event propagation, free-form task
updates contribute one current semantic detail rather than recreating that
history. Any future history must be explicitly bounded.

## Child updates and work composition

Merged background-task support gives task-owned children one immediate update
path for local and remote execution:

```text
task-owned child
  └── task_update({ message })
        └── local task inbox or remote callback
              └── deduplicated parent delivery
                    └── work graph reduction
                          └── channel rendering
```

This path resolves the main orchestration question from the original proposal.
eve should not consume child event streams or poll child-owned projections.
Those approaches add serverless invocations, scale with the number of children,
and do not naturally cover tasks that outlive a parent turn. The durable task
run already owns child routing, deduplication, lifecycle transitions, and parent
wake policy.

### Keep `task_update` free-form

`task_update({ message })` should remain a separate child-only tool with one
terse, activity-focused message. It should not accept work-graph structure or
let the child claim lifecycle status.

```ts
task_update({
  message: "Inspecting the deployment trace",
});
```

Keeping the tool free-form preserves a useful division of authority:

- the child describes its current semantic activity;
- the task run owns durable task identity and delivery;
- the runtime owns `working`, `input_required`, and terminal lifecycle state;
- the work reducer binds the update to the owning task or action;
- the parent channel decides what to expose.

A structured progress tool would let a model duplicate or contradict facts the
runtime already knows. Numeric progress, nested item creation, and phase changes
should therefore stay out of `task_update` until a concrete use case cannot be
represented by task lifecycle plus one current message.

### Add structure at the transport boundary

The model-facing tool can stay free-form while the framework notification gains
the identity needed for deterministic reduction. The current delivery ID already
uses task, child turn, child step, and tool call identity. The work reducer
should receive equivalent internal metadata:

```ts
interface TaskWorkUpdate {
  readonly kind: "task-update";
  readonly taskId: string;
  readonly childTurnId: string;
  readonly childStepIndex: number;
  readonly callId: string;
  readonly message: string;
}
```

The task update does not need a child-authored revision. Its existing identity
forms an idempotency key, and each accepted update replaces the current message
on the owning task node. The graph stores bounded desired state, not an update
history.

The task view should remain the lifecycle source of truth. Whether the current
message also belongs in `TaskView` requires a separate decision: persisting it
there makes `task_peek` and late renderers consistent, but changes a model-
visible task contract. The narrow first integration can project the update into
the active parent work graph without expanding `TaskView`.

### Parent wake policy

`task_update` currently sends a deduplicated parent delivery. A parked parent may
start a turn, and an active parent observes it at a safe boundary. That behavior
is appropriate for agent-to-agent communication, but presentation should not
require a new model turn for every update.

The integration should split one accepted update into two consumers:

```text
accepted task update
  ├── parent notification for model awareness
  └── framework work update for channel presentation
```

Both consumers use the same task identity and deduplication key. The channel
consumer must not append the message to model history or independently change
task lifecycle state. If immediate channel rendering cannot reuse the parent
notification without waking model execution, the task run should emit a
framework-owned presentation callback rather than reintroducing polling.

### Non-task subagents

A synchronous declared subagent that is not task-owned has no explicit
intermediate-update transport. Without polling or child stream attachment, its
parent graph can show dispatch, running, blockers already proxied to the parent,
and terminal settlement, but not the child's internal tool ladder.

That is an acceptable boundary for the first integration. Fine-grained child
activity should require task ownership and `task_update` rather than adding a
second transport for ordinary subagents. If synchronous subagents later need the
same capability, eve should generalize the task notification transport instead
of reviving child stream polling.

### Terminal precedence

Task lifecycle remains authoritative when updates race settlement:

- buffer a fast update until task dispatch is acknowledged;
- deliver buffered updates before the terminal wake when they win the race;
- reject or ignore updates after the task is terminal;
- prevent a late presentation effect from recreating terminal channel activity.

A channel-specific renderer still owns external message identity and terminal
cleanup. The work graph expresses terminal desired state; it does not encode
Slack message operations.

## Slack as the proving ground

Slack is a consumer of the graph, not part of its contract.

### Compact status

The compact renderer selects one deterministic line from active work. It owns
human labels, truncation, blocker priority, parallel-child summarization, and
status clearing. Reasoning-derived status may remain a separate policy; raw
reasoning does not belong in the work graph.

### Hierarchical activity

The activity renderer maintains one transient Slack message with one native
`task_card` block per direct action or task. A task update supplies the current
rich-text detail without changing the card's framework-owned status:

```text
Researcher [in progress]
  Inspecting the deployment trace

Verifier [in progress]
  Validating the reproduction
```

The experiment established several presentation constraints:

- native `plan` blocks and standalone `task_card` details may collapse when a
  whole message is replaced with `chat.update`;
- Slack does not expose client expansion state through Block Kit;
- standard section blocks remain the predictable always-expanded fallback;
- Slack's `chat.startStream`, `chat.appendStream`, and `chat.stopStream` task
  updates are a better candidate for native live agent progress than repeated
  full-message replacement, but adopting them changes response ownership and
  needs separate design;
- the parent must own terminal cleanup so a late task update cannot leave live
  activity after the final response.

The current activity renderer should remain internal while those tradeoffs are
evaluated. A generic public channel progress hook is premature.

## Revised rollout

### 1. Internal work graph

Reduce existing turn, step, action, blocker, delegation, cancellation, and
failure facts. Prove deterministic identity and terminal precedence with unit
tests.

### 2. Task-update composition

Project merged `task_update` notifications onto the owning task or child action.
Preserve the free-form child tool while carrying stable task, turn, step, and
call identity through the internal notification.

### 3. Presentation delivery

Deliver changed work to channels without polling child streams or requiring a
new model turn for each presentation update. Reuse task-run deduplication and
terminal precedence. Keep this internal until the effect ownership is proven.

### 4. Slack consumers

Consume the same graph for compact status and hierarchical activity. Keep
message identity, Block Kit, API calls, fallback behavior, and terminal cleanup
inside Slack.

### 5. Remote and background validation

Validate the same task-update reduction for local tasks, remote tasks, concurrent
children, and tasks that outlive the dispatching turn.

Acceptance criteria:

- duplicate task updates do not append duplicate graph state;
- an update cannot revive a terminal task or action;
- a fast update that races terminal settlement converges on terminal state;
- local and remote task updates use the same annotation semantics;
- tasks remain useful without authored updates through their observed lifecycle;
- renderers can prefer a fresh semantic message without losing authoritative
  task lifecycle state;
- no child stream polling or monitor workflow is required.

### 6. Reassess authored tool progress

Do not add `ctx.reportProgress()` until task updates and streaming tool partials
have shown a missing authoring case. Preliminary tool results may already
provide a natural action-owned source for authored tools. MCP
`notifications/progress` still needs private `progressToken`-to-`callId`
correlation, attempt identity, coalescing, and terminal rejection.

If a common report shape remains necessary, design it from those proven sources
rather than adding a parallel side channel first.

## Follow-on hypotheses

### Structured plans

The framework todo is model-authored intent, not execution truth. A future
change may attach a structured plan beside the observed step ladder. No
action-to-plan-item edge should be inferred without an explicit protocol field.

### Generic channel API

Extract the smallest channel-neutral hook only after multiple channel consumers
or Slack presentation strategies prove a stable input and ownership model.

### Public observation

A future client event or hook may expose snapshots to authored observers.
Publishing the graph creates a durable protocol commitment and should follow
internal stabilization.

### Remote child observations

`task_update` covers semantic milestones for task-owned remote children, not a
complete remote internal action graph. A future remote protocol may expose more
observed structure, but it should not be a prerequisite for useful task status.

### Streaming Slack tasks

Slack's streaming task updates may avoid the collapse behavior caused by
`chat.update`. They also couple activity progress to a streaming response
message, so the design must define who starts and stops the stream, how replayed
updates deduplicate, and how the final response is delivered.

### Liveness

Elapsed time, remote liveness, and stall policy are operational concerns. Lack
of recent activity must not automatically imply failure.

## Verification strategy

Use the narrowest tier for each invariant:

- unit tests for pure reduction, compaction, task updates, and Slack rendering;
- integration tests for task-view composition and task-update projection;
- scenario tests for workflow replay, task-update delivery, cancellation, and
  terminal races;
- deterministic fixture evals for final Slack behavior.

The design is successful when:

- planless root work reduces deterministically;
- task work composes without child stream attachment or polling;
- authored task updates annotate rather than replace observed state;
- stale task updates cannot overwrite terminal state;
- compact and hierarchical renderers consume the same graph;
- the graph remains free of Slack state;
- ordinary tools and tasks remain useful without authored progress calls.

## Out of scope

- a custom agent reducer;
- authored retention counts;
- inferred action-to-plan-item ownership;
- raw reasoning in the work graph;
- exactly-once external message creation;
- a public remote work-graph protocol;
- automatic model summarization in canonical reduction;
- replacing the durable event stream with the live work graph.
