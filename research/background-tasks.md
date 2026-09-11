---
issue: https://github.com/vercel/eve/issues/1084
status: proposed
last_updated: "2026-07-23"
---

# Task-handle tool execution

## Summary

eve currently treats every model-initiated tool call as a blocking operation.
The harness cannot continue the model loop until the call has produced its
final tool result. Parallel calls can run concurrently, but the slowest call
still blocks the whole step. This is a poor fit for voice and other real-time
agents, and it prevents an agent from doing useful work while a slow operation
runs.

Add an experimental execution mode in which every eve-executed work tool
immediately returns an opaque task handle:

```ts
export default defineAgent({
  experimental: {
    toolExecution: "tasks",
  },
});
```

```json
{
  "taskId": "task_01K…",
  "status": "working",
  "scope": "turn"
}
```

The agent controls what happens next. It can await the task to recover today's
blocking behavior, inspect status and progress, cancel it, or detach it so the
work may outlive the current turn. A durable `sleep` control supports paced
polling and intentional delays without holding compute.

This is one execution model, not separate synchronous and background modes.
Every eligible invocation becomes a task; "blocking" means only that the agent
chose to await its handle.

The task lifecycle follows the experimental
[MCP Tasks extension](https://modelcontextprotocol.io/extensions/tasks/overview)
where the semantics fit:

```ts
type TaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";
```

eve owns its authoring API, persistence, controls, and notification transport.
MCP wire compatibility is not part of this proposal.

## Goals

- Let the model continue within a turn while tool work is still running.
- Make today's blocking behavior an explicit `await_tasks` operation.
- Let an agent safely allow selected work to survive the originating turn.
- Preserve provider-valid, append-only tool-call history.
- Keep approvals, OAuth, questions, cancellation, progress, and result
  delivery durable.
- Apply one lifecycle to authored tools, built-ins, connections, Workflow, and
  subagents.
- Preserve all existing behavior unless the experimental mode is enabled.

## Non-goals

- Exposing eve tasks over the MCP Tasks wire protocol.
- Making provider-executed tools task-addressable or cancellable by eve.
- Rolling back external side effects when a task is cancelled.
- Adding automatic retries for tool work with unknown idempotency.
- Streaming arbitrary task output into model context.
- Defining cross-session task sharing or public task URLs.

## Model-facing contract

### Execution classes

The mode has two execution classes.

**Task-based work tools** are calls that eve executes and whose lifetime eve
can control:

- authored and dynamic tools;
- built-in work tools;
- MCP and other connection tools;
- Workflow;
- local and remote subagents.

These calls immediately return task handles.

**Synchronous tools** continue to block the harness until they finish.
Framework controls remain inline because wrapping them would either recurse or
break their control-flow role:

- `await_tasks`;
- `peek_tasks`;
- `cancel_tasks`;
- `detach_tasks`;
- `sleep`;
- `ask_question`;
- `load_skill`;
- `final_output`.

Provider-executed tools, such as a provider's native `web_search`, also remain
available and synchronous. eve cannot create a handle before those tools
start, observe their lifecycle, or cancel them, but that does not make them
incompatible with the model. They behave like `load_skill`: the agent may use
them normally and accepts that the current model step blocks until they
finish.

Unknown tools and schema-invalid calls remain ordinary protocol errors because
there is no valid invocation to schedule. Every known, valid eligible call
gets a task handle before approval, authentication, or execution begins.

### Immediate receipt

The original tool-call position is completed exactly once with a receipt:

```ts
interface TaskReceipt {
  readonly taskId: string;
  readonly status: "working";
  readonly scope: "turn";
}
```

The receipt is intentionally small and timing-independent. It always reports
the initial state even if an extremely fast task completes before the model
reads it. Current state comes from the task controls.

The eventual output is never inserted as a second result for the original
call. It reaches the model only through `await_tasks`, a terminal
`detach_tasks` response, or a detached-task notification. This preserves the
provider invariant that every tool call has one result and conversation
history remains append-only.

eve adds task guidance to the generated agent instructions:

- await before depending on a task's result;
- detach before ending the turn if the work must continue;
- use progress or a durable sleep instead of tight polling;
- treat a receipt as acceptance, not successful completion.
- recognize that synchronous tools still return their ordinary result and
  block the current step.

### Task views

Controls return eve-owned views rather than exposing an internal workflow
record:

```ts
interface TaskProgress {
  readonly message?: string;
  readonly percent?: number; // 0 through 100
}

interface TaskView {
  readonly taskId: string;
  readonly revision: number;
  readonly status: TaskStatus;
  readonly scope: "turn" | "session";
  readonly progress?: TaskProgress;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resultAvailable: boolean;
}
```

`resultAvailable` says whether awaiting the task can return a settlement; it
never reveals completed output, failure data, or input-request payloads. A task
ID is high-entropy and opaque. It is not a session ID, workflow ID,
continuation token, or authorization capability. Every operation also verifies
that the current session owns the task.

### `await_tasks`

```ts
interface AwaitTasksInput {
  readonly taskIds: readonly string[];
  readonly returnWhen?: "all" | "any"; // default: "all"
  readonly timeoutMs?: number;
}
```

`await_tasks` durably suspends the model turn until:

- all requested tasks are ready;
- one requested task is ready when `returnWhen` is `"any"`; or
- the optional timeout expires.

`input_required` and every terminal status are ready states. Progress updates
alone do not complete a wait. A task that is already ready returns immediately.
A timeout is an ordinary result containing `timedOut: true` and current task
views, not a failed tool call.

The result contains one discriminated settlement per ready task:

```ts
interface TaskSettlementBase {
  readonly taskId: string;
  readonly warnings?: readonly TaskWarning[];
}

type TaskSettlement = TaskSettlementBase &
  (
    | { readonly status: "completed"; readonly output: unknown }
    | {
        readonly status: "input_required";
        readonly inputRequests: readonly InputRequest[];
      }
    | { readonly status: "failed"; readonly error: ToolError }
    | { readonly status: "cancelled" }
  );
```

Completed output uses the originating tool's `toModelOutput` projection. Raw
executor values never bypass that boundary. Awaiting a detached terminal task
acknowledges its result and suppresses any queued notification wake for the
same revision.

`returnWhen: "any"` provides race semantics. There is no separate race tool.
The other tasks keep running until awaited, cancelled, detached, or ended with
their owning turn.

### `peek_tasks`

```ts
interface PeekTasksInput {
  readonly taskIds?: readonly string[];
}
```

`peek_tasks` returns `TaskView` values without returning completed output,
failure data, or input-request payloads. This makes status checks cheap and
prevents polling from repeatedly injecting large or untrusted results into
model context.

When IDs are omitted, it lists the session's non-terminal tasks. A known
terminal task remains inspectable by ID for the life of the session and its
result remains available through `await_tasks`.

There is no separate list or result tool: omission provides discovery, while
awaiting a terminal task provides result retrieval.

### `cancel_tasks`

```ts
interface CancelTasksInput {
  readonly taskIds: readonly string[];
}
```

Cancellation is cooperative, sticky, and idempotent:

- a live task transitions durably to `cancelled` before abort is propagated;
- cancelling an already-cancelled task succeeds with the same state;
- a late executor result cannot revive or replace a cancelled state;
- cancelling a completed or failed task returns that existing terminal state;
- cancellation does not undo a side effect that already happened.

Results are reported per task so one unknown or unauthorized ID does not hide
the outcome for valid IDs.

There is no model-facing retry tool. Repeating an arbitrary tool can duplicate
side effects, so retry remains an explicit new invocation made with knowledge
of the original tool's semantics.

### `detach_tasks`

```ts
interface DetachTasksInput {
  readonly taskIds: readonly string[];
}
```

Tasks are turn-owned by default. `detach_tasks` promotes selected work to
session ownership:

- a working task survives normal turn completion and turn cancellation;
- its terminal state can wake the agent after the originating turn is gone;
- session completion still cancels it;
- detaching an already-detached task is idempotent.

Only root conversation sessions may detach. Task-mode sessions and subagents
must settle or cancel their own descendants before they finish; otherwise
detached work could become ownerless or wake a session with no conversational
surface.

If a task is already terminal when detachment is processed, `detach_tasks`
returns its settlement directly, acknowledges it, and does not schedule a
wake. An `input_required` task is still live: detachment promotes it to session
ownership so the user can answer after the turn ends. This closes the terminal
completion race without requiring the model to make a second control call.

There is no separate "forget" operation. Terminal records are retained with
their owning session and removed by ordinary session retention.

### `sleep`

```ts
interface SleepInput {
  readonly durationMs: number; // 1 through 300_000
}
```

`sleep` durably suspends the turn without holding a worker. It is useful when
the agent wants to wait before peeking again or intentionally delay an action.
It returns after the requested duration or when the turn is cancelled.

`sleep` is not how an agent waits for completion; `await_tasks` is event-driven
and should be preferred whenever the relevant task IDs are known.

There is no separate watch tool. `await_tasks` watches inside the current turn,
while detachment requests a later agent-only wake.

## Lifecycle and ownership

### State machine

```text
                           response supplied
                      ┌────────────────────────┐
                      │                        ▼
created ──────────▶ working ──────────▶ input_required
                      │  ▲                      │
                      │  └──────────────────────┘
                      │
                      ├────────▶ completed
                      ├────────▶ failed
                      └────────▶ cancelled

completed, failed, and cancelled are final
```

A task may enter `input_required` multiple times. Answering every live request
moves it back to `working`. Failure while waiting for input may move it to
`failed`; cancellation may move it to `cancelled`.

Each transition increments a monotonic task revision. Timestamps and revisions
are framework-authored and survive replay.

### Ownership

```text
conversation session
│
├── active turn
│   ├── task A (turn-owned) ── turn ends ──▶ cancel
│   └── task B (turn-owned) ── detach ─────▶ session-owned
│
└── task B (session-owned) ── terminal ────▶ agent-only wake
                              session ends ─▶ cancel if still live
```

The ownership rules are:

1. Creating a task binds it to the current turn.
2. Completing or cancelling the turn cancels every live turn-owned task.
3. Detachment atomically transfers ownership to the root session.
4. Cancelling a turn does not cancel its detached tasks.
5. Completing or failing the session cancels every remaining live task.

These rules make leaks difficult by default. An agent must state, through a
control call visible in history, that work is allowed to continue after it
responds.

## Detached completion and agent-only wakes

A detached task may complete while its session is parked or while another
turn is active. Completion queues a session delivery; it never interrupts an
executing model step. The session processes queued task notifications at the
next safe boundary.

The notification is not represented as a user message. eve projects it into
provider history as a framework-authored assistant/tool pair for an internal
task-notification tool:

```text
assistant (source: framework)
  task_notification({ taskId, revision })

tool
  { taskId, status, output | error | inputRequests }
```

This shape has three important properties:

- the result is not falsely attributed to the user;
- untrusted tool output remains in a tool-role message;
- it is a new, provider-valid call/result pair rather than a second result for
  the invocation that created the task.

The wake starts a model turn when the session is available. The agent may send
a follow-up through its channel or finish silently. Agent-only means the
notification itself is not user-visible; normal task lifecycle stream events
remain available to clients.

Notification transport is at-least-once. Each delivery carries the task's
monotonic revision and full snapshot. The session ledger deduplicates
revisions, giving at-most-once projection into model history. If
`await_tasks` or terminal `detach_tasks` returns that revision first, a queued
notification is acknowledged and discarded.

## Input required

Approval, OAuth, and question handling happen after the task and receipt are
created but before protected side effects begin:

```text
model call ─▶ receipt ─▶ task working ─▶ input_required
                                      user response │
                                                    ▼
                                                working ─▶ terminal
```

An `input_required` task does not block unrelated conversation:

- the request is emitted structurally to clients as `input.requested`;
- an active `await_tasks` call can observe it as a ready settlement;
- unrelated user messages neither approve nor expire it;
- a matching response routes by task ID and request ID even after the
  originating turn has ended;
- a response to a terminal task is rejected and cannot authorize late work.

Sensitive authorization material remains client-facing. The model receives
sanitized request metadata and status, never OAuth URLs, credentials, or
approval tokens.

When every live request is answered, execution resumes under the same task ID
and initiating authorization context. Detaching a task also detaches its
future input requests; they can reach the root session without keeping the
originating turn alive.

## Progress

Every eve-authored tool execution context gains an optional progress reporter:

```ts
interface TaskExecutionContext {
  readonly task?: {
    readonly taskId: string;
    reportProgress(progress: {
      readonly message?: string;
      readonly percent?: number;
    }): Promise<void>;
  };
}
```

The reporter is present when the invocation is running as a task. Built-ins,
connections, Workflow, and subagents use the same internal operation.

Progress is latest-value state, not an unbounded log. Reporting a new value
updates the task revision and emits `task.updated`; it does not wake the model.
The agent sees progress only when it calls `peek_tasks` or when a client
chooses to render lifecycle events. This prevents chatty tools from consuming
model turns or context.

`percent` is optional, monotonic by convention rather than enforcement, and
clamped to 0–100. `message` is tool output and receives the same sanitization
and size limits as other model-visible tool data.

## Runtime model

### Launch and dispatch

The durable boundary is the creation of a task record and its dispatch intent:

```text
model emits eligible tool call
             │
             ▼
validate tool + arguments
             │
             ▼
checkpoint task record + dispatch intent + receipt
             │
             ├──────────────▶ model loop continues with receipt
             │
             └──────────────▶ durable task workflow executes tool
```

The checkpoint is idempotent by originating session, turn, step, and tool-call
ID. Replay returns the same task ID and cannot dispatch a duplicate operation.
If a worker fails after the receipt is persisted but before execution starts,
the durable dispatch intent is retried.

Each task executes independently. One task becoming slow, awaiting input, or
failing does not stop siblings or the model loop unless the agent awaits it.

The task workflow captures:

- the tool execution reference and validated input;
- dynamic-tool closure variables needed to execute after the model step;
- initiating auth and session ownership;
- a snapshot of the authored execution context;
- the tool's model-output projection.

Terminal raw output is stored with task execution state rather than copied
into the parent session ledger. The ledger contains identity, ownership,
status, revision, and result location.

### Durable context state

Concurrent tools cannot safely share one mutable async-local context. A task
therefore executes against a snapshot of durable context state and returns a
per-key patch.

At completion, eve applies a patched key only if the parent value has not
changed since dispatch. Non-conflicting changes merge. A conflicting task
cannot overwrite newer session state; its settlement and lifecycle event
carry a warning naming the skipped keys.

Sandbox files and external systems are not snapshotted. Their changes are live
and shared, just as they are for parallel tool calls today. Task cancellation
does not roll them back.

### Subagents and Workflow

Local and remote subagents use the same task record, controls, ownership, and
notification path as every other tool. Their child session ID remains an
internal execution detail. The existing special "park the parent turn until
all subagents report" path is removed once migration is complete:

- awaiting a subagent task reproduces the current parent wait;
- detaching it lets the parent respond while the child continues;
- child input requests route through the owning task;
- child completion follows ordinary settlement or notification semantics.

Workflow is an eligible work tool, not a framework control. Its own durable
execution may continue inside the task workflow while the calling agent
chooses whether to await or detach it.

## Events and observability

The original tool call continues to emit its normal action events, with its
`action.result` containing the immediate task receipt. Task execution emits a
separate lifecycle:

```ts
type TaskEvent =
  | { readonly type: "task.created"; readonly task: TaskView }
  | { readonly type: "task.updated"; readonly task: TaskView }
  | { readonly type: "task.terminal"; readonly task: TaskView };
```

`task.updated` covers progress and transitions into or out of
`input_required`. `task.terminal` is emitted once for the winning terminal
revision. Stream replay may redeliver an event to a client, so consumers
deduplicate by task ID and revision.

Client-safe terminal details may be attached using the same output policy as
existing tool results. Model projection remains exclusive to
`await_tasks`, terminal `detach_tasks`, and detached notifications.

The TUI, web clients, hooks, instrumentation, and eval facts must distinguish:

- the original call was accepted and has a handle;
- the task later changed state;
- the model actually observed the terminal result.

A receipt alone must never be rendered or evaluated as successful tool
completion.

## Error and race semantics

- **Launch failure:** once a receipt exists, scheduling or infrastructure
  failure transitions the task to `failed`; it does not rewrite the receipt.
- **Fast completion:** current state may be terminal while the historical
  receipt says `working`; controls always read current state.
- **Await versus notification:** the first durable acknowledgement owns model
  delivery; the other path observes it and suppresses duplication.
- **Detach versus completion:** the atomic winner either returns the ready
  settlement from `detach_tasks` or establishes session ownership and queues a
  later notification.
- **Cancel versus completion:** the first committed terminal transition wins.
  An executor may still finish physically after cancellation, but its result
  is discarded.
- **Turn end versus detach:** detachment must commit before the turn terminal
  boundary. Otherwise turn cleanup cancels the task.
- **Input response versus cancellation:** the first committed transition wins;
  an answer cannot revive a cancelled task.
- **Duplicate dispatch or notification:** stable call identity and task
  revisions make replay idempotent.
- **Unknown or unauthorized task ID:** controls return a per-ID error without
  revealing whether another session owns that ID.

## Compatibility

Without `experimental.toolExecution: "tasks"`, harness behavior and exposed
tool sets remain unchanged.

With the flag enabled:

- eligible tool calls produce receipts instead of their authored terminal
  outputs;
- task controls and generated guidance are added;
- provider-executed tools and framework controls continue to execute inline;
- authored tool implementations and their direct TypeScript callers do not
  change;
- `toModelOutput` still defines what the model may see when a result is
  delivered.

Because the model-facing contract changes every eligible tool result, this
must remain agent-level opt-in throughout the experiment. It must not be
enabled implicitly by a channel, model, or deployment.

## Delivery

Deliver the experiment in five vertical slices:

1. Add the task record, durable dispatch, immediate receipt, ownership ledger,
   and authored-tool execution behind the agent flag.
2. Add `await_tasks`, `peek_tasks`, `cancel_tasks`, durable `sleep`, progress,
   approval/auth routing, and context reconciliation.
3. Add detachment, session notifications, revision deduplication, and
   agent-only wakes.
4. Move built-ins, connections, Workflow, and local and remote subagents onto
   the same task path; remove their bespoke wait contracts.
5. Update documentation and clients, then add fixture-based end-to-end
   coverage before recommending the mode for real-time agents.

Runtime slices that touch the published `eve` package require a patch
changeset. This research-only document does not.

## Acceptance criteria

- A deliberately slow tool returns a handle and the model can take another
  step before execution completes.
- Awaiting one task reproduces today's blocking result behavior.
- `returnWhen: "all"` and `"any"`, timeouts, failures, cancellation, and
  `input_required` return deterministic settlements.
- Peeking never returns terminal output and progress survives durable replay.
- Parallel authored, dynamic, connection, Workflow, and subagent tasks settle
  independently with stable task/result correlation.
- Normal turn completion and cancellation cancel only turn-owned tasks.
- Detached tasks survive their originating turn and wake the agent at most
  once.
- Detached completion creates no user-authored transcript entry, and the
  agent can respond through its channel or finish silently.
- Approval and OAuth cannot execute early, block unrelated conversation, or
  expose sensitive material to the model.
- Explicit cancellation is sticky; late results cannot revive or redeliver a
  task.
- Concurrent context patches preserve newer session state and report
  conflicts; sandbox and external changes remain visible.
- Provider-executed tools remain available and synchronous in task mode.
- Stream consumers distinguish an immediate receipt from terminal task
  completion and from model observation of that completion.
- Agents without the experimental flag retain today's behavior.

## Deferred

- MCP Tasks server/client wire adapters.
- TTL and explicit terminal-record deletion before ordinary session retention.
- Token-budget accounting and quota reservation for detached work.
- Cross-session observers and externally shareable task handles.
- Automatic retries based on a future authored idempotency contract.
- Incremental model delivery of task progress or streaming task output.
