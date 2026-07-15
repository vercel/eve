---
issue: https://github.com/vercel/eve/issues/483
status: proposed
last_updated: "2026-07-15"
---

# Turn cancellation for custom channels

## Summary

Chat-style webhooks often receive several short messages while an agent is
still responding. Plain `send()` queues those messages, so the agent can emit
an obsolete answer before it processes the newer context. Custom channels need
two operations:

- `send(payload, { supersede: "turn" })` queues the payload and cancels only
  the turn that was already active;
- `cancelTurn({ continuationToken, turnId? })` supports explicit stop commands.

The layer-2 runtime operation cancels by session id. Channel operations also
need a race-safe continuation-token lookup and delivery primitive. They cannot
be composed safely from today's independent hook resumes.

## Authoring API

```ts
export interface SendOptions<TState> {
  // Existing fields omitted.
  supersede?: "turn";
}

export interface RouteHandlerArgs<TState> {
  // Existing fields omitted.
  cancelTurn(options: { continuationToken: string; turnId?: string }): Promise<CancelTurnResult>;
}

export interface CancelTurnResult {
  status: "cancelling" | "no_active_turn";
}
```

`"cancelling"` means a registered cancellation hook accepted the request, not
that cancellation has settled or necessarily matched the caller's guarded
turn. `"no_active_turn"` covers unknown, idle, parked, swept, and otherwise
uncancellable sessions. Both are successful outcomes.

The one-member `supersede` union leaves room for a future
`supersede: "session"` reset operation without defining its semantics here.

## Example

```ts
export default defineChannel({
  routes: [
    POST("/webhooks/imessage", async (req, { send, waitUntil }) => {
      const inbound = await verifyAndParse(req);
      if (inbound instanceof Response) return inbound;

      waitUntil(
        send(
          { message: inbound.text },
          {
            auth: null,
            continuationToken: inbound.conversationId,
            supersede: "turn",
          },
        ),
      );
      return new Response(null, { status: 200 });
    }),
  ],
  events: {
    "message.completed": async (data, channel) => {
      if (data.finishReason !== "tool-calls" && data.message) {
        await channel.imessage.sendText(data.message);
      }
    },
  },
});
```

Filtering `finishReason: "tool-calls"` avoids sending pre-tool narration as a
final reply. Cancellation does not retract outbound side effects: if a handler
has already sent content, eve cannot take it back. A channel that requires a
strict no-superseded-output guarantee must buffer output until it observes the
turn's terminal event.

## Required semantics

### A superseding send must not cancel itself

The payload must be durably attached to the existing session before the
operation reports success. Cancellation must target the turn observed before
that delivery, using its `turnId`. If the session advances before cancellation
commits, the guard turns the cancellation into a no-op instead of cancelling
the turn that contains the new payload.

### Rekeying must not create a second session

`ctx.session.setContinuationToken()` can replace the delivery hook while a
webhook is in flight. Once the supersede operation resolves a continuation
token to an existing session, a concurrent rekey must not make delivery fall
through to `runtime.run()` and start a new history. The operation must either
deliver to the resolved session or return an explicit retryable conflict.

### Concurrent superseding sends must compose

Every accepted payload is delivered exactly once. Several sends may cancel the
same observed turn, and their payloads may be coalesced into the next turn in
the order defined by the existing delivery queue. No request may silently
retarget a newer turn.

### Existing cancellation limits remain

Task-mode and hook-conflict-degraded turns may have no current cancellation
hook. Superseding delivery still succeeds in that case and behaves like plain
queueing. Partial model output remains on the event stream, while durable model
history keeps only content that had already settled. Already-executed tool or
channel side effects remain; cancellation is not rollback.

## Runtime boundary

Neither simple ordering is sufficient:

- cancel then deliver leaves a gap where the channel token can rekey; the old
  delivery can miss and incorrectly start a fresh session;
- deliver then unguarded cancel can stop the new turn that already includes the
  payload.

The implementation therefore needs one runtime-owned composite operation:

```text
channel send
  │
  ▼
resolve token ──► existing session + observed active turn
  │
  ├─ durably deliver payload to that session
  └─ cancel only the observed turn id
       │
       └─ session advanced? guard mismatch, benign no-op
```

The exact World implementation may be transactional or use a stable
session-addressed inbox, but the observable invariants above are required.
`Runtime.cancelTurn({ sessionId, turnId? })` remains the primitive for explicit
session-id cancellation; channel token resolution belongs above it.

## Testing

- Unit-test result mapping and continuation-token namespacing.
- Prove delivery commits before the guarded cancellation is issued.
- Race `setContinuationToken()` against superseding delivery and assert the
  payload stays on the original session with no fallback run.
- Race turn settlement against superseding delivery and assert a newer turn is
  never cancelled.
- Exercise concurrent superseding sends and verify exactly-once delivery and
  deterministic coalescing.
- Cover idle, parked HITL, task-mode, stale `turnId`, and degraded turns.
- Add an e2e custom-channel fixture that supersedes a hanging turn and answers
  the complete coalesced input once.

## Out of scope

- Session reset, `/new`, and `supersede: "session"`.
- Descendant cancellation cascade.
- Cancellation from in-band event handlers.
- Built-in channel debounce policy.
- Retraction of already-sent channel messages or completed tool side effects.

## Delivery

Land the runtime composite and its race tests before exposing either public
channel API. The public additions require a patch changeset and channel
authoring documentation.
