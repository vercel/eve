---
issue: https://github.com/vercel/eve/issues/2868
status: draft
last_updated: "2026-09-03"
---

# Cancel a session's owned background tasks

## Summary

The session cancel route stops the active turn and nothing else. In
`experimental.tasks` mode a turn that admitted background tasks ends at
`session.waiting` while those tasks keep running, by design. A client that
wants the work to stop has no primitive short of `reset`, which also ends the
session. This proposal adds one option to the existing cancel command:

```http
POST /eve/v1/session/:sessionId/cancel
{ "turnId": "...", "tasks": true }
```

`tasks: true` cancels every nonterminal task in the session's task index in
addition to the active turn, and works when no turn is active. The session
survives and accepts the next message. Nothing else about `cancel` changes:
the default remains turn-only, and admitted tasks continue to outlive the turn
that started them.

The `eve eval` runner adopts this on per-case timeout so a timed-out eval
retires the work it created before the next serial case starts (#2868).

## Current behavior

Three levers exist today, none of which is "stop this session's work, keep the
session":

| Command                        | Active turn                                   | Admitted tasks                                                          | Session   |
| ------------------------------ | --------------------------------------------- | ----------------------------------------------------------------------- | --------- |
| `cancel { turnId? }`           | cooperatively cancelled                       | untouched¹                                                              | continues |
| `cancel { taskId }` (internal) | cancelled; deliveries from `taskId` discarded | that one task's _deliveries_ dropped; the task itself is not cancelled² | continues |
| `reset`                        | cancelled                                     | all cancelled, then children terminated                                 | **ends**  |

¹ `cancelDescendantTurnsStep` cancels `running` handles and `claimed` handles
whose owner is a blocking workflow-tool run. Task-owned children are `claimed`
by a task id (`subagents/handles/store.ts`, `TaskOwnedAgentHandle`), so the
filter excludes them. `rollback` on turn cancellation deliberately retains
already-admitted tasks ("that would kill already-running tasks",
`execution/tasks/parent/tool-execution.ts`).

² `taskId` on the cancel body is parsed by the eve channel
(`eve-channel/request.ts`, `parseCancelTurnBody`) but exists for parent→child
propagation in `propagateSubagentExecutorCancel`
(`execution/tasks/parent/dispatch.ts`), where the _child_ session is told which
task's wake deliveries to drop. It is not documented and does not cancel a
task record.

The consequence, observed in the #2868 repro on `main` `4464e4d37`: a root
parked at `session.waiting` with one `working` task; `cancel` returns
`accepted` and is consumed as a no-op (documented under "Cancel the in-flight
turn" in `docs/concepts/sessions-runs-and-streaming.md`); the task runs to
completion 15 s after the client gave up.

Only `terminateChildSessionsStep` (`execution/terminate-child-sessions-step.ts`)
cancels indexed tasks, and only `reset` and terminal finalization call it.

## Goals

- One client-facing way to stop a session's background work without ending
  the session.
- Preserve the default: `cancel` without `tasks` is turn-only, and admitted
  tasks survive turn cancellation.
- The eval runner retires everything a timed-out case created, keeps the
  timeout verdict, and leaves the session inspectable.

## Non-goals

- Cancelling a single task by id from the client. The model already has
  `task_cancel`; a client-facing per-task cancel can follow the same shape
  later if a use case appears.
- Changing what `reset` does.
- Recursive cancellation of tasks owned by _child_ sessions. `cancelOwnedTask`
  propagates an abort to the child's executor turn; if that child itself owns
  tasks, its own cancellation epilogue governs them. Making that transitive is
  a separate decision.

## Authoring contract

### HTTP route

```http
POST /eve/v1/session/:sessionId/cancel
Content-Type: application/json

{ "turnId": "<optional>", "tasks": true }
```

`tasks` is optional and defaults to `false`. A non-boolean value is `400`. `turnId` keeps its current meaning and scopes only the turn half.

Response:

```ts
type CancelTurnResult =
  | { status: "accepted"; sessionId: string; tasks?: { cancelled: string[] } }
  | { status: "no_active_turn"; tasks?: { cancelled: string[] } };
```

`tasks.cancelled` is present when and only when the request carried
`tasks: true`, and lists the task ids whose `cancelled` state committed as a
result of this request. Already-terminal tasks are not listed. A session with
no task index returns `tasks: { cancelled: [] }`.

HTTP status stays `202` for `accepted` and `200` otherwise. Both statuses
remain success.

### TypeScript client

```ts
await session.cancel({ turnId, tasks: true });
// -> { status, sessionId?, tasks?: { cancelled: string[] } }
```

`Session.cancel` in `channel/session.ts` and `ClientSession.cancel` in
`client/session.ts` take the same option. `MessageResponse.cancel()` is not
extended; it is bound to one turn and stays turn-only.

### Eval runner

On per-case timeout, `executeTask` calls `cancel({ tasks: true })` on every
root session the case created or attached, under a fresh bounded deadline
(the case's own signal is already aborted), using the same request headers the
case used. The case still fails with the timeout error. A cleanup failure is
appended to that error, never swallowed. No new eval-facing API.

## Semantics

Let `IDX` be the session's task index (`tasks/session-index.ts`), `T` the
active turn if any.

```
cancel { tasks: true }
  for each entry in IDX with nonterminal cached status:
    cancelOwnedTask(entry)           // send `cancel` on the task inbox
                                     // poll until `cancelled` commits
                                     // propagate abort to the executor child
  if T exists: forward turn cancellation (unchanged)
  respond { status, tasks: { cancelled: [...] } }
```

Ordering matters for the same reason it does in `terminateChildSessionsStep`:
tasks commit `cancelled` before the turn settles, so no late child completion
can revive a task into a turn that is winding down.

Invariants:

- **Task cancel is authoritative.** The task run is the single writer for task
  state; `cancelled` commits there first. A child that finishes after the
  commit produces no wake and no receipt update.
- **The session continues.** After the response, the session is at
  `session.waiting` (or reaches it once `T` settles) and accepts the next
  message. Child handles drop to `available` once their task releases them;
  the model may `task_send` to them later and they start fresh work.
- **Idempotent.** A second `tasks: true` returns `tasks: { cancelled: [] }`.
- **No turn required.** On a parked session the turn half is a no-op
  (`no_active_turn` or the documented parked `accepted`), and the task half
  still runs.
- **Admission race.** If the request arrives while the step admitting a task is
  in flight, the task is either not yet in `IDX` (this request misses it; the
  turn cancellation then hits `rollback`, which retains it — same as today) or
  already in `IDX` (cancelled here). The retained-on-cancel case is a
  pre-existing window and is not widened. Closing it means teaching `rollback`
  the cancel scope; out of scope until the executor-neutral kernel work.
- **Authorization.** Same as `cancel` today: the route's `auth` decides who may
  cancel a session, and owning the session implies owning its index. No
  per-task authorization.

Stream-observable outcome for a client watching the root: no new event is
introduced. If `T` was active, `turn.cancelled` then `session.waiting`. Task
state is observable through `task_status`/`task_join` in a later turn, and
each child reports its own cancellation boundary on its child-session stream
(unchanged from `task_cancel`).

## Architecture

The task half is the first loop of `terminateChildSessionsStep`, lifted into a
reusable step (`cancelOwnedTasksStep`) that both the cancel handler and
`terminateChildSessionsStep` call. No new persistence, no new wire types
beyond the request option and response field.

```
client ── POST cancel {tasks:true} ──────▶ eve channel route
                                            │ parse + auth (existing)
                                            ▼
                                       Session.cancel(opts)
                                            │ command inbox (existing)
                                            ▼
                               turn-control-receiver / parked-delivery-wait
                                            │ new branch on `tasks`
                                            ├─▶ cancelOwnedTasksStep(IDX) ── task inboxes ── executor children
                                            └─▶ forwardTurnCancellationStep (existing)
```

Touched surfaces:

- `protocol/cancel-turn.ts` — option and response field.
- `eve-channel/request.ts` `parseCancelTurnBody` — accept `tasks`.
- `channel/types.ts` `SessionCommand` `cancel` — carry `tasks`.
- `execution/turn-control-receiver.ts`, `execution/parked-delivery-wait.ts` —
  handle the option in both the active-turn and parked receivers.
- `execution/terminate-child-sessions-step.ts` — extract the task loop.
- `client/session-controls.ts`, `client/session.ts`, `channel/session.ts` —
  option plumbing.
- `evals/runner/execute-task.ts`, `evals/session.ts` — owned-root set and
  timeout cleanup.

`execution/` and `harness/` changes are limited to reading one new command
field and calling an existing step; no lifecycle or state-shape change.

## Delivery

One PR, `patch` changeset. Docs updated in the same PR:
`docs/concepts/sessions-runs-and-streaming.md` (cancel section),
`docs/channels/eve.mdx` (route body), and the pending background-tasks guide
in #2541 (task lifecycle: "how to stop owned tasks from a client").

## Acceptance criteria

fixture-tasks evals, deterministic under `EVE_E2E_MODEL=mock`, following the
`task-transition.ts` naming:

- `task.lifecycle.cancel.tasks.accepted-parked-parent` — root parked with one
  `working` task; `POST cancel {tasks:true}` via `t.target.fetch`; response
  lists the task; a follow-up turn's `task_status` reports `cancelled`; the
  child stream shows its cancellation boundary; the session accepts the
  follow-up normally.
- `task.lifecycle.cancel.tasks.accepted-active-parent` — root turn active and
  two tasks `working`; response lists both; stream shows `turn.cancelled` then
  `session.waiting`; both tasks `cancelled`.
- `task.lifecycle.cancel.tasks.noop-all-terminal` — all tasks already
  terminal; response `tasks: { cancelled: [] }`; task views unchanged.
- `task.lifecycle.cancel.default-preserves-tasks` — plain `cancel` on an
  active root with a `working` task; task stays `working` and later completes
  with a wake. Pins the preserved default.

Unit: `parseCancelTurnBody` rejects non-boolean `tasks` values;
`cancelOwnedTasksStep` skips terminal entries and reports only newly
committed ids.

Runner: an `execute-task.test.ts` case where the test body never resolves and
the manager holds one root; on timeout the runner issues exactly one cancel
with `tasks: true` to that root, the result carries the timeout error, and a
rejected cleanup is reflected in the error string.

## Open questions

1. **Response field name.** `tasks.cancelled` mirrors the request key. An
   alternative is a flat `cancelledTaskIds`. Either is fine; pick one before
   the protocol schema lands.
2. **Should the eval runner also cancel on non-timeout failure?** A thrown
   assertion leaves the same tree behind. Probably yes, same code path, but it
   changes how much work post-failure inspection can observe live. Decide in
   review.
3. **Remote roots.** For `eve eval --url` against a deployed target the same
   route applies; nothing here is local-world specific. Worth one e2e-vercel
   run of the parked-parent eval to confirm.
