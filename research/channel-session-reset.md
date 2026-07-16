---
issue: https://github.com/vercel/eve/issues/216
status: proposed
last_updated: "2026-07-16"
---

# Whole-session cancellation for long-lived channels

## Summary

Active-turn cancellation stops the active turn and adopted descendants, emits
`turn.cancelled` followed by `session.waiting`, and leaves the session
resumable. It is available through `POST
/eve/v1/session/:sessionId/cancel`, `ClientSession.cancel()`, and
`Agent.cancelTurn()`.

Identity-based channels such as Telegram private chats and Twilio
conversations also need a terminal form of cancellation. A `/new` command must
release the channel continuation identity from the old session, cancel the old
execution tree, and allow the next message to create a fresh session with
empty history and authored state. This is whole-session cancellation.

## Public API

### HTTP

Both cancellation scopes use the same route:

```http
POST /eve/v1/session/:sessionId/cancel
```

An empty body or `{ "turnId": "..." }` cancels the active turn. A scoped body
cancels the whole session:

```json
{ "scope": "session" }
```

Conceptually, the accepted request union is:

```ts
type CancelRequest = { turnId?: string } | { scope: "session" };
```

The existing turn response remains unchanged. A session-scoped request returns
`202` with the same response envelope and a status of `"accepted"` or
`"no_active_session"`. Both are successful, idempotent outcomes. Invalid
bodies return `400`; authentication runs before session or continuation
identity is inspected.

### TypeScript client

Cancel the active turn and keep the session resumable:

```ts
await session.cancel(); // Cancel the active turn and keep the session resumable.
```

Add an explicit scope only for terminal session cancellation:

```ts
await session.cancel({ scope: "session" });
```

The client supplies its current session id. After an accepted session
cancellation, the handle clears its session id, continuation token, and stream
cursor so a later `send()` cannot resume the cancelled session.

Aborting a request or stream with `AbortSignal` remains local transport
cancellation; it does not invoke either server-side cancellation scope.

### Custom channels

The continuation-addressed channel helper is `cancel`. Whole-session
cancellation uses a scoped overload:

```ts
export interface RouteHandlerArgs<TState> {
  // Existing helpers omitted.
  cancel(options: { continuationToken: string; scope: "session" }): Promise<CancelSessionResult>;
}

export interface CancelSessionResult {
  status: "accepted" | "no_active_session";
}
```

The continuation token is channel-local, matching `send()`. Replacement input
uses explicit sequencing through the same route helpers:

```ts
await cancel({ continuationToken: threadId, scope: "session" });
await send(replacementMessage, {
  auth,
  continuationToken: threadId,
});
```

The first promise resolves only after the continuation identity is durably
available, so the following `send()` cannot resume the old session. Authors do
not call workflow hooks or reproduce the release barrier themselves.

The low-level `RouteContext.agent.cancelTurn({ sessionId, turnId? })` API is
active-turn-only.

### Frontends and evals

- Frontend stores call the client session's async `cancel({ scope: "session" })`
  for server-side cancellation.
- Eval sessions expose `t.cancel({ scope: "session" })`. Tests can observe
  `session.cancelled`, then send again and prove the replacement has a new
  session id and fresh state.

## Lifecycle and ordering

Continuation release is the whole-session cancellation linearization point:

```text
verify (session S1, continuation C1)
              │
              ▼
mark S1 closing and release C1
              │
              ├── acknowledge cancellation; C1 may now create S2
              └── cancel S1 active turn and descendants
                         │
                         └── emit session.cancelled and finish S1
```

Required invariants:

1. Once closing begins, S1 cannot accept input, start another turn, or reclaim
   C1 during replay or teardown.
2. A delivery racing cancellation belongs to exactly one side of the release
   point. Before it, the delivery belongs to S1 and is discarded with S1;
   after it, the delivery may create or resume S2. It is never delivered twice.
3. Cleanup from S1 remains addressed by session id and cannot mutate S2 even
   though S2 reuses C1.
4. Concurrent and duplicate requests are idempotent. At most one caller
   releases the binding; every caller receives a successful status.
5. Session cancellation follows the complete adopted execution tree,
   including local and remote descendants. Permanent descendant-cancellation
   failures are logged but do not let S1 retain the continuation identity.
6. Completed model, tool, channel, and external side effects are not rolled
   back. Partial output on S1's event stream remains observable.

The old session emits `session.cancelled` once and no subsequent
`session.waiting`. A replacement emits its own `session.started` and receives a
different session id.

## Built-in `/new`

Telegram and Twilio expose:

```ts
newSessionCommands?: false | readonly string[];
```

- omitted: `["new"]`;
- `false`: disabled;
- array: replaces the default command names.

Inbound authentication and authored gating run before command matching. Bare
`/new` cancels the session silently and creates no empty replacement. `/new
<message>` and attachments wait for the release barrier, then become the first
input of the fresh session. `/new@botname` matches only the configured Telegram
bot; prefixes such as `/newspaper` and unknown commands remain ordinary input.
Slack and custom channels opt in explicitly through their handlers.

## Architecture boundary

Whole-session cancellation belongs to the session driver, the durable owner of
continuation identity. The driver owns the closing flag, continuation release,
and terminal session event. The landed turn-cancellation mechanism remains the
primitive for stopping active work below that boundary.

The driver processes terminal cancellation as a stable session command. Audit
the durable session input version and pinned-driver compatibility explicitly.
Older drivers that cannot process terminal cancellation return
`"no_active_session"`.

## Verification and delivery

- Keep coverage for no-argument `ClientSession.cancel()` and empty-body HTTP
  cancellation.
- Race session cancellation against active delivery, turn completion,
  continuation rekeying, duplicate cancellation, and replacement `send()`.
- Prove old cleanup cannot reclaim the continuation or mutate the replacement
  session.
- Cover parked sessions, active model/tool work, pending HITL, nested local and
  remote descendants, and partially unavailable remotes.
- Verify client cursor clearing, authentication before binding inspection,
  non-disclosing stale results, `/new` parsing, and attachment handling.
- Add a custom-channel e2e fixture that cancels through public APIs, reuses one
  channel identity, and proves the replacement session has a new id, empty
  history, and fresh authored state.

This feature changes public APIs and events, so it requires published docs,
tests, an e2e fixture, and a patch changeset.
