---
issue: https://github.com/vercel/eve/issues/1084
status: draft
last_updated: "2026-07-31"
---

# Subagents as tasks: additive delivery plan

## Summary

This plan sequences the implementation of the [subagents-as-tasks design] into strictly additive
stages behind `experimental.tasks`. Every stage must land with this invariant: **with the flag
absent, no existing codepath's behavior, wire shapes, or event stream changes.** The design doc
owns the contract; this doc owns the order of construction, what each stage reuses from the
agent-messaging stack, and how each stage is verified before the next begins.

## Baseline

The baseline is `main` plus the agent-messaging stack (`am/01-contracts` through
`am/04-surface`, the phase-one agent2agent work). That stack supplies the session-addressing
dependency the design doc declares:

- **Durable child address**: the agent handle store (`eve.agent.handles` on session state) with
  replay-safe operation ids, commit-before-side-effect dispatch, and `starting/running/parked`
  phases. Handles hold the child `continuationToken` (local) or `url` + `continuationToken`
  (remote); credentials never render to the model.
- **Follow-up delivery**: `dispatchToAgentHandle` / `continueRemoteAgentSession`, with
  `AGENT_BUSY` / `AGENT_MISMATCH` / `AGENT_UNREACHABLE` classification and `intent: "resume"`
  sends that 404 instead of silently starting a new session.
- **Reply envelope**: `TurnCaller` (`replyTo: hook token | callback URL`) and the
  `turn.completed` / `turn.failed` callback kinds carrying an explicit `AgentTurnOutcome`.
- **Result binding**: inbox results are bound to a running handle, so a callee cannot settle a
  sibling's call and replays cannot double-settle.

Tasks must not build a second addressing mechanism. The task record composes with handles:

- the **handle** identifies the reusable child session (agent-messaging owns it);
- the **task** identifies one unit of work against that handle and adds what handles lack:
  a durable record that survives terminal settlement, `working` / `input_required` status,
  progress messages, receipts instead of turn-blocking, and `task_await`.

Task identity reuses the operation-id derivation, `hash(parentSessionId, parentTurnId, callId)`,
so replayed creation for the same originating call yields the same task without new machinery.

### Flag composition

`task_send` follow-ups to a finished child require conversation-mode children and parked
handles, which `experimental.subagentPersistentSessions` gates today. `experimental.tasks`
therefore implies persistent-session children for subagent dispatch. Whether it sets the other
flag or simply selects the same behavior internally is a stage-4 decision; the two flags must
not produce a third hybrid mode.

## Additivity rules

Each PR in this plan must satisfy:

1. New optional fields only on closed contracts (`NextDriverAction`, `DurableStepResult`,
   `TurnWorkflowInput.driverCapabilities`); never a changed meaning for an existing `kind`.
   The driver run is pinned to its starting deployment while turn workflows route to latest,
   so new turn behavior is negotiated the way `turnInbox` was.
2. New payload kinds (turn inbox, hooks, callback route) may be defined early but nothing emits
   them until the stage that selects the mode. Receivers land before senders.
3. New modules over edits to shared modules wherever possible. Where a shared codepath must
   branch, the branch condition is the flag or a mode value that nothing sets yet.
4. Existing tests pass unmodified. Stages add tests; they do not rewrite flag-off expectations.

## Stages

Stages 1–3 are inert: they compile, are fully tested in isolation, and are unreachable in a
production agent. Stage 4 makes the flag mean something. This mirrors the design doc's Delivery
section, folding its A2A step into the baseline.

### Stage 0 — flag plumbing

Add `tasks?: boolean` to `AgentExperimentalDefinition`, mirroring the
`subagentPersistentSessions` plumbing exactly: authored normalization, compiler copy, the strict
compiled-manifest schema, manifest serialization, root-only enforcement, and a
`ResolvedAgent` / harness-session projection. The flag does nothing.

Verification: compile/manifest unit tests; a fixture with the flag on behaves identically to one
without it.

### Stage 1 — task foundation

New `packages/eve/src/tasks/` module cluster:

- `TaskStatus`, `TaskView`, `TaskMetadata`, `TaskOutput`, and a pure transition function
  enforcing the lifecycle rules (terminal is final; `working <-> input_required`). This stage
  also settles the design doc's open API questions that block types: the discriminated
  `task_send` input and how `input_required` exposes its outstanding `InputRequest[]`.
- The **durable task run**: a dedicated small workflow per task (precedent: the session-timeout
  run). It is the single writer for transitions, consumes commands over its own hook, and
  appends a full `TaskView` snapshot per accepted command. Competing completion, cancellation,
  and input-response commands serialize here.
- The **session task index**: one new namespaced session-state key holding
  `{ taskId, taskRunId }` entries. Adding a key to `SessionStateMap` needs no session-version
  migration.

Verification: exhaustive unit tests on transitions (late completion after `cancelled`,
idempotent cancel, replayed commands); integration tests driving a task run through every
lifecycle path.

### Stage 2 — task tools, undiscoverable

Register the parent tools (`task_peek`, `task_await`, `task_send`, `task_cancel`, `task_sleep`)
as framework tools, filtered out of the tool set unless the flag is on, plus the child
`task_message` tool advertised only when a task binding is present (the same capability-gating
pattern as `ask_question`).

- `task_sleep` reuses the existing durable turn-sleep request.
- `task_peek`, `task_cancel`, and `task_send` read the session task index and command the task
  run; `task_send` resolves the child address through the agent handle store and the existing
  continuation dispatch.
- `task_await` introduces the one new turn-workflow wait: a new optional wait arm on the durable
  step result that subscribes to selected task runs and returns when every selected task is
  terminal or `input_required` (already-ready tasks return immediately). This is the only piece
  of stage 2 that touches the turn workflow, and it rides an optional field nothing produces
  when the flag is off.

Verification: unit tests per tool; a scenario test that the tools are absent from advertised
tool sets and `/agent-info` when the flag is off.

### Stage 3 — delegated execution mode, inert

In the runtime-action dispatch step, add a delegated mode alongside the existing dispatch plan:

1. create the durable `working` task run and record it in the session task index;
2. dispatch the child with a task binding in its adapter state, reusing the handle-store
   start/continue planning for identity and addressing;
3. persist the child acknowledgement (`childSessionId`) on the handle, as agent-messaging
   already does at dispatch;
4. resolve the originating tool call **immediately** with the task receipt
   `{ taskId, status: "working" }`.

Step 4 is what keeps the parent turn moving and history provider-valid: the receipt is the one
result the existing key-based batch matching consumes, so the turn continues without a second
result path. The eventual outcome reaches the model only through `task_await`, `task_peek`, or a
task notification. Nothing selects this mode yet.

Verification: integration tests invoking the mode directly; replay tests proving the same
originating call returns the same task and never dispatches twice.

### Stage 4 — the task wire, and the flag selects the mode

Carry the six flows over the task contract for local and remote children alike, then let
`experimental.tasks` route the two subagent runtime-action kinds into delegated execution:

| Flow                       | Carrier                                                           |
| -------------------------- | ----------------------------------------------------------------- |
| Terminal result or failure | `task.update` command to the task run, terminal snapshot          |
| Input request / approval   | `task.update` with `input_required` plus the outstanding batch    |
| Authorization event        | `task.authorization` through the task binding                     |
| Input response             | `task_send`, routed via the handle address                        |
| Cancellation               | `task_cancel`: commit `cancelled`, then propagate executor abort  |
| Progress                   | `task_message` from the child, recorded as latest `statusMessage` |

Concretely:

- a task-aware sibling of the local subagent channel adapter posts to the task run instead of
  the parent turn hook; the existing adapter is untouched;
- the remote callback route gains task payload kinds alongside the existing session and turn
  kinds; old payloads are unchanged and old deployments never receive the new kinds;
- routing policy: terminal and `input_required` snapshots wake a parked parent through the
  session delivery path; progress updates task state and client-visible events only. During an
  active turn, inbound task events wait for the next safe step boundary;
- parent-session finalization extends the existing end-of-session child termination to
  cooperatively cancel live tasks first.

Verification: the design doc's acceptance criteria become a scenario suite plus a new e2e
fixture with the flag on; existing subagent fixtures prove the flag-off path is unchanged.

### Stage 5 — normalize and retire

Converge local and remote subagents onto the same delegated path while preserving authored
definitions, then make tasks the default subagent execution and retire the flag once the
acceptance criteria hold. Both are behavior changes, not additive, and are sequenced last
deliberately; they get their own plans if anything nontrivial surfaces.

## Known gaps to resolve in flight

1. **`task_send` to a busy child.** Handle continuation classifies a running child as
   `AGENT_BUSY`, a hard error. The design doc expects `task_send` to answer `input_required`
   and to message the child session; decide in stage 2 whether a send to a `working` task
   queues on the task run or surfaces the busy error to the model.
2. **Remote children outlive the parent.** Agent-messaging documents that remote children are
   not terminated with the parent. The tasks acceptance criterion "completing the parent
   session cancels its live tasks" needs the remote cancel path wired into parent finalization
   in stage 4, or an explicit scope cut.
3. **Blocked vs computing children.** Today a child parked on input or authorization looks like
   any running child. The `input_required` transition in stage 4 is what makes the difference
   observable; until then `task_peek` reports `working` for both, which is acceptable for the
   inert stages but must be closed before the flag ships.
4. **MCP failure taxonomy.** Whether tool-level errors map to `failed` or to a completed result
   carrying an error must be decided when `TaskOutput` lands in stage 1, since the transition
   function encodes it.

[subagents-as-tasks design]: https://github.com/vercel/eve/pull/1482
