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

Add a `cancel` route helper that resolves the token without starting a
session, plus a `Session.cancel()` method for authors who already hold a
session handle. Both delegate to the existing cancellation primitive. Steering
replacement input is separate and is specified in
[Channel turn steering](./channel-turn-steering.md).

## Authoring API

```ts
export interface RouteHandlerArgs<TState = undefined> {
  // Existing helpers omitted.
  cancel(options: { continuationToken: string; turnId?: string }): Promise<CancelTurnResult>;
}
```

`CancelTurnResult` is the existing exported result type
(`{ status: "accepted" | "no_active_turn" }`), not a new type; the helper
reuses it verbatim.

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

Authors who already hold a session use `Session.cancel()`, available on the
handle returned by `send()` and `getSession()`:

```ts
export interface Session {
  // Existing members omitted.
  cancel(options?: { turnId?: string }): Promise<CancelTurnResult>;
}
```

`Session.cancel()` is session-id addressed, needs no token resolution, and
delegates directly to the existing cancellation primitive. The route `cancel`
helper is the continuation-addressed convenience for stop routes that arrive
with only a channel-local token. The internal agent method keeps the precise
`cancelTurn` name because it is addressed by runtime session id.

## Semantics

- `"accepted"` means the turn-cancellation hook consumed the request, not that
  the observed turn will cancel. Settlement remains asynchronous and is
  confirmed by `turn.cancelled` followed by `session.waiting` on the event
  stream, which is the only confirmation.
- `"no_active_turn"` covers an unknown token, an idle or parked session, a
  completed session, and a turn without a live cancellation target. Both
  statuses are successful outcomes.
- `turnId` is an optional stale-request guard. A mismatch is consumed as a
  benign no-op and cannot cancel a newer turn; the request still reports
  `"accepted"`.
- The route helper addresses only its own channel's namespace by construction;
  it cannot cancel a session owned by another channel.
- `Session.cancel()` shares the same result type and semantics.
- Neither surface starts a session, sends input, clears history, or falls back
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

Resolution is a delivery-free continuation-hook lookup: the Workflow
hook-by-token read, wrapped in an eve-owned runtime method, returns the hook's
owning run id as the session id. The lookup read is the linearization point
for invariant 1. A token-not-found error maps to `no_active_turn`; all other
lookup errors propagate. The helper then delegates to the existing
session-id-addressed cancellation. Because the lookup is a pure read, nothing
is consumed, adapter delivery and the input queue are untouched, and no new
hook payload kind or durable driver/turn protocol change is required — pinned
deployments cannot misinterpret a new control payload because none exists.

## Verification and delivery

- Unit-test channel namespacing, result mapping, and route-helper injection for
  HTTP and WebSocket routes.
- Unit-test `Session.cancel()` on handles returned by both `send()` and
  `getSession()`.
- Cover unknown, parked, active, already-settled, guarded-match, and
  guarded-mismatch cases.
- Race continuation rekeying and turn settlement against resolution; assert
  that no newer session or turn is cancelled.
- Assert unexpected resolution errors propagate and never fall back to session
  creation.
- Add a custom-channel e2e route that cancels a running tool using only the
  public helper, observes the cancellation boundary, then resumes the same
  session normally.

This is an additive public channel API and requires custom-channel and session
docs, API tests, and a patch changeset. It does not change the already-landed
cancellation protocol or events.
