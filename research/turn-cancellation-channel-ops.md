---
issue: https://github.com/vercel/eve/issues/483
status: implemented
last_updated: "2026-07-16"
---

# Active-turn control for channel authors

## Summary

Custom channels expose two distinct operations:

- `send(input, { turnPolicy: "queue" | "steer" })` supplies user input;
- `cancelTurn({ continuationToken, turnId? })` stops work without replacement input.

The default `"queue"` policy preserves ordered turns. `"steer"` redirects the
active logical turn at its next safe step boundary. There is no public
`"interrupt"` policy: aborting obsolete provider work is an implementation
choice, not an end-user intent distinct from steering.

## Authoring API

```ts
export type TurnPolicy = "queue" | "steer";

export interface SendOptions<TState> {
  // Existing fields omitted.
  turnPolicy?: TurnPolicy;
}

export interface RouteHandlerArgs<TState> {
  // Existing fields omitted.
  cancelTurn(options: { continuationToken: string; turnId?: string }): Promise<CancelTurnResult>;
}

export interface CancelTurnResult {
  status: "accepted" | "no_active_turn";
}
```

## Observable semantics

`"accepted"` means a registered cancellation hook accepted the request, not
that cancellation has settled or necessarily matched the caller's guarded
turn. `"no_active_turn"` covers unknown, idle, parked, swept, and otherwise
uncancellable sessions. Both are successful outcomes.

### Queue

`"queue"` is the default. Input admitted during active work is held for the
next turn. An explicitly addressed input response may satisfy a request that
is already pending, but input admitted before a later request cannot answer
that request.

### Steer

`"steer"` keeps the active `turnId`. The current atomic model or tool step may
finish, then eve supplies the steering delivery before the turn can settle.
The continued step emits the new `message.received` under the same turn and
does not emit another `turn.started`.

Steering is durable and single-flight. The driver consumes a delivery only
after the active turn's private steering inbox accepts it. If turn settlement
wins the race, the delivery is returned to the session queue and becomes the
next turn instead of being lost. Multiple accepted steering messages preserve
delivery order and may coalesce at one boundary.

### Cancel

`cancelTurn()` namespaces the channel-local continuation token, resolves its
current durable session, and resumes that session's cancellation hook. It
never starts a session or manufactures a user message.

An optional `turnId` guard makes delayed requests benign rather than
cancelling a newer turn.

## Runtime boundary

```text
public continuation hook
  ├─ queue ───────────────► session input queue ─────► next turn
  ├─ steer ─► private turn inbox ─► next safe step in active turn
  └─ resolve command ─────► session id ────────► cancel hook
```

The active turn acknowledges each forwarded steering delivery. This handshake
is the ownership boundary that prevents completion, re-key, and hook-disposal
races from dropping input or creating a second session.

Cancellation and steering intentionally use separate hooks. Cancellation is
session-addressed, one-shot, and claimed only when the turn can settle as
waiting. Steering is repeatable and uses a unique per-turn token; its
`turn-steering-ready` message proves that the active turn owns that token. The
two controls share low-level hook mechanics but retain separate hard-cancel and
soft-steering state.

The session input queue owns live admission, buffering, ordering, and the sole
transition from steer policy back to queue policy. The driver retains an
unacknowledged forward; the turn owns only acknowledged steering. Therefore a
terminal race needs no timing-based drain: the side that still owns the
delivery returns it to the queue exactly once.

## HITL rules

- A structured response can resolve the matching pending request.
- A freeform message admitted before a request stays queued and cannot answer
  that later request.
- Continuing with freeform input while a tool approval is pending denies the
  obsolete tool action, then replays the message as context on the next step.
- Steering received while a delegated child is already waiting is routed
  through the existing child-input path; any unconsumed remainder returns to
  the parent turn.

## Limits

Steering and cancellation do not roll back completed tools, channel sends, or
other side effects. Partial streamed output remains observable. Cancellation
cascades to active local and remote descendants before the parent settles.
Session reset and retraction of already-sent channel messages remain out of
scope.
