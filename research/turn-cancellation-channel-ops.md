---
issue: https://github.com/vercel/eve/issues/483
status: proposed
last_updated: "2026-07-15"
---

# Turn cancellation, channels: supersede delivery and channel cancel ops

## Summary

Custom channels (`defineChannel`) have no way to cancel a turn. The
textbook case is an iMessage-style channel: one durable session per
conversation (like Twilio's `from:to` identity), where humans text in
chunks — three short messages in ten seconds. Today each webhook `send`
queues behind the in-flight turn, so the agent answers message 1 in
full, then message 2, then message 3, destroying conversational
continuity. What the channel wants is a debounce: each new message
stops the in-flight response so the next turn answers the accumulated
chunk at once.

Half of this already exists. Deliveries to a busy session queue durably
on the session delivery hook and are **coalesced into one turn** when
the turn settles (`coalesceDeliveries` → `coalesceTurnInputs`,
`execution/workflow-entry.ts:333`, `harness/messages.ts:14`). The only
missing piece is stopping the in-flight turn — and doing so without
ever killing the turn that is answering your own message.

This plan adds two channel-author surfaces built entirely on shipped
layer-1 primitives (`{sessionId}:cancel` hook, `turn.cancelled` →
`session.waiting` settle) with **no workflow-side changes**:

- `send(payload, { supersede: "turn" })` — deliver a message and cancel
  the turn it supersedes, in one race-safe operation;
- `cancelTurn({ continuationToken, turnId? })` on `RouteHandlerArgs` —
  a plain cancel for stop-command UX, mirroring the layer-2 HTTP route.

## The use case, end to end

```ts
// channels/imessage.ts
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
      await channel.imessage.sendText(data.text);
    },
  },
});
```

Timeline: message 1 starts turn T1. Message 2 arrives mid-turn — the
superseding send cancels T1 and queues message 2. Message 3 arrives —
cancels whatever is running, queues behind. When the dust settles, the
driver drains every queued message into **one** coalesced turn whose
history already contains message 1 (and T1's partial output), so the
agent produces a single reply to the whole chunk. No cancelled turn
ever reaches the user: outbound delivery rides `message.completed`,
which a cancelled turn never emits, and cancel is not failure, so
`turn.failed` apology handlers stay silent.

This is the durable, timer-free debounce: no quiet-period timers (which
serverless routes cannot hold), at the cost of the superseded turns'
aborted model calls.

## Authoring API

### `SendOptions.supersede`

```ts
export interface SendOptions<TState> {
  // ...existing: auth, continuationToken, callback, mode, title, state
  /**
   * Cancels the in-flight turn this message supersedes, so the next
   * turn responds to every queued message at once. Never cancels a
   * turn that includes this message. No-op when the session is idle,
   * parked, or does not exist.
   */
  supersede?: "turn";
}
```

Typed as a one-member union: `"session"` is reserved for the
session-reset work (`research/channel-session-reset.md`), where
`send(msg, { supersede: "session" })` becomes the natural spelling of
"/new with replacement content." The return type is unchanged
(`Session`); channels that care observe the `turn.cancelled` event.

### `RouteHandlerArgs.cancelTurn`

```ts
export interface RouteHandlerArgs<TState> {
  // ...existing: send, getSession, receive, params, waitUntil, requestIp
  cancelTurn(options: {
    /** Channel-local token, namespaced like `send`'s. */
    continuationToken: string;
    /** Scope the cancel to an observed turn (from `turn.started`). */
    turnId?: string;
  }): Promise<CancelTurnResult>;
}

export type CancelTurnResult = {
  status: "cancelling" | "no_active_turn";
};
```

The plain stop button: a user texts "stop", the route calls
`cancelTurn` and delivers nothing. Result semantics mirror the layer-2
HTTP route exactly — `"cancelling"` means delivered to a live turn (not
settled yet; observe `turn.cancelled` on events), `"no_active_turn"`
covers idle, parked, already-settled, uncancellable (task-mode), and
unknown sessions. Both are success; no exceptions for benign races.

## Semantics

- **The supersede invariant**: a superseding send never cancels a turn
  that includes its own message. Guaranteed by ordering, not turn-id
  discovery: the cancel commits _before_ the delivery commits, and a
  turn cannot contain a message that has not been delivered.
- **Best-effort effectiveness**: a turn that starts in the instant
  between the cancel and the delivery commit is not superseded — the
  message queues behind it normally, exactly like a plain send. Safe,
  rare, and self-healing (the next superseding message cancels it).
- **Concurrent superseding sends compose.** Each cancels whatever
  pre-existing turn is running; all messages coalesce into the next
  turn. Consumed messages from cancelled turns stay in history, so the
  final turn always has the full chunk in context.
- **Partial content persists** (layer-1 invariant, unchanged): whatever
  the superseded turn settled before the abort stays in history and on
  the stream. Webhook channels never surface it — they deliver on
  `message.completed` — but the model sees its own aborted partial,
  which is what gives the final reply continuity.
- **HITL answers are safe.** A session parked on root `input.requested`
  has no live turn workflow (parking terminates it), so the cancel
  no-ops and the delivery resolves the input request exactly as today.
  A turn live-waiting on a _descendant_ HITL request is cancelled with
  layer 1's defined semantics (the proxy map clears; later answers stay
  with the parent).
- **Uncancellable turns degrade to plain queueing**: task-mode and
  hook-conflict-degraded turns have no cancel hook, so supersede
  delivers without cancelling — same outcome as today.
- **Rekeyed tokens**: channels that call `setContinuationToken` must
  supersede/cancel with the current token; a stale token resolves to no
  session and returns `"no_active_turn"` (or falls back to a fresh
  session, for `send`) — the same contract plain `send` already has.
- **No auth parameter on `cancelTurn`.** Route handlers are trusted
  authored code; provider verification (signatures, allow-lists) gates
  the route before any op runs, identical to `send` today.

## Data flow

```text
webhook route             send({ message }, { supersede: "turn", continuationToken })
  │                       channel/send.ts
  ├─ 1  getHookByToken(nsToken)         non-mutating; → sessionId (owner runId)
  │       └─ miss → skip 2, plain resume-or-start (nothing to supersede)
  ├─ 2  resumeHook(`${sessionId}:cancel`, {})     unguarded; HookNotFoundError → benign
  │       └─ layer 1: turn aborts, settles turn.cancelled → session.waiting
  └─ 3  runtime.deliver(...)            existing path; payload buffers durably
          │
driver    waitForNextDeliver            execution/workflow-entry.ts:333
          coalesceDeliveries(+ every buffered payload) → ONE turn input
          → next turn answers the full chunk
```

`cancelTurn` is steps 1–2 alone, with the optional `turnId` forwarded
in the hook payload (mismatch consumed as a no-op inside the turn,
layer-1 semantics). Implementation seams: a `Runtime.cancelTurn` method
beside `deliver` (`execution/workflow-runtime.ts`), a `supersede`
branch in `createSendFn` (`channel/send.ts:13`) composing
cancel-before-deliver, and wiring in `buildRouteArgs`
(`internal/nitro/routes/channel-dispatch.ts:165`). `getHookByToken` is
already exported by the vendored runtime
(`#compiled/@workflow/core/runtime.js`) and needs only the
`#internal/workflow/runtime.js` re-export.

## Relationship to other cancellation work

- **Depends only on layer 1** (shipped). Channel ops resume the cancel
  hook directly through the runtime — they do not proxy through the
  layer-2 HTTP route (`research/turn-cancellation-trigger-surface.md`),
  so the two can land in either order.
- **Supersedes the turn-scope channel-ops sketch in
  `research/channel-session-reset.md`**: that design predates layer 1
  and assumed per-turn `cancelToken` capabilities, which layer 1
  obsoleted (stable session-scoped hook + optional `turnId` guard).
  Session-scope cancel, `/new`, and reset-session decisions remain
  governed there; `supersede: "session"` is this API's reserved hook
  into that work.
- **Event-handler cancellation** (`ChannelSessionOps.cancelTurn`, e.g.
  a moderation guard aborting its own turn from `message.appended`) is
  deliberately excluded: handlers run in-band on the turn's own
  event-write path, and self-cancellation semantics deserve their own
  review.

## Testing

- **Unit**: `createSendFn` supersede branch (cancel ordered before
  deliver; lookup miss skips the cancel; `HookNotFoundError` on the
  cancel is swallowed; inert without `supersede`), `Runtime.cancelTurn`
  result mapping, `cancelTurn` token namespacing.
- **Integration** (world-local, real `workflowEntry` + `turnWorkflow`,
  mirroring `turn-cancellation.integration.test.ts`): superseding send
  against a hanging turn → `turn.cancelled` → next turn's input
  contains both messages coalesced; supersede on an idle session
  behaves byte-for-byte like plain send; supersede answering a parked
  root HITL request resolves the input without cancelling anything;
  `cancelTurn` with stale `turnId` guard no-ops with the turn still
  running; concurrent superseding sends settle to one final turn.
- **E2E**: add an eval to the `agent-cancellation` fixture (created by
  layer 2) with a custom `defineChannel` using only public channel
  APIs: post two messages in quick succession, assert exactly one
  `turn.cancelled`, and one final response that addresses both.

## Out of scope

- Session-scope cancellation, `/new`, `supersede: "session"`
  (`research/channel-session-reset.md`).
- Event-handler (`ChannelSessionOps`) and in-session callback
  cancellation ops.
- Supersede/debounce options on the built-in channels (Twilio,
  Telegram, Slack) — natural follow-ups once the primitive ships, e.g.
  `twilioChannel({ supersede: true })`.
- Descendant cascade (layer 3) and client APIs
  (`MessageResponse.cancel()`, layer 4 clients/evals).
- Pre-dispatch quiet-period debounce (durable timers); supersede is the
  timer-free equivalent.

## Delivery

One PR with a **patch** changeset: `Runtime.cancelTurn`,
`SendOptions.supersede`, `RouteHandlerArgs.cancelTurn`, docs for both
public additions on the channel authoring page, unit + integration
tests, and the fixture eval. Public API docs must state the supersede
invariant and the best-effort window explicitly.
