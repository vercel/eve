---
issue: https://github.com/vercel/eve/issues/483
status: proposed
last_updated: "2026-07-16"
---

# Turn cancellation for custom channel routes

## Summary

eve already supports cooperative turn cancellation through the runtime, the
authenticated eve HTTP route, `ClientSession.cancel()`, eval controls, and
recursive cancellation of active descendants. The remaining custom-channel
gap is addressing: a `defineChannel` route normally knows its channel-local
continuation token, not the runtime session id required by `Agent.cancelTurn`.

Add one `cancel` route helper that resolves the token without starting a
session and then delegates to the existing cancellation primitive. Steering
replacement input is separate and is specified in
[Channel turn steering](./channel-turn-steering.md).

## Authoring API

```ts
export interface RouteHandlerArgs<TState> {
  // Existing helpers omitted.
  cancel(options: { continuationToken: string; turnId?: string }): Promise<CancelTurnResult>;
}

export interface CancelTurnResult {
  status: "accepted" | "no_active_turn";
}
```

The continuation token uses the same channel-local, unprefixed format as
`send()`. eve applies the channel namespace internally.

```ts
export default defineChannel({
  routes: [
    POST("/threads/:threadId/stop", async (_request, { cancel, params }) => {
      const result = await cancel({ continuationToken: params.threadId });
      return Response.json(result);
    }),
  ],
});
```

Authors who already have a session id can continue using the public
`RouteContext.agent.cancelTurn({ sessionId, turnId? })` primitive in authored
filesystem routes. The new `cancel` helper is the continuation-addressed
convenience surface for `defineChannel`. The lower-level agent method keeps the
precise `cancelTurn` name because it is addressed by runtime session id.

## Semantics

- `"accepted"` means the existing turn-cancellation hook accepted the request.
  Settlement remains asynchronous and is confirmed by `turn.cancelled`
  followed by `session.waiting` on the event stream.
- `"no_active_turn"` covers an unknown token, an idle or parked session, a
  completed session, and a turn without a live cancellation target. Both
  statuses are successful outcomes.
- `turnId` is an optional stale-request guard. A mismatch is consumed as a
  benign no-op and cannot cancel a newer turn.
- The helper never starts a session, sends input, clears history, or falls back
  to `runtime.run()`.
- Cancellation stops work without replacement input. It is not an alias for
  `turnPolicy: "steer"`.
- Existing cancellation behavior is unchanged: partial streamed output and
  completed side effects remain observable, durable settled history is kept,
  and active local or remote descendants receive cancellation recursively.

## Runtime boundary

```text
channel-local continuation token
              │
              ▼
resolve current session owner without delivery
              │
              ▼
existing cancelTurn({ sessionId, turnId? })
```

Resolution and cancellation need not be one transaction because the optional
`turnId` guard protects the turn boundary. They do need these invariants:

1. Resolution returns the session that owned the token at its linearization
   point; a concurrent rekey cannot retarget cancellation to another session.
2. A missing or retired token maps to `no_active_turn`, not an exception and
   never a new run.
3. Runtime or Workflow failures other than an inactive target remain errors;
   they must not be collapsed into `no_active_turn`.
4. The route author remains responsible for authenticating the inbound stop
   request, exactly as for `send()`.

The internal implementation may use a non-delivery session command to resolve
the continuation hook's owning run id. That command must be consumed without
entering adapter delivery or changing the input queue.

## Verification and delivery

- Unit-test channel namespacing, result mapping, and route-helper injection for
  HTTP and WebSocket routes.
- Cover unknown, parked, active, already-settled, guarded-match, and
  guarded-mismatch cases.
- Race continuation rekeying and turn settlement against resolution; assert
  that no newer session or turn is cancelled.
- Assert unexpected resolution errors propagate and never fall back to session
  creation.
- Add a custom-channel e2e route that cancels a running tool using only the
  public helper, observes the cancellation boundary, then resumes the same
  session normally.

This is an additive public channel API and requires custom-channel docs, API
tests, and a patch changeset. It does not change the already-landed cancellation
protocol or events.
