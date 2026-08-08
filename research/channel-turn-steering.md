---
issue: https://github.com/vercel/eve/issues/867
status: proposed
last_updated: "2026-08-08"
---

# Default channel experimental steering

## Summary

When a channel accepts a new message while its session is working, the new
message should supersede that work by default. eve should cancel the active
turn and start a replacement turn with the new message. Authors who need every
turn to finish can opt into queueing instead.

Expose one policy across every channel:

```ts
type TurnPolicy = "experimental-steer" | "queue";
```

`"experimental-steer"` is the default. It uses eve's existing cooperative
turn cancellation and next-turn delivery. The interrupted turn emits
`turn.cancelled` followed by `session.waiting`; the replacement message starts
a new turn with a new turn ID. This is the behavior Photon already exposes,
generalized at the channel boundary.

This proposal does not inject input into a running model or tool step. That
would require a second in-turn delivery protocol for little user-visible gain.
The `experimental-` prefix distinguishes this cancellation-backed behavior
from that eventual steering model.

## Authoring API

Export the policy type from `eve/channels`. Every built-in channel factory and
`defineChannel` accepts the same optional setting:

```ts
export type TurnPolicy = "experimental-steer" | "queue";

// On each channel config:
readonly turnPolicy?: TurnPolicy;
```

Omission means `"experimental-steer"`:

```ts
export default slackChannel({
  credentials: connectSlackCredentials("slack/my-agent"),
});
```

Set `"queue"` when overlapping messages must wait for the current turn:

```ts
export default slackChannel({
  credentials: connectSlackCredentials("slack/my-agent"),
  turnPolicy: "queue",
});
```

The same option works on the base HTTP channel and custom channels:

```ts
export default eveChannel({
  auth: [vercelOidc(), localDev()],
  turnPolicy: "queue",
});
```

```ts
export default defineChannel({
  turnPolicy: "queue",
  routes: [
    POST("/messages", async (request, { from }) => {
      const body = await request.json();
      const session = await from(body.threadId).send(body.text, { auth: null });
      return Response.json({ sessionId: session.id });
    }),
  ],
});
```

Imperative message sends may override the channel default with the same
`turnPolicy` field. This applies to `ChannelSource.send`, `Session.send`,
cross-channel sends, and Chat SDK bridge sends. The resolution order is:

1. the send's `turnPolicy`, when supplied;
2. the channel's `turnPolicy`, when supplied;
3. `"experimental-steer"`.

Built-in inbound handlers use the channel default. They do not need to return
the policy with every accepted message.

The existing Chat SDK value `"experimental-steer"` becomes the shared policy
name. Photon stops hard-coding its own steering path and inherits the shared
default.

## Admission and steering are separate

A channel still decides whether a platform event is a user message and whether
to accept it. Steering runs only after that decision:

```text
platform event
     │
     ▼
channel auth, deduplication, mention, and ownership rules
     │
     ├── drop ───────────────────────────────► no session change
     │
     └── accept message
              │
              ▼
      turnPolicy: experimental-steer | queue
              │
              ├── queue ─────────────────────► next turn
              │
              └── steer ─► cancel active turn ─► replacement turn
```

This boundary matters on shared surfaces. An ignored Slack bystander message,
failed webhook verification, duplicate event, or rejected eve HTTP request
must never cancel a turn. App-specific policies such as “only the person who
started this Slack thread may continue it” remain in the channel's message
hook. Those hooks no longer need to call `ctx.cancel()` to get steering.

The change does not make ambient platform events eligible for delivery.
Mention, direct-message, thread, command, and subscription rules remain owned
by each channel.

## Observable behavior

| Session state                        | `"experimental-steer"`                                           | `"queue"`                              |
| ------------------------------------ | ---------------------------------------------------------------- | -------------------------------------- |
| No session owns the address          | Start a session and its first turn.                              | Same.                                  |
| Session is parked                    | Start the next turn normally.                                    | Same.                                  |
| A conversation turn is active        | Cancel it, then start a replacement turn with the new message.   | Preserve the message for a later turn. |
| A task turn is active                | Cancel it, then run the replacement turn in the same session.    | Preserve existing task behavior.       |
| The active turn settles concurrently | Start the message normally; no extra cancellation is fabricated. | Start or queue it normally.            |

Successfully admitted messages are never dropped. A steering message belongs
to the session before cancellation is requested, so a fast cancellation or
turn-settlement race cannot strand the replacement.

Multiple steering messages retain durable arrival order. Messages admitted
before the cancelled turn settles may be coalesced into the replacement turn,
using eve's existing queued-delivery behavior. If a later message arrives after
the replacement turn starts, it steers that turn in the same way.

Steering is cooperative cancellation, not rollback:

- partial output already emitted remains on the event stream;
- completed tool, channel, sandbox, and external side effects remain complete;
- durable history keeps content that had already settled;
- active descendants are cancelled through the existing recursive
  cancellation path;
- authored `turn.cancelled` handlers run for an automatic steer.

Pure `inputResponses` deliveries never steer. They answer the pending request
they address. `cancel()` also remains available as a stop-without-replacement
operation.

## Runtime design

Do not implement steering as two public operations:

```ts
await session.cancel();
await session.send(message, options);
```

Concurrent webhook handlers can interleave those calls, allowing two cancel
requests to land before either replacement message. Instead, carry the policy
on the existing send/delivery envelope:

```ts
type SessionCommand = {
  kind: "send";
  payload: DeliverPayload;
  turnPolicy?: "experimental-steer" | "queue";
  // existing fields omitted
};

interface DeliverHookPayload {
  kind: "deliver";
  payloads: readonly DeliverPayload[];
  turnPolicy?: "experimental-steer" | "queue";
  // existing fields omitted
}
```

The channel operation resolves its effective policy and dispatches one durable
command. The session driver handles it as follows:

1. If no turn is active, consume it through the existing parked-delivery path.
2. If a turn is active and the policy is `"queue"`, buffer it exactly as today.
3. If a turn is active and the policy is `"experimental-steer"`, buffer the
   delivery first, then forward an unguarded cancellation to the active turn.
4. After the turn reports cancellation, use the existing cancellation
   epilogue and next-turn delivery path to start the replacement.

Buffering before forwarding cancellation is the only new driver invariant. It
couples replacement ownership to the cancellation request without adding a new
command kind, hook, ledger, abort signal, turn disposition, or same-turn input
path.

The cancellation is intentionally unguarded. Steering means “supersede
whichever turn owns this session when the durable command is consumed,” not
“cancel the turn a webhook process happened to observe.”

### Version skew

`turnPolicy` is an optional additive field on the existing delivery envelope.
An older pinned session driver ignores it and queues the message, which is the
safe fallback. A newer driver treats an omitted field as `"queue"`, preserving
deliveries produced by older deployments. No durable workflow migration or
capability handshake is required.

## Built-in channel projection

- **eve:** message POSTs to an active session use the configured policy.
  `inputResponses` and explicit control routes do not steer.
- **Slack, Teams, Telegram, Discord, Twilio, GitHub, and Linear:** every
  accepted message send inherits the channel policy. Platform admission rules
  remain unchanged.
- **Photon:** remove its hard-coded policy and inherit the common
  `"experimental-steer"` default.
- **Chat SDK:** retain `"experimental-steer" | "queue"`, default to experimental
  steering, and stamp the resolved policy on the common delivery command.
- **Custom and cross-channel delivery:** `defineChannel` and the target channel
  own the default; an explicit send option overrides it.

## Verification

Focused coverage should prove:

- message sends default to `"experimental-steer"` on channel-addressed and
  session-ID surfaces;
- `turnPolicy: "queue"` preserves the current behavior;
- dropped or rejected platform messages never cancel active work;
- input responses and explicit controls do not trigger steering;
- an active turn emits `turn.cancelled` and `session.waiting` before the
  replacement turn starts;
- rapid steering messages remain ordered and are not separated from their
  cancellation intent by concurrent dispatch;
- a terminal race consumes the message once;
- older pinned drivers safely queue a delivery carrying the optional field;
- every built-in channel passes its configured default through the shared
  operation instead of implementing cancellation itself.

Public exposure requires channel docs, a patch changeset, focused unit and
integration tests, the standard repository checks, and a deterministic channel
e2e covering one active-turn replacement.

## Out of scope

- Applying replacement input inside the same turn ID.
- Interrupting or rewriting an atomic model or tool step without cancellation.
- Rolling back streamed output or completed side effects.
- Changing platform-specific admission, mention, or conversation-ownership
  rules.
- Debounce windows, priority queues, or latest-message-only coalescing.

## Success criteria

An ordinary accepted message steers an active session without channel-specific
code. Authors select queueing with one shared option. The implementation reuses
eve's cancellation and queued-delivery machinery, and every admitted
replacement message remains owned exactly once across cancellation, replay,
and turn-settlement races.
