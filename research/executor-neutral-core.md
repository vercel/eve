---
issue: https://github.com/vercel/eve/pull/2690
status: in-progress
last_updated: "2026-09-02"
---

# Subagent execution boundaries

## Scope of the current PR

[#2690](https://github.com/vercel/eve/pull/2690) lands sequence steps 1–3
below, plus the parts of steps 7 and 8 that had no dependency on the
remaining work: `subagentDepth` is removed, and the vocabulary-count guards
are replaced by import-direction rules 42–43. Concrete subagent code moves
under `src/subagents/**` and `src/execution/tools/subagent/**` unchanged.

Not in that PR: steps 4–6 and the rest of 7. `background-tool-execution.ts`
still branches on `resultKind: "subagent"`, projects subagent tasks, and
reserves handles inline; `workflowEntry` still carries its existing
finalizers. Those are follow-ups against this document.

## Summary

The useful boundary is narrower than removing subagent concepts from all of
`execution/**` and `harness/**`. Session and turn workflows are composition
roots for eve's agent runtime. They may call the built-in task, workflow-tool,
and subagent implementations directly. A runtime executor registry would add
indirection without a second child executor to select.

The reusable task kernel must remain neutral. A task owns readiness, progress,
input obligations, cancellation, terminal caching, and dedupe. It carries an
opaque executor binding; it does not resolve agent targets, mutate agent
handles, translate child events, or know local from remote.

The current implementation starts both a task workflow and a workflow-tool
workflow for every background call. It also duplicates subagent admission and
splits handle lifecycle ownership across the session driver, task run, and
harness. The target design keeps one shared subagent workflow body, one task
run for background execution, and one subagent executor shared by background
and blocking calls.

No public behavior changes. Model-visible subagent calls remain background
tasks, `Workflow` calls remain blocking and return child outputs, `agent()`
remains available inside authored background workflows, and receipts, events,
HITL, continuation, and callback shapes remain stable.

## Runtime topology

```text
direct model subagent call
  -> task run (wait for admission, then execute shared subagent body)
  -> subagent executor
  -> child session

authored background workflow tool
  -> task run (wait for admission, then execute authored body)
  -> agent(), when used
  -> subagent executor
  -> child session

model-authored Workflow subagent call
  -> blocking workflow-tool run
  -> shared subagent body
  -> subagent executor
  -> child result resumes Workflow

blocking authored workflow tool
  -> workflow-tool run
  -> result resumes the turn
```

`taskRunWorkflow` owns both lifecycle and body execution for background tools.
`workflowToolRunWorkflow` remains the owner for blocking workflow calls. Both
can execute the same registered workflow body; background execution does not
need a second workflow run.

The shared subagent body remains registered once under its stable framework
workflow ID. Its target comes from the tool name and node binding. Per-subagent
workflow IDs, manifest fields, and generated registrations add no behavior.

## Ownership

| State or behavior                                                   | Sole owner        |
| ------------------------------------------------------------------- | ----------------- |
| Stable inbox, continuation alias, timeout, terminal event           | Session driver    |
| Session snapshot and agent-handle store                             | Session driver    |
| Active turn snapshot and blocking child wait                        | Turn workflow     |
| Task state, readiness, progress, and input obligations              | Task run          |
| Background workflow body                                            | Its task run      |
| Blocking workflow body                                              | Workflow-tool run |
| Agent planning, handles, local/remote transport, and child cleanup  | Subagent executor |
| Model history, tool projection, approvals, and public action events | Harness           |

The parent session remains the canonical writer for agent handles. Background
tasks can outlive turns, so they send handle commands to that owner. A turn may
return an older snapshot, so the driver must preserve handle mutations accepted
while the turn was running.

This command-and-rebase mechanism is required by the current storage model, but
its implementation should be one cohesive subagent handle-owner operation. It
should not be spread across the generic inbox, router, cursor, task workflow,
and background executor. Moving handles to an independent durable store could
remove rebasing, but would add another service and migration and is out of
scope.

## Admission and settlement

The parent task index is the ownership barrier. No authored body or child may
start before the parent commits that index entry.

```text
prepare task and optional subagent lease
start task run and claim its command hook
wait for ready, reject-dispatch, or cancel

ready             -> execute the registered body
reject-dispatch   -> release admission state; do not execute the body
cancel            -> abort the body; await cleanup; then finish the task
```

The task run handles workflow progress, input requests, outcome, and
cancellation generically. It does not interpret `agent.invoke`, construct
`subagent-result`, or release agent handles. The workflow-safe `agent()` helper
emits an opaque effect through the workflow owner. The parent execution
composition interprets that effect and applies subagent state transitions to
the live session snapshot.

The subagent executor consumes the full child settlement before returning only
the authored output to `agent()`:

- A parked child makes the handle available for continuation.
- A terminal child removes the handle and pending child-input routes.
- Usage is reported to the task and parent before output is unwrapped.

Task cancellation commits the cancelled view first, routes cancellation to the
child, waits for the child dispatch to settle or become unreachable, then
releases or removes the handle. Releasing first can advertise a child as
available while its previous turn is still running.

Child input remains a batch. One child event becomes one task input obligation,
and only request IDs whose answers were delivered successfully are cleared.

## Session composition

`workflowEntry` remains a composition root for this sequence:

```text
create session
claim inbox and timeout
dispatch and adopt turns
notify the accepted turn caller
wait for session commands
finalize once
```

The entry legitimately coordinates four subagent-owned obligations:

- Apply task-owned handle commands and preserve them across turn adoption.
- Notify a caller waiting for a delegated conversation turn.
- Cancel blocking descendants with a cancelled turn.
- Terminate tasks and child sessions when the parent ends.

These should be cohesive calls into the subagent boundary. The entry should not
parse handle phases, derive local/remote transport, or construct agent result
variants.

The driver carries an explicit neutral caller descriptor with a correlation
ID, optional task ID, activity observer, and hook or callback reply target. The
subagent boundary translates it to the existing agent result and callback
wires. `mode` controls whether a session may park; it does not select the
subagent result protocol.

Additional entry simplifications:

- Remove `subagentDepth`. Its remaining decisions only ask whether a session is
  delegated, which `rootSessionId` already states.
- Treat dynamic child configuration as effective agent bootstrap data rather
  than making the driver interpret a dynamic-subagent type.
- Resolve the initial caller while translating `RunInput`, not by deserializing
  every new session's context.
- Use one terminal finalizer for done, expiry, reset, inbox closure, and
  failure. It records terminal emission before callbacks and uses the latest
  context and turn ID. A cleanup or callback failure cannot emit a contradictory
  second terminal event.

## Tool and harness boundaries

Prepared tool execution variants remain grouped so invalid combinations cannot
be represented. `workflowId`, `nodeId`, `resultKind`, and `executeInput` should
not become unrelated optional fields on every harness tool.

Generic task and workflow protocols do not need
`resultKind: "subagent"`. Subagent preparation selects the shared workflow body
and supplies an opaque executor binding. A background owner runs that body in
the task run; a blocking owner runs it in the workflow-tool run.

The harness is an agent harness, not the neutral task kernel. Dynamic subagent
tools, agent availability, and public `subagent.called` and
`subagent.completed` events are legitimate harness behavior. Generic hooks for
each would make the call graph harder to follow without enabling another
implementation.

Agent state transitions and transport do not belong in the harness. The
subagent executor validates child identity, applies parked or terminal handle
transitions, and clears child routes before a result reaches generic history
coordination. It emits `subagent.called` after obtaining the child address;
generic task code only carries the projected event.

## Sequence

1. Restore one coherent prepared-tool representation and a passing typecheck.
   Split out the unrelated per-subagent workflow-ID and flattened metadata
   changes.
2. Fix the current behavioral regressions: blocking `Workflow` calls, missing
   `subagent.called`, startup rollback, cancellation ordering, terminal-event
   duplication, reset and closure finalization, multi-request HITL, terminal
   handle removal, and nested usage.
3. Gate background bodies on task admission and execute them inside
   `taskRunWorkflow`. Keep a separate workflow-tool run only for blocking calls.
4. Centralize subagent admission so the outer background step reserves or
   claims once and passes that lease to the subagent executor.
5. Route `agent()` through the workflow owner's opaque effect channel. Move
   agent-effect parsing, result construction, handle release, and callback
   transport from the task kernel to parent execution composition.
6. Consolidate handle command application, reconciliation, cancellation, and
   finalization under the subagent handle owner.
7. Simplify `workflowEntry` with an explicit caller, no `subagentDepth`, one
   terminal finalizer, and current crash context. Delete superseded finalizers
   and unused dispatch helpers.
8. Remove subagent state transitions from harness coordination and replace
   vocabulary-count guards with import and ownership invariants.

## Worktree disposition

Keep explicit `taskId` session ownership, behavior-based tool availability, the
shared subagent workflow body, and extraction of concrete start and cancel code
under the subagent executor tree.

Drop per-subagent workflow IDs, manifest v48, generated subagent workflow
registrations, and flattened workflow metadata. Reconsider the separate
session-command router: splitting one handle command path across an inbox,
router, command protocol, and store adds code while the driver retains the same
mutation responsibility. The neutral boundary is `src/tasks/**`;
`execution/tasks/**` is parent/child task composition and may compose the
subagent executor directly.

## Compatibility and validation

- Preserve immutable session-inbox v1 and v2. V3 already denotes generic task
  `inputRequests` and `effects`; do not reuse that version for renamed child
  messages.
- Preserve the shared subagent workflow ID, workflow function identities,
  operation hashes, ID formats, callback paths, receipt fields, and handle state
  key.
- Migrate persisted parked handles before deleting old phase readers. Do not
  advertise an `agentId` that the task-owned claim path rejects.
- Keep `NextDriverAction` changes additive because a session driver can outlive
  its originating deployment.
- Cover background admission rollback, cancellation ordering, local and remote
  HITL, parked and terminal continuation, usage, and exactly-once terminal
  notification in focused integration tests.

Mechanical guards enforce dependency direction:

- `src/tasks/**` imports neither `src/subagents/**` nor executor code.
- `taskRunWorkflow` does not parse agent effects or mutate agent handles.
- Generic inbox and cursor modules import no subagent types.
- Immutable wire history is exempt from vocabulary counts.
- Composition roots may import built-in executors directly.
- No executor registry is added until two implementations require runtime
  selection.
