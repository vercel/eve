---
issue: TBD
status: implemented
last_updated: "2026-10-30"
---

# Experimental inbound A2A channel

Publish an eve agent as an [A2A](https://a2a-protocol.org/) v1.0 server so orchestrators and
agents that speak A2A can delegate durable work to it. The import path is
`eve/experimental/channels/a2a`, so the API carries no compatibility promise while the spec and
its ecosystem settle. User-facing behavior is documented in `docs/experimental/a2a.mdx`.

```ts title="agent/channels/a2a.ts"
import { localDev } from "eve/channels/auth";
import { a2aChannel } from "eve/experimental/channels/a2a";

export default a2aChannel({ auth: localDev() });
```

The channel serves the Agent Card at `/.well-known/agent-card.json` and the JSON-RPC endpoint at
`/eve/v1/a2a`. Options: `auth` (required), `route`, `url`, `card`, `maxBlockingMs`, and
`uploadPolicy`.

## Target

A2A v1.0 (`specification/a2a.proto` at v1.0.1), JSON-RPC binding only. Requests must carry
`A2A-Version: 1.0`; an absent header means 0.3 per spec and is refused with
`VersionNotSupportedError`.

## Model

| A2A       | eve                                                                                          |
| --------- | -------------------------------------------------------------------------------------------- |
| context   | one session, created as an external invocation bound to the caller's principal               |
| task      | the turn its first delivery opened or joined; `taskId` encodes `(sessionId, deliveryId)`     |
| messageId | the delivery's idempotency key, hashed with the owner; the delivery ID derives from that key |

An eve turn stays `running` while it waits on interactions, so one task survives any number of
prompt round trips. Nothing is stored beyond the session: every read folds the session stream.

```
SendMessage{}                  -> create session (new context) -> task = turn 1
SendMessage{contextId}         -> send(turnPolicy: "queue")    -> task = next turn
SendMessage{taskId} working    -> send(turnPolicy: "steer")    -> same turn
SendMessage{taskId} interrupted-> typed answer (send)           -> same turn
```

### Retries

A retried `messageId` must reach the same task. The session drops a duplicate idempotency key
silently, so the channel names the delivery itself: `deliveryIdForIdempotencyKey(key)`, passed to
`channel-address` `deliver` as an internal option. A retry of the first message in a context
resolves the session through a continuation token derived from the same key, as eve-channel's
`operationId` does. A retry of a message that already arrived returns its task in whatever state it
is now, including terminal.

### Blocking and streaming

Blocking `SendMessage`, `SendStreamingMessage`, `SubscribeToTask`, and `CancelTask` all follow the
session stream (`streamSessionLines` with `follow`) and re-project after each line once caught up.
A message counts as read once its delivery is consumed or its answers admitted **and**, when it
continued an interrupted task, the status has moved past the prompt it answered: a typed answer is
consumed one line before its prompt settles. Blocking waits are capped by `maxBlockingMs` because a
request can't outlive the host's timeout.

Streams send the `task`, then a `statusUpdate` per change; completion sends the reply as one
`artifactUpdate` (`lastChunk: true`) before the final status. `SendStreamingMessage` closes at a
terminal or interrupted state, `SubscribeToTask` at a terminal one.

### Prompts

Interrupted status messages carry the prompts as text only, rendered as on any text channel, and
callers answer by typing (option number, label, or free-form text). eve's interaction JSON is an
internal format, so it stays off the wire; a structured A2A extension would be a separate,
versioned contract, deferred until callers need one.

## Auth and ownership

The JSON-RPC route runs the ordinary `routeAuth` walk; sessions are bound to
`invocationOwnerKey(auth)` and read through `readOwnedInvocationRun`, shared with the MCP channel.
Unknown, expired, and foreign tasks are indistinguishable (`TaskNotFoundError`).

The public card derives `securitySchemes` from the policy without calling it:
`admitsAnonymousCallers` (a `none()` marker) yields none; otherwise one HTTP scheme per challenge
`declaredAuthChallenges` returns, or `Bearer` as `routeAuth`'s 401 does. `oauthResource()` adds the
issuer and scopes. Applications override with `card.securitySchemes`.

## Validation

- Scenario tests drive a real `eve dev` server: discovery, version and capability refusals,
  principal isolation, typed answers, retries, pagination, cancel, failure,
  `returnImmediately`, streaming, and subscription.
- Interop was checked manually against the official clients `@a2a-js/sdk` 1.3.0 and `a2a-sdk`
  (Python) 1.3.0: every method, streaming and non-streaming, typed error mapping, and answers.
- The official [A2A TCK](https://github.com/a2aproject/a2a-tck) (`main` at `d4d6fae`, JSON-RPC)
  passed 63 of 64 applicable MUST requirements, every SHOULD, and 3 of 4 MAY. The harness ran
  `none()` auth behind a proxy that copied each `messageId` into the message text, because the
  TCK scripts agent behavior by `messageId` prefix and the model never sees IDs. The proxy also
  made each send's `messageId` unique: the TCK reuses one per scenario for distinct messages, and
  eve reads a repeated one as a retry (spec 3.3.1).
  - CORE-MULTI-002a fails because of a TCK bug
    ([a2a-tck#202](https://github.com/a2aproject/a2a-tck/issues/202)): the test asserts success
    for the MUST-reject case it cites. eve rejects unknown `contextId`s, as the MUST requires.
  - CORE-MULTI-002 (MAY accept client-chosen `contextId`s): not supported; a context is a session.
  - Four scripted agent behaviors aren't ones an eve agent produces: file and file-URL
    artifacts, a data artifact (eve structured output needs a per-message schema), and a
    direct `Message` reply (eve always answers with a task, which the spec allows).
  - Push notification, extended card, gRPC, and HTTP+JSON requirements skip, as the card
    declares none of them.
  - The TCK confirmed the typed-detail `error.data` fix and found two more bugs, now fixed:
    snake_case proto field names (`history_length`, `context_id`) were silently dropped, and a
    non-JSON `Content-Type` was accepted. It also prompted the card's `ETag` and
    `Last-Modified`.

## Not supported

- gRPC and HTTP+JSON bindings; A2A 0.3 clients.
- Push notifications (`pushNotifications: false`; the methods return their spec error).
- Extended Agent Card.
- `ListTasks` without `contextId`: eve keeps no per-owner index of sessions.
- Cancelling a `SUBMITTED` task queued behind another turn: eve can't withdraw a queued delivery.
- Token-level artifact streaming: reply parts are known when the turn settles.
- Background tasks that open prompts after their turn ends aren't part of any A2A task.
