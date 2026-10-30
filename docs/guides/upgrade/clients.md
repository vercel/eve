---
title: "Upgrade Clients and Frontends"
description: "Update eve/client code, frontend stores and hooks, session controls, errors, and request shapes for eve 1.0."
navTitle: "Clients and Frontends"
---

Read this page if your project calls an agent through `eve/client`, a frontend binding such as `useEveAgent`, `SessionStore`, or the HTTP API. Deploy the upgraded server first, because new clients call routes, such as `POST /eve/v1/session/:sessionId/end`, that older servers don't serve. Sections start with the changes most frontends need.

This page is part of [Upgrade to 1.0](/docs/guides/upgrade).

## Update frontend stores and hooks

| Before                                                            | After                                                                       |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `EveAgentStore`                                                   | `SessionStore`                                                              |
| `host`                                                            | `baseUrl` (required on a direct client; frontend default `""`)              |
| `data.messages`, `data.agents`, and other fields under `data`     | `view`, `messages`, `agents`, `events`, `session`, `status`, `error`        |
| `conversationReducer`, `defaultMessageReducer`, `EveAgentReducer` | Query `view` with selectors from `eve/events`; read `messages` and `agents` |
| `transcriptReducer(options)`                                      | `transcriptOf(events, options)`                                             |
| `followIdle: true`                                                | Omit `followWhile`                                                          |
| `followIdle: false`                                               | `followWhile: (view) => !idle(view) \|\| activeTurn(view) !== undefined`    |
| Busy status for a Stop control                                    | `activeTurn(view)`                                                          |

Import `idle` and `activeTurn` from `eve/events`. The `followIdle: false` replacement also keeps following while a turn waits for a person.

`messages` shows only the current conversation, so messages from before a clear don't appear. `view` still holds every retained turn.

Save events and the cursor as they arrive, not only when a turn ends, so a turn paused for an approval survives a page reload. See [Frontend](/docs/guides/frontend).

## Replace `reset()` with `end()`

Rename `reset()` to `end()` on client sessions, `SessionStore`, the React, Vue, and Svelte bindings, channel session handles, `ChannelSource` from `eve/channels`, and the Slack handler context (`ctx.end()`). `end()` resolves with a delivery.

```ts
await session.reset({ reason: "Conversation finished" }); // [!code --]
await session.end({ reason: "Conversation finished" }); // [!code ++]
```

Move HTTP callers from `POST …/reset` to `POST …/end`. The server still serves `/reset`, and the stream still records the control as `source: { control: "reset" }` on `delivery.admitted`.

`end()` retires the session permanently, and the handle keeps the retired ID. Don't use it for a **New chat** button. Choose the call that matches what the button should do:

| Goal                                                         | Call                                                                                                        |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Start a new conversation, and the store creates sessions     | `newSession()`                                                                                              |
| Start a new conversation, and you pass in your own `session` | Create a client session, as below, and bind a new store to it. `newSession()` only clears local state here. |
| Clear the model's context but keep the session               | `clear()`. It cancels a running turn and stops its background tasks.                                        |
| Close the conversation for good                              | `end()`                                                                                                     |

```ts
import { Client } from "eve/client";

const client = new Client({ baseUrl: "https://agent.example" });
const { session } = await client.sessions.create();
await session.send("Start a new conversation.");
```

See [Session controls](/docs/guides/client#sessions).

## Read results from a delivery

A `Delivery` is the receipt for one message or control. `send()` and the session controls return it as soon as the server accepts the request, before the agent runs. Read the rest from the delivery:

- `delivery.result()` waits for the outcome. Its `status` is `completed`, `awaiting-input`, `failed`, or `cancelled`, and it describes this request, not the session. Check `sessionEnded` to learn whether the session ended.
- `delivery.stream()` yields the events for this request.

Each read is independent and accepts a signal. Results don't include an `events` array, so read events from `delivery.stream()`.

`client.sessions.create()` returns `{ session, delivery }` when you pass a message, and `{ session }` when you don't. See [Client streaming](/docs/guides/client/streaming).

## Handle client errors by code

Every error from `eve/client` extends `EveError` and has a stable snake_case `code`. Narrow with each class's static `is()` instead of `instanceof`, so errors from a separately bundled copy of eve still match.

```ts
if (error instanceof SessionNotActiveError && error.code === "EVE_SESSION_NOT_ACTIVE") { // [!code --]
if (SessionNotActiveError.is(error) && error.code === "session_not_active") { // [!code ++]
  // Start a new session.
}
```

`SessionNotActiveError` has one of two codes:

- `session_not_ready`, with `retryable: true`, while the session is still starting. Retry the request.
- `session_not_active` once the session can't take requests. Start a new session.

`ClientError.code` is `http_error` when the server's response had no code.

## Save the full session snapshot

`session.state` is the whole `ClientSessionState`, not only `sessionId` and `streamIndex`, and `session.snapshot()` returns the same state as `snapshot.session`. It includes an opaque `inbox` value that lets later sends skip a server-side session lookup. Save the complete state as is, and pass it back unchanged, for example with `client.sessions.attach(saved.sessionId, saved)`. See [Faster sends with `inbox`](/docs/guides/client#faster-sends-with-inbox).

In server code, `sessions.attach(id)` from `eve/server` returns a read-only `SessionReader` with `id` and `stream()`, not a handle that can send. Use `SessionInfo` from `eve/context` for the metadata in `ctx.session`. See [Read a session in process](/docs/concepts/sessions-runs-and-streaming#read-a-session-in-process).

## Check request shapes

- The eve channel rejects unknown top-level fields on session creation, message, and control requests with `400`, naming the fields it accepts. Fix misspelled or unsupported options instead of relying on them being ignored. See [the eve channel](/docs/channels/eve).
- `history` passed to `send()` or `create()` accepts only `id`, `role`, and `text` on each entry, and an unknown field throws `InvalidSessionHistoryError`. Map stored messages to that shape before you pass them.
- Clients reject redirects by default. Point `baseUrl` at the final destination, or set `redirect: "manual"`. See [Authentication](/docs/guides/client#authentication).
- `ctx.agent().send()` file parts must be HTTP(S) URLs, not inline bytes or base64.

## Flatten reconnect options

Replace `streamReconnectPolicy` with `reconnect`. Move the fields from `streamOpenReconnectPolicy` directly into `reconnect`, and rename `retryableErrorStatuses` to `retryableStatuses`. Defaults are unchanged. Use the `ReconnectOptions` type from `eve/client` instead of `StreamReconnectPolicy` or `StreamReconnectRetryPolicy`. See [Reconnection](/docs/guides/client/streaming#reconnection).

```ts
const delivery = await session.send("Continue the review.", {
  streamReconnectPolicy: { // [!code --]
    streamOpenReconnectPolicy: { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 5000 }, // [!code --]
    retryableErrorStatuses: [429, 503], // [!code --]
  reconnect: { // [!code ++]
    maxAttempts: 3, // [!code ++]
    baseDelayMs: 250, // [!code ++]
    maxDelayMs: 5000, // [!code ++]
    retryableStatuses: [429, 503], // [!code ++]
  },
});
```

To turn off automatic reconnects, replace `streamReconnectPolicy: { reconnect: false }` with `reconnect: false`.

## Read agent info with an operator credential

`GET /eve/v1/info` and `client.info()` serve only operators: `service` and `runtime` callers, such as Vercel OIDC, `jwtHmac()`, or `jwtEcdsa()`, and local development through `localDev()`. Other callers, including web chat users, get `403` with code `info_forbidden`.

- Move browser calls to `client.info()` to your server, or hardcode what they show.
- To admit another credential, return `principalType: "service"` or `allowAgentInfo: true` from its eve channel authenticator. `allowAgentInfo: false` denies a caller that would otherwise qualify.
- The client reads an enum value it doesn't know as `"unrecognized"`. Handle that value when you switch on fields such as `mode` or `sourceKind`. Fields named `kind` gain values only with a new agent-info version.

`eve eval` against a deployment also needs an operator credential. See [Agent info access](/docs/guides/auth-and-route-protection#agent-info-access).
