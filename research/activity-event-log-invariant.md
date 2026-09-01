---
issue: https://github.com/vercel/eve/issues/1673
status: implemented
last_updated: "2026-08-28"
---

# Keep activity as an event-log projection

## Decision

Canonical durable session and task events are the sole source of activity facts. Feature code may emit a canonical event, but only the corresponding activity observer may project that event and submit it to the activity collector.

Semantic behavior stays independent of activity. In particular, a task update continues through the durable task hook and parent inbox whether or not an activity collector exists or presentation succeeds.

```text
producer -> canonical event -> activity observer -> collector -> renderer
        \-> durable semantic path (when required)
```

This restates the architecture agreed during #2306: sessions produce `MessageStreamEvent`s, while activity is a best-effort external projection. #2711 and #2712 accidentally bypassed that boundary by calling `submitActivity` from task and tool feature code.

## Current violations

### #2711: task milestones

`wakeTaskUpdateParentStep` receives a durable `TaskInboundUpdate`, posts `work.updated` directly to the collector, and separately sends the update to the parent inbox. The task update is durable, but the collector fact is not projected from the child session event log.

Task terminal settlement has the same older exception: `appendTaskViewStep` posts `work.settled` directly after writing the task view stream. Updating #2711 should remove both task-owned activity submissions so the first PR leaves no nearby exception to the invariant.

### #2712: authored tool updates

`createToolActivity` posts `action.updated` directly to the collector. The message does not exist in the session event log, so replay and inspection cannot explain the rendered state.

## Event semantics

Add a canonical `action.updated` message-stream event with the current `callId`, normalized `message`, turn ID, and turn sequence. The authored tool context does not own a step index, and activity identity does not need one: the matching `actions.requested` event already establishes the action's step.

Its stamped `meta.id` is the durable update identity. Activity projection derives the action ID from `(workId, callId)` and uses `meta.id` to derive a replay-stable `action.updated` activity event ID. The event does not alter model history, tool output, or action settlement.

For `task_update`, use its canonical successful `action.result`. Include the accepted message in the framework tool result, then project that result to `work.updated` only when the observed work is a delegated task. This keeps the event on the ordinary harness emission path and avoids a second event for one accepted tool action.

Do not project `actions.requested` alone: an invalid or unowned update can still fail during dispatch.

Task settlement comes from the canonical task-view stream, whose task workflow is the single writer. A dedicated task activity observer projects terminal views after they are appended. Child `turn.completed`, `turn.failed`, and `turn.cancelled` events are not authoritative because cancellation can race child settlement; the task transition decides the final state.

## Execution plan

### 1. Repair #2711

1. Include the accepted message in a successful `task_update` tool result so its ordinary canonical `action.result` is self-contained.
2. Teach `projectSessionActivity` / `projectActivityEvents` to map that result under task work to `work.updated`, using the stamped source event ID for deduplication.
3. Remove `projectTaskUpdateActivity`, activity-observer plumbing from `wakeTaskUpdateParentStep`, and its direct `submitActivity` call. Preserve the existing task hook and `resumeSessionInbox` parent notification unchanged.
4. Project terminal task views through a dedicated task activity observer after `appendTaskViewStep` writes the canonical task stream.
5. Test successful, rejected, duplicate/replayed, out-of-order-start, and post-settlement updates. Assert the parent still wakes when activity is absent or submission fails.

### 2. Rebase and repair #2712

1. Add `action.updated` to `packages/eve/src/protocol/message.ts`, bump the message-stream version, and update channel/hook compatibility reports required by the expanded public event union.
2. Change `createToolActivity` to use the existing virtual `HandleEventKey`. Normalize the message, emit `action.updated`, and swallow/log emission failure so progress cannot change the tool result.
3. Remove direct access to `ActivityObserverKey` and `submitActivity` from authored tool execution. Emit the canonical event even when no activity renderer is configured.
4. Project stamped `action.updated` events to activity using `meta.at` and a deterministic ID derived from `meta.id`.
5. Test multiple updates, concurrent tool calls, update-before-start reduction, update-after-settlement rejection, no-renderer event persistence, replay deduplication, and emission failure isolation.

### 3. Guard the boundary

Add a focused invariant check that limits imports/calls of `submitActivity` to canonical session and task activity observers and their transport tests.

## Validation

Run the narrow unit and integration files for message protocol, activity projection/reduction, task updates/workflow, tool execution, and extension compatibility. Then run:

```sh
pnpm fmt
pnpm lint
pnpm typecheck
pnpm guard:invariants
pnpm test:unit
```

Both PRs touch the published `eve` package, so retain their changesets and update their release notes if the canonical event becomes user-visible through channel handlers or hooks.
