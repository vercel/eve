---
issue: https://github.com/vercel/eve/issues/216
status: proposed
last_updated: "2026-07-16"
---

# Session reset for long-lived channels

## Summary

Turn cancellation is now implemented end to end: it aborts active work,
cancels adopted descendants, emits `turn.cancelled` followed by
`session.waiting`, and leaves the session resumable. Session reset remains a
different operation.

Identity-based channels such as Telegram private chats and Twilio
conversations reuse one continuation identity indefinitely. Reset must release
that identity from the old session, terminate the old execution tree, and let
the next message create a fresh session with empty history and authored state.
It must not change the meaning of the landed turn-cancellation route or
`ClientSession.cancel()`.

## Public API

Use reset-specific names rather than adding a `scope` union to the existing
turn-cancellation API.

### HTTP

```http
POST /eve/v1/session/:sessionId/reset
content-type: application/json

{ "continuationToken": "<current continuation token>" }
```

The route returns `202` with:

```ts
interface ResetSessionResult {
  sessionId: string;
  status: "accepted" | "no_active_session";
}
```

`"accepted"` means the `(sessionId, continuationToken)` binding was verified
and the continuation identity was durably released. Tree teardown may still be
finishing. `"no_active_session"` covers stale, unknown, already-reset, or
mismatched bindings. Both are idempotent success outcomes.

### Custom channels

```ts
export interface RouteHandlerArgs<TState> {
  // Existing helpers omitted.
  resetSession(options: { continuationToken: string }): Promise<ResetSessionResult>;
}
```

The token is channel-local, matching `send()`. A reset with replacement input
is explicit sequencing, not a composite hidden inside `send()`:

```ts
await resetSession({ continuationToken: threadId });
await send(replacementMessage, {
  auth,
  continuationToken: threadId,
});
```

`resetSession()` resolves only after the continuation identity is available,
so the following `send()` cannot resume the old workflow.

### Client, frontend, and evals

- `ClientSession.resetSession()` calls the reset route and clears its saved
  session id, continuation token, and stream cursor after `accepted`.
- Frontend stores add an async `resetSession()` for server reset. Their existing
  synchronous `reset()` remains a local UI-state operation and must not imply
  server cancellation.
- Eval sessions add `t.resetSession()` so a test can assert the old
  `session.cancelled` boundary and then reuse the same identity for a fresh
  session.
- Aborting a request or stream with `AbortSignal` remains local transport
  cancellation. `ClientSession.cancel()` continues to cancel only the active
  turn.

## Lifecycle and ordering

The continuation release is the reset linearization point:

```text
verify (session S1, continuation C1)
              │
              ▼
mark S1 closing and release C1
              │
              ├── acknowledge reset; C1 may now create S2
              └── cancel S1 active turn and descendants
                         │
                         └── emit session.cancelled and finish S1
```

Required invariants:

1. Once closing begins, S1 cannot accept new input, start another turn, or
   reclaim C1 during replay or teardown.
2. A delivery racing reset belongs to exactly one side of the release point:
   before it, the delivery belongs to S1 and is discarded with the reset;
   after it, the delivery may create or resume S2. It is never delivered to
   both.
3. Cleanup from S1 remains addressed by session id and cannot mutate S2 even
   though S2 reuses C1.
4. Concurrent and duplicate resets are idempotent. At most one caller releases
   the binding; every caller receives a successful status.
5. Reset cancellation follows the complete adopted execution tree, including
   local and remote descendants. Permanent descendant-cancellation failures are
   logged but do not let S1 retain the continuation identity.
6. Completed model, tool, channel, and external side effects are not rolled
   back. Partial output on S1's event stream remains observable.

The old session emits `session.cancelled` once and no subsequent
`session.waiting`. A replacement session emits its own independent
`session.started` and receives a different session id.

## Built-in `/new`

Telegram and Twilio expose:

```ts
resetCommands?: false | readonly string[];
```

- omitted: `["new"]`;
- `false`: disabled;
- array: replaces the default command names.

Inbound authentication and authored gating run before command matching. Bare
`/new` resets silently and creates no empty session. `/new <message>` and
attachments wait for the release barrier, then become the first input of the
new session. `/new@botname` matches only the configured Telegram bot;
prefixes such as `/newspaper` and unknown commands remain ordinary input.
Slack and custom channels opt in explicitly through their handlers.

## Architecture boundary

Session reset belongs to the session driver, the durable owner of continuation
identity. It should be represented as a stable session command, not simulated
as “cancel the turn, dispose a hook, then hope the next delivery starts over.”
The driver owns the closing flag, continuation release, and terminal session
event; the landed turn-cancellation mechanism remains the primitive for
stopping active work below that boundary.

The durable session input version and any pinned-driver compatibility path must
be audited explicitly. Older drivers that do not understand reset commands
must reject them as `no_active_session`; they must not treat them as user input.

## Verification and delivery

- Race reset against active delivery, turn completion, continuation rekeying,
  duplicate reset, and replacement `send()`.
- Prove old cleanup cannot reclaim the continuation or mutate the replacement
  session.
- Cover parked sessions, active model/tool work, pending HITL, nested local and
  remote descendants, and partially unavailable remotes.
- Verify client cursor clearing, frontend local-versus-server reset semantics,
  eval controls, authentication before binding inspection, and non-disclosing
  stale results.
- Add a custom-channel e2e fixture that resets through public APIs, reuses one
  channel identity, and proves new session id, history, and authored state.

This feature changes public APIs and events, so it requires published docs,
tests, an e2e fixture, and a patch changeset.
