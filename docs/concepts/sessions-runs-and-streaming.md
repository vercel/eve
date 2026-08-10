---
title: "Sessions, Runs & Streaming"
description: "The ID-addressed session contract: messages, controls, the NDJSON event stream, and reconnecting."
---

Every eve app speaks the same stable HTTP API to a [durable session](./execution-model-and-durability). This page is the contract you hold: the handles you get back, the events you stream, and how to reconnect.

## Identity by surface

The HTTP API and TypeScript client use one durable `sessionId` for messages,
controls, and streams. Every operation targets that exact session; none follows
or creates a replacement implicitly.

Authored channels also have channel-local continuation tokens. A token addresses
whichever session currently owns a platform conversation, such as a Slack thread.
That identity stays behind the channel boundary and is never accepted or returned
by the eve HTTP session API. See [Custom channels](../channels/custom#address-and-session-handles).

Sessions last 30 days by default; configure `limits.sessionTimeoutMs` in
`agent.ts`, or set it to `false` to disable the deadline. At expiration, eve
lets an active turn settle, emits `session.completed`, and releases the
continuation so the next qualifying channel message starts fresh. Stored
session data is not deleted. See [Agent config](../agent-config#runtime-limits).

React, Vue, and Svelte apps reach for [`useEveAgent()`](../guides/frontend/overview) instead of calling these routes by hand. Next.js and Nuxt apps can proxy them to the eve runtime from the same origin.

## Start a session

```bash
curl -X POST http://127.0.0.1:2000/eve/v1/session \
  -H 'content-type: application/json' \
  -d '{"message":"Summarize the latest forecast."}'
```

eve responds right away with the durable `sessionId` in the JSON body and
`x-eve-session-id` header.

## Stream a session

```bash
curl http://127.0.0.1:2000/eve/v1/session/<sessionId>/stream
```

The stream is newline-delimited JSON (NDJSON), one event per line:

| Event                     | Meaning                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `session.started`         | A durable session was created.                                                                                   |
| `turn.started`            | A new turn began.                                                                                                |
| `message.received`        | An inbound user message was accepted; carries flattened text plus structured text/file parts.                    |
| `step.started`            | A model step began.                                                                                              |
| `actions.requested`       | The model requested one or more actions, including tool calls; calls stream before execution.                    |
| `action.partial`          | A locally executed tool generator yielded a preliminary output snapshot.                                         |
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
| `session.waiting`         | The session parked and is ready for the next message.                                                            |
| `session.failed`          | The session failed.                                                                                              |
| `session.completed`       | The session reached a terminal end.                                                                              |

`reasoning.appended` and `message.appended` stream incremental output as it arrives. When the durable stream writer is busy, eve may coalesce adjacent deltas of the same type; the text remains in source order, and any other event forms an ordering barrier. Each append carries both the new delta and the cumulative text for the current block. The finalized block shows up on `message.completed` and `reasoning.completed`, which is the compatibility path for clients that don't render incremental streaming.

`action.partial` carries one complete preliminary output snapshot from an authored async-generator tool. A later partial for the same `callId` replaces it, and `action.result` is the final snapshot. When the durable writer is busy, eve may keep only the newest adjacent partial for a call. Treat partials as last-write-wins: a durable step can retry and replay overlapping event runs. Provider-executed tool progress and MCP progress notifications are not projected as `action.partial` events.

Note: consider the privacy, confidentiality, and user-experience implications for displaying, storing, or transmitting reasoning events in your application.

`message.completed` can fire more than once in a turn: the agent often emits interim assistant text before a tool call. To tell tool-call narration from a terminal reply, check `message.completed.data.finishReason`. `step.completed.data.finishReason` mirrors the step outcome, and usage lives on `step.completed`.

A delegated subagent publishes progress on its own child-session stream. The parent only emits `subagent.called` with a `childSessionId`, which a client uses to attach.

`step.failed` and `turn.failed` carry `{ code, message, details? }` for the failed fragment or turn, and `session.failed` is the terminal session-level variant. `turn.cancelled` is not a failure: the cancelled turn ends without any failure event, `session.waiting` follows, and the session accepts the next message normally — whatever the turn streamed before cancellation stays on the stream, while durable history keeps only what had already settled. When a turn requested an output schema, the finalized payload lands on `result.completed` as `data.result` before the turn boundary. `authorization.required` carries the sign-in challenge (`data.authorization` may include `url`, `userCode`, `expiresAt`, `instructions`), and `authorization.completed` carries `data.outcome` (`"authorized" | "declined" | "failed" | "timed-out"`).

## The event envelope

Alongside `type` and `data`, every event carries a `meta` envelope:

```json
{
  "type": "message.completed",
  "data": {
    "message": "Sunny and 72°F.",
    "finishReason": "stop",
    "sequence": 0,
    "stepIndex": 0,
    "turnId": "turn_0"
  },
  "meta": { "id": "evt_01KYJBZA88B4M9XN3RTC5FDGHJ", "at": "2026-07-27T18:04:11.912Z" }
}
```

- **`meta.id`** uniquely identifies the event. It is an `evt_`-prefixed [ULID](https://github.com/ulid/spec): a millisecond timestamp followed by random bits, so ids are broadly time-ordered.
- **`meta.at`** is the ISO-8601 time the event was emitted.

`meta.id` is stable. eve mints it once, when the event is written to the durable stream, and stores it with the event. Reconnecting from a cursor, rewinding to `startIndex=0`, or replaying a finished session all return the same id for the same event.

`meta.at` has always been there; `meta.id` arrived in stream version 20. Events written by an earlier version are stored with the envelope but no id inside it, so rewinding into the part of a session that ran before you upgraded yields events whose `meta.id` is absent, even though the type says it is always a string. eve passes those events through rather than dropping them, and they cannot be deduplicated. The exposure ends when the sessions that predate your upgrade do.

That makes it the key for ingesting a stream into a database without duplicating rows when you re-read it:

```sql
insert into agent_events (id, session_id, type, data, emitted_at)
values ($1, $2, $3, $4, $5)
on conflict (id) do nothing;
```

Because ids lead with a timestamp, a `primary key (id)` stays roughly append-ordered and keeps inserts clustered.

**What the id covers.** Reconnecting is not the only way the same event reaches you twice. Keying on `meta.id` is what makes ingestion correct in all of these:

- Reconnecting mid-turn and overlapping events you already handled.
- Rewinding with `startIndex=0`, or reading back from the tail with a negative `startIndex`.
- Restoring a saved event log that overlaps the prefix the live stream replays.

**What it does not cover: a retried step re-emits under new ids.** eve runs each durable step up to four times. If a step is interrupted partway — a crash, a timeout, a model error it retries through — whatever it already wrote stays on the stream, and the new attempt emits its own events with their own ids. Both attempts carry the same `turnId`, `stepIndex`, and `sequence`, because the retry restores that state from the step's input, but they are distinct events and no field records which attempt finished.

Replaying a _completed_ step is a different thing and emits nothing at all: eve serves the recorded result from its journal without re-running the body. Crash recovery, redeploys, and resuming a parked turn therefore add nothing to the stream. Only an interrupted step re-runs.

Three more things to know:

- **Ids are time-ordered, not a total order.** The turn steps of one session can run in different processes, each generating ids from its own clock and its own random bits. Two events emitted in the same millisecond by different steps may sort either way, and clock skew between machines can invert neighbours. Record your own ingestion sequence, or read the stream in order and store the index, when you need an exact ordering to page against — do not use `where id > $cursor` as a lossless cursor. The stream itself is authoritative: `startIndex` is an absolute event count.
- **Ids identify events, not intent.** Two events with identical payloads — the `step.failed` → `turn.failed` → `session.failed` cascade, or two identical text deltas in one step — are distinct events with distinct ids. Deduplicate on `meta.id` only; matching on content would drop real data.
- **A subagent's event is re-emitted, not shared.** When a parent forwards a child's event onto its own stream, the parent's copy is a separate event with its own id. Correlate the two streams through `subagent.called.data.childSessionId`.

Authored [hooks](../guides/hooks) receive the same envelope, but observe each event as it is emitted rather than as it is read — so a hook sees a retry as new events, and `meta.id` is a key for a stored row rather than a retry guard. Two things a hook does not have to defend against: a turn that parks for human input resumes without re-emitting anything it already sent, and a retried turn dispatch cannot double-stream a turn, because only one turn run can claim a session's turn inbox.

## Send a follow-up message

Once the session is waiting (you'll see `session.waiting`), POST your follow-up to its ID-addressed messages endpoint:

```bash
curl -X POST http://127.0.0.1:2000/eve/v1/session/<sessionId> \
  -H 'content-type: application/json' \
  -d '{"message":"Now send the short version."}'
```

The follow-up reuses the same durable session: same history, same state. Message sends default to cancellation-backed `"experimental-steer"`; if a turn is active, eve buffers the follow-up, cancels that turn, and starts the message under a new turn ID. Channels and TypeScript `Session.send(...)` calls can select `turnPolicy: "queue"` when active work should finish first. Structured `inputResponses` never steer.

If the session is waiting on a human-in-the-loop approval, a matching text reply such as `approve` or `cancel` answers the approval. Other follow-up text is held until the approval is answered, so an unrelated message does not implicitly deny the pending tool call.

If the session is waiting on `ask_question`, a follow-up message clears that pending request before the model continues. An exact option match or permitted freeform response answers the question; any other message marks the question unanswered and starts the follow-up turn.

A response is stale when its request is no longer pending: the question or approval was already answered, cleared by a follow-up message, or cancelled. eve delivers a stale response to the model as a new user message, and the model decides whether the old selection still matters. A stale approval never authorizes the earlier tool call; the model must request the action and approval again if they are still needed.

Responses match pending requests by request ID, so a response to an older request stays a plain user message even while a different question or approval is pending. Like any follow-up message, a stale response clears a pending question and is held while an approval is pending.

Multiple replacement messages retain their durable arrival order and may be folded into the same replacement turn when they arrive before cancellation settles. See [message delivery and steering](./execution-model-and-durability#message-delivery-and-steering) for the current runtime contract.

## Cancel the in-flight turn

POST to the session's cancel endpoint to stop the turn that is currently running. The body is optional; pass `turnId` (stamped on every turn-scoped stream event) to scope the cancel to the turn you observed:

```bash
curl -X POST http://127.0.0.1:2000/eve/v1/session/<sessionId>/cancel
# {"ok":true,"sessionId":"<sessionId>","status":"accepted"}
```

`"accepted"` means the live session durably queued the request. Confirm an actual cancellation on the stream as `turn.cancelled` followed by `session.waiting`; the session then accepts the next message normally. If the turn is waiting on active local or remote subagents, eve also requests cancellation of every adopted child, recursively, before settling the parent. Each child reports its own cancellation boundary on its child-session stream; the parent does not emit `subagent.completed` for cancelled work. A live but already-parked session also returns `"accepted"` and consumes the command as a no-op. `"no_active_turn"` means the session or channel address is unknown or terminal. Both statuses are success, so clients can fire and forget. See the [eve channel](../channels/eve) for the full route contract.

The HTTP route returns `202` for `"accepted"` and `200` for
`"no_active_turn"`. Only the accepted result includes `sessionId`.

Custom channel routes request the same cancellation through
`from(address).cancel()` or `attachSession(sessionId).cancel()`. See
[custom channels](../channels/custom#channel-operations-and-session-handles).

## Compact, clear, and reset

All session controls are ID-addressed and accept no continuation token:

```bash
curl -X POST http://127.0.0.1:2000/eve/v1/session/<sessionId>/compact
curl -X POST http://127.0.0.1:2000/eve/v1/session/<sessionId>/clear
curl -X POST http://127.0.0.1:2000/eve/v1/session/<sessionId>/reset \
  -H 'content-type: application/json' \
  -d '{"reason":"Start over"}'
```

Compaction summarizes context, clear removes model-message history in place,
and reset terminally retires the session. A reset ID never becomes a new session;
create another session explicitly for a fresh conversation.

## Reconnect and rewind

The stream is durable. Every event is recorded before a step completes, so consumers can reconnect from their cursor when an HTTP connection ends. A nonnegative `startIndex` is an absolute event count: use it to pick up where you dropped off or pass `0` to rewind to the start.

If a reconnect overlaps events you already handled, [`meta.id`](#the-event-envelope) identifies the duplicates: it is unchanged across reconnects and rewinds, so a consumer keyed on it can replay safely.

```bash
curl "http://127.0.0.1:2000/eve/v1/session/<sessionId>/stream?startIndex=<count>"
```

A negative `startIndex` reads relative to the stream's current tail. For example, `-1` reads the latest event, which is normally `session.waiting` for a resumable session:

```bash
curl "http://127.0.0.1:2000/eve/v1/session/<sessionId>/stream?startIndex=-1"
```

Because a tail-relative position does not resolve to an absolute consumed-event
count, client tail reads do not automatically reconnect or advance the stored
cursor.

For a catch-up read that stops instead of following the live stream, pass `includeTailIndex=1`. The response then carries the `x-eve-stream-tail-index` header: the zero-based index of the last durably recorded event, or `-1` before the first. Read from your cursor until it passes that tail, then disconnect — reconnecting from the updated cursor if the connection drops first:

```bash
curl -i "http://127.0.0.1:2000/eve/v1/session/<sessionId>/stream?startIndex=<count>&includeTailIndex=1"
# x-eve-stream-tail-index: <tail>
```

The lookup is opt-in; requests without the parameter get no header. The TypeScript client wraps this into `stream({ follow: false })`.

## Use the client from TypeScript

For scripts, server-to-server calls, tests, evals, and custom UIs, `eve/client` wraps these routes in a typed client so you don't hand-roll the POST and NDJSON stream loop.

Start with the [TypeScript SDK](../guides/client/overview) guide. It covers basic usage, sending messages, session state, streaming, and per-turn `outputSchema` results.

## Inspect the agent over HTTP

`GET /eve/v1/info` returns a JSON inspection snapshot for the running agent: model, instructions, authored and framework tools, skills, channels, schedules, subagents, sandbox, connections, hooks, workflow, and workspace metadata. It uses the resolved `eveChannel()` route auth when `agent/channels/eve.ts` authors one; otherwise it falls back to the framework default of Vercel OIDC plus local development access.

```bash
curl http://127.0.0.1:2000/eve/v1/info
```

With the default auth chain (`[vercelOidc(), localDev(), placeholderAuth()]`), a Vercel OIDC bearer takes precedence, an `eve dev` or `vercel dev` server authenticates local requests, and everything else is rejected. A deployed Vercel target requires a valid OIDC bearer, with a same-project bypass for in-deployment callers. See [auth & route protection](../guides/auth-and-route-protection).

## Dispatch order

Every stream event runs four steps, in this order:

1. **Channel handler**: the channel's event handler runs and can mutate adapter state.
2. **Metadata projection**: the framework re-evaluates the channel's `metadata(state)` and stores the result.
3. **Hooks**: authored [hooks](../guides/hooks) subscribed to the event fire.
4. **Dynamic resolvers**: [dynamic](../guides/dynamic-capabilities) tool, skill, and instruction resolvers fire, and `ctx.channel.metadata` already holds the freshly projected metadata from step 2.

The order is structural, not incidental. By the time a resolver or hook reads channel metadata, the channel has already updated its state and the projection is current.

## What to read next

- [Execution model & durability](./execution-model-and-durability): what makes a session durable and how parked work resumes.
- [Channels](../channels/overview): how platform addresses map to durable sessions.
- [TypeScript SDK](../guides/client/overview): call these routes from scripts and server-side code.
- [Frontend](../guides/frontend/overview): `useEveAgent` instead of raw routes.
