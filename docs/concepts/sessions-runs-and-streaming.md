---
title: "Sessions, Runs & Streaming"
description: "The session and run contract you touch: continuation tokens, stream handles, the NDJSON event stream, and reconnecting."
---

Every eve app speaks the same stable HTTP API to a [durable session](./execution-model-and-durability). This page is the contract you hold: the handles you get back, the events you stream, and how to reconnect.

## The two handles

Two handles do two jobs, and mixing them up is the most common mistake. One handle creates and resumes a session; a different one streams and inspects it.

- **`continuationToken`**: the resume handle. Use it to send a follow-up message to the same conversation. Owned by the channel.
- **`sessionId` / `runId`**: the stream-and-inspect handle. Use it to attach to the event stream and watch a run. Owned by the runtime.

A session has one active continuation at a time: each follow-up uses the current `continuationToken`, and a stale one is rejected.

React, Vue, and Svelte apps reach for [`useEveAgent()`](../guides/frontend/overview) instead of calling these routes by hand. Next.js and Nuxt apps can proxy them to the eve runtime from the same origin.

## Start a session

```bash
curl -X POST http://127.0.0.1:3000/eve/v1/session \
  -H 'content-type: application/json' \
  -d '{"message":"Summarize the latest forecast."}'
```

eve responds right away. The JSON body carries a `sessionId` and a `continuationToken`, and the `x-eve-session-id` header names the durable session to stream.

## Stream a session

```bash
curl http://127.0.0.1:3000/eve/v1/session/<sessionId>/stream
```

The stream is newline-delimited JSON (NDJSON), one event per line:

| Event                     | Meaning                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `session.started`         | A durable session was created.                                                                                   |
| `turn.started`            | A new turn began.                                                                                                |
| `message.received`        | An inbound user message was accepted; carries flattened text plus structured text/file parts.                    |
| `step.started`            | A model step began.                                                                                              |
| `actions.requested`       | The model requested one or more actions, including tool calls; calls stream before execution.                    |
| `action.result`           | A tool call returned.                                                                                            |
| `input.requested`         | The run paused for human input ([HITL](/docs/human-in-the-loop) approval or `ask_question`); carries `requests`. |
| `subagent.called`         | A subagent was delegated; carries `childSessionId` to attach to.                                                 |
| `subagent.completed`      | A delegated subagent finished.                                                                                   |
| `reasoning.appended`      | A reasoning delta (incremental, with cumulative text so far).                                                    |
| `reasoning.completed`     | The finalized reasoning block.                                                                                   |
| `message.appended`        | An assistant text delta (incremental, with cumulative text so far).                                              |
| `message.completed`       | A finalized assistant text block.                                                                                |
| `result.completed`        | The finalized structured result for a turn that requested an output schema; carries `result`.                    |
| `compaction.requested`    | Context-window compaction began; carries `modelId`, `sessionId`, `turnId`, `usageInputTokens`.                   |
| `compaction.completed`    | A compaction checkpoint was written to durable history.                                                          |
| `authorization.required`  | A connection needs OAuth; carries `name`, `description`, and an `authorization` challenge.                       |
| `authorization.completed` | A connection's authorization resolved; carries `outcome`.                                                        |
| `step.completed`          | A model step finished; carries `finishReason` and usage.                                                         |
| `step.failed`             | A model step failed; carries `{ code, message, details? }`.                                                      |
| `turn.completed`          | The turn finished.                                                                                               |
| `turn.failed`             | The turn failed; carries `{ code, message, details? }`.                                                          |
| `turn.cancelled`          | The turn was cancelled before finishing; always followed by `session.waiting`.                                   |
| `session.waiting`         | The session parked for the next input; carries the current channel-owned `continuationToken`.                    |
| `session.failed`          | The session failed.                                                                                              |
| `session.completed`       | The session reached a terminal end.                                                                              |

`reasoning.appended` and `message.appended` stream incremental output as it arrives. When the durable stream writer is busy, eve may coalesce adjacent deltas of the same type; the text remains in source order, and any other event forms an ordering barrier. Each append carries both the new delta and the cumulative text for the current block. The finalized block shows up on `message.completed` and `reasoning.completed`, which is the compatibility path for clients that don't render incremental streaming.

Note: consider the privacy, confidentiality, and user-experience implications for displaying, storing, or transmitting reasoning events in your application.

`message.completed` can fire more than once in a turn: the agent often emits interim assistant text before a tool call. To tell tool-call narration from a terminal reply, check `message.completed.data.finishReason`. `step.completed.data.finishReason` mirrors the step outcome, and usage lives on `step.completed`.

A delegated subagent publishes progress on its own child-session stream. The parent only emits `subagent.called` with a `childSessionId`, which a client uses to attach.

`step.failed` and `turn.failed` carry `{ code, message, details? }` for the failed fragment or turn, and `session.failed` is the terminal session-level variant. `turn.cancelled` is not a failure: the cancelled turn ends without any failure event, `session.waiting` follows, and the session accepts the next message normally — whatever the turn streamed before cancellation stays on the stream, while durable history keeps only what had already settled. When a turn requested an output schema, the finalized payload lands on `result.completed` as `data.result` before the turn boundary. `authorization.required` carries the sign-in challenge (`data.authorization` may include `url`, `userCode`, `expiresAt`, `instructions`), and `authorization.completed` carries `data.outcome` (`"authorized" | "declined" | "failed" | "timed-out"`).

## Send a follow-up message

Once the session is waiting (you'll see `session.waiting`), POST your follow-up to the session endpoint with `event.data.continuationToken`:

```bash
curl -X POST http://127.0.0.1:3000/eve/v1/session/<sessionId> \
  -H 'content-type: application/json' \
  -d '{"continuationToken":"<token>","message":"Now send the short version."}'
```

The follow-up reuses the same durable session: same history, same state.

If the session is waiting on a human-in-the-loop approval, a matching text reply such as `approve` or `deny` answers the approval. Other follow-up text is held until the approval is answered, so an unrelated message does not implicitly deny the pending tool call.

For deterministic ordering, send one follow-up at a time and wait for the next `session.waiting` event before sending another message to the same session. See [message delivery and queueing](./execution-model-and-durability#message-delivery-and-queueing) for the current runtime contract.

## Reconnect and rewind

The stream is durable. Every event is recorded before a step completes, so the whole stream is replayable. A nonnegative `startIndex` is an absolute event count: use it to pick up where you dropped off or pass `0` to rewind to the start.

```bash
curl "http://127.0.0.1:3000/eve/v1/session/<sessionId>/stream?startIndex=<count>"
```

A negative `startIndex` reads relative to the stream's current tail. For example, `-1` reads the latest event, which is normally `session.waiting` for a resumable session:

```bash
curl "http://127.0.0.1:3000/eve/v1/session/<sessionId>/stream?startIndex=-1"
```

This gives a consumer that only persisted `sessionId` a lightweight way to recover the current `continuationToken`. Because a tail-relative position does not resolve to an absolute consumed-event count, client tail reads do not automatically reconnect or advance the stored cursor.

## Use the client from TypeScript

For scripts, server-to-server calls, tests, evals, and custom UIs, `eve/client` wraps these routes in a typed client so you don't hand-roll the POST and NDJSON stream loop.

Start with the [TypeScript SDK](../guides/client/overview) guide. It covers basic usage, sending messages, continuations, streaming, and per-turn `outputSchema` results.

## Inspect the agent over HTTP

`GET /eve/v1/info` returns a JSON inspection snapshot for the running agent: model, instructions, authored and framework tools, skills, channels, schedules, subagents, sandbox, connections, hooks, workflow, and workspace metadata. It uses the resolved `eveChannel()` route auth when `agent/channels/eve.ts` authors one; otherwise it falls back to the framework default of Vercel OIDC plus local development access.

```bash
curl http://127.0.0.1:3000/eve/v1/info
```

With the default auth chain (`[vercelOidc(), localDev()]`), a local Vercel OIDC bearer takes precedence and other local requests fall back to development access. A deployed Vercel target requires a valid OIDC bearer, with a same-project bypass for in-deployment callers. See [auth & route protection](../guides/auth-and-route-protection).

## Dispatch order

Every stream event runs four steps, in this order:

1. **Channel handler**: the channel's event handler runs and can mutate adapter state.
2. **Metadata projection**: the framework re-evaluates the channel's `metadata(state)` and stores the result.
3. **Hooks**: authored [hooks](../guides/hooks) subscribed to the event fire.
4. **Dynamic resolvers**: [dynamic](../guides/dynamic-capabilities) tool, skill, and instruction resolvers fire, and `ctx.channel.metadata` already holds the freshly projected metadata from step 2.

The order is structural, not incidental. By the time a resolver or hook reads channel metadata, the channel has already updated its state and the projection is current.

## What to read next

- [Execution model & durability](./execution-model-and-durability): what makes a session durable and how parked work resumes.
- [Channels](../channels/overview): what owns the continuation token and delivery.
- [TypeScript SDK](../guides/client/overview): call these routes from scripts and server-side code.
- [Frontend](../guides/frontend/overview): `useEveAgent` instead of raw routes.
