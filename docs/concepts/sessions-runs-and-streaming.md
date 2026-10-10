---
title: "Sessions, Runs & Streaming"
description: "The ID-addressed session contract: messages, controls, the NDJSON event stream, and reconnecting."
---

Every eve app speaks the same stable HTTP API to a [durable session](./execution-model-and-durability). This page is the contract you hold: the handles you get back, the events you stream, and how to reconnect.

## Identity by surface

The HTTP API and TypeScript client use one durable `sessionId` for messages,
controls, and streams. Every operation targets that exact session; none follows
or creates a replacement implicitly.

The session ID currently identifies the original Workflow run that owns the
event stream. A deployment or compaction handoff changes the executing run, not
the session ID or stream. Stream namespaces belong to a run; eve does not support
caller-assigned session IDs or globally addressed streams.

Authored channels also have channel-local continuation tokens. A token addresses
whichever session currently owns a platform conversation, such as a Slack thread.
That identity stays behind the channel boundary and is never accepted or returned
by the eve HTTP session API. See [Custom channels](../channels/custom#channel-operations-and-session-handles).

Sessions last 30 days by default; configure `limits.sessionTimeoutMs` in
`agent.ts`, or set it to `false` to disable the deadline. A successful deployment
handoff or legacy-session import restarts the original configured duration.
Ordinary messages, compaction handoffs, and process restarts keep the existing deadline. At expiration, eve
lets an active turn settle, emits `session.ended` with `outcome: "completed"`, and releases the
session's continuation addresses so the next qualifying channel message starts fresh. Stored
session data is not deleted. See [Agent config](../agent-config#runtime-limits).

React, Vue, and Svelte apps reach for [`useEveAgent()`](../guides/frontend/overview) instead of calling these routes by hand. Next.js and Nuxt apps can proxy them to the eve runtime from the same origin.

## Start a session

Create and park a conversation session before its first turn by omitting `message`:

```bash
curl -X POST http://127.0.0.1:2000/eve/v1/session
```

eve starts the durable workflow, establishes its inbox, and waits for the first message before
running session-scoped initialization or emitting `session.started`. The first message sent to the returned
`sessionId` remains `turn_0`. Message-free creation does not accept turn-scoped `clientContext`,
`outputSchema`, callbacks, or activity observers.

To create the session and start its first turn in one request, include the message:

```bash
curl -X POST http://127.0.0.1:2000/eve/v1/session \
  -H 'content-type: application/json' \
  -d '{"message":"Summarize the latest forecast."}'
```

In both forms, eve responds with `202` and the durable `sessionId` in the JSON body and
`x-eve-session-id` header as soon as Workflow accepts the run. The command inbox can still be
starting at that point. An immediate follow-up can return `409 session_not_ready`; retry that
code with bounded backoff. The TypeScript client retries sends for up to 20 seconds and respects
the caller's abort signal. A prewarmed session's stream stays empty until its first message:
initialization and `session.started` wait for it, and commit in the same line as that message's
`delivery.admitted`.

## Stream a session

```bash
curl http://127.0.0.1:2000/eve/v1/session/<sessionId>/stream
```

The stream is newline-delimited JSON (NDJSON), stream version 27 (`x-eve-stream-version: 27`). Each stored line is either a **commit** or a **progress record**:

```json
{"at":"2026-07-27T18:04:11.912Z","facts":[{"type":"turn.settled","scope":{"turnId":"turn_0"},"data":{"turnId":"turn_0","outcome":"completed","reply":["part_0"]}},{"type":"delivery.settled","data":{"deliveryId":"d_1","outcome":"handled","turnId":"turn_0"}}]}
{"progress":{"type":"content.delta","scope":{"turnId":"turn_1","runId":"run_2"},"data":{"partId":"part_3","delta":"Sunny"}}}
```

- A **commit** (`{at, facts}`) holds every fact one state change produced, in order. Readers never see half of a commit: a turn that ends, the deliveries it answered, and the work it closed land together.
- A **progress record** (`{progress}`) carries streamed output that no state depends on: text and reasoning deltas, streamed tool input, and preliminary tool output.

The stream route also sends transport records that are not session events: `{"$eve":"heartbeat"}` while the stream is quiet, `{"$eve":"stream.lease-ended"}` when a renewable read ends so the reader reconnects, and `{"$eve":"stream.ended"}` once the session has ended and its stream is closed.

### Facts

Facts are grouped into families. Each family has a lifecycle: one fact introduces an entity, others update it, and one terminal fact settles it with an outcome from a closed set. Every fact carries `type` and `data`, and most carry a `scope` naming the turn, run, task, or context change it belongs to.

| Family        | Facts                                                         | What it is                                                                                                                                                                                                                                                                                          |
| ------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session`     | `session.started`, `session.ended`                            | The session. `session.started` carries `runtime`, `parent` for a child session, `predecessor` when the session [replaced a stranded one](./execution-model-and-durability#what-a-replacement-session-receives), and `trace` when traced. `session.ended` has `outcome` `"completed"` or `"failed"`. |
| `delivery`    | `delivery.admitted`, `delivery.consumed`, `delivery.settled`  | One accepted message, answer, control, or callback. `delivery.consumed` carries the `parts` a turn received; `delivery.settled` reports what became of it.                                                                                                                                          |
| `turn`        | `turn.started`, `turn.paused`, `turn.resumed`, `turn.settled` | A turn. `turn.paused` lists what it `awaiting` (interactions, calls, or tasks). `turn.settled` has `outcome` `"completed"`, `"failed"`, or `"cancelled"` and, when completed, the `reply` part ids.                                                                                                 |
| `model`       | `model.requested`, `model.started`, `model.settled`           | One model run, owned by a turn or a context change. `model.started` names the `modelId`; `model.settled` carries `outcome` and `finishReason`.                                                                                                                                                      |
| `content`     | `content.completed`                                           | One finished part of model output: `kind` `"text"`, `"reasoning"`, `"result"`, or `"file"`, its `value`, and its `phase`: `"reply"` or `"narration"`.                                                                                                                                               |
| `call`        | `call.requested`, `call.started`, `call.settled`              | One tool, agent, or skill call. `call.requested` names its `capability` and `input`; `call.started` carries `taskId` when the call reaches a task and `clearedBy` when an approval or policy let it run; `call.settled` carries `outcome` and `output` or `error`.                                  |
| `task`        | `task.started`, `task.ended`                                  | Work that outlives the call that started it, such as an agent tool's child session. See [Task facts](#task-facts).                                                                                                                                                                                  |
| `interaction` | `interaction.opened`, `interaction.settled`                   | A person's approval, question, budget prompt, or sign-in.                                                                                                                                                                                                                                           |
| `response`    | `response.submitted`, `response.admitted`, `response.settled` | One answer to an interaction, tied to the delivery it arrived in.                                                                                                                                                                                                                                   |
| `child`       | `child.opened`                                                | A child session a call or task opened; carries its `sessionId`, `name`, and the `stream` path to follow.                                                                                                                                                                                            |
| `context`     | `context.started`, `context.settled`                          | A context change: `kind` `"compaction"` or `"clear"`.                                                                                                                                                                                                                                               |
| `usage`       | `usage.recorded`                                              | Model spend, owned by the run, call, or context change that spent it.                                                                                                                                                                                                                               |

Progress records are `content.delta` (a text or reasoning delta for a `partId`), `call.input` (a raw tool-input delta for a `callId`), and `call.progress` (a preliminary output snapshot for a `callId`).

The full catalog, its outcome sets, and TypeScript types are exported from `eve/events`, along with the shared fold that turns facts into tables and selectors over them:

```ts
import { FACT_CATALOG, foldEvents, activeTurn, reply } from "eve/events";
```

Readers ignore fact and progress types they don't know, so a later minor version can add facts without breaking an older reader.

The optional `data.trace` on `session.started` and `turn.started` contains eve-owned W3C trace coordinates: `traceId`, `spanId`, and `traceFlags`. Use it to correlate stream consumers such as eval reporters with an observability backend. An uninstrumented target omits it.

### Streamed output

`content.delta` and `call.input` carry only their new text. Accumulate them in stream order, per `partId` or `callId`, when you need the text so far. When the durable writer is busy, eve may merge adjacent deltas for the same part or call; the resulting text and ordering stay the same. `content.completed` carries the authoritative value of each finished part, so a reader that reconnects without its accumulated text can wait for it instead of replaying the deltas.

When a streamed tool input becomes a validated call, its `call.input` records precede its `call.requested`. The default client reducer projects the potentially incomplete JSON as a `dynamic-tool` part with `state: "input-streaming"`, then replaces it with `state: "input-available"` and the validated `input` on `call.requested`.

`call.progress` carries one complete preliminary output snapshot from an authored async-generator tool. A later snapshot for the same `callId` replaces it, and `call.settled` carries the final output. Treat snapshots as last-write-wins. Provider-executed tool progress and MCP progress notifications are not projected as `call.progress`.

A call the model makes through [`eve__tool` or `eve__skill`](/docs/concepts/built-in-tools#eve__search-eve__tool-and-eve__skill) is reported as a call to the entry it names. Its `call.requested` carries that entry's name and input, such as `linear__list_issues`, never the catalog tool's. An `eve__skill` call has `capability: { kind: "skill", name }`. Calls through either tool publish no `call.input`, because their entry is known only once their input is complete.

Note: consider the privacy, confidentiality, and user-experience implications for displaying, storing, or transmitting reasoning content in your application.

### Replies and narration

A model often writes text before it calls a tool. Each text part's `content.completed.data.phase` tells you which it is: `"narration"` for text written on the way to more work, `"reply"` for the turn's answer. `turn.settled.data.reply` lists the reply's part ids, so a reader that only needs the answer can wait for the turn to settle and read those parts. When a turn requested an output schema, the structured result is a `content.completed` with `kind: "result"`.

Spend is recorded on `usage.recorded`, once per model run (`owner: { runId }`), once per delegated call for what the agent it called spent (`owner: { callId }`), and once per compaction (`owner: { changeId }`). A session's total is the sum of its records; `usage(view)` from `eve/events` computes it. Spend a task reports after its calls settled is recorded with the task's scope and `kind: "delegated-late"`.

### Deliveries and responses

Everything that reaches a session arrives as a delivery: a message, an answer, a control such as `cancel` or `reset`, or a sign-in callback. `delivery.admitted` records it, with the sender's `principal` and its `source`. A message that a turn takes in is `delivery.consumed`, with the `parts` it received: text, plus file metadata without raw bytes or internal sandbox paths. Every delivery ends with exactly one `delivery.settled`:

| Outcome          | Meaning                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `handled`        | The turn that consumed it settled.                                                            |
| `awaiting-input` | The turn paused on a person. The delivery's answer is the pause; the answer resumes the turn. |
| `applied`        | A control or answer took effect.                                                              |
| `ignored`        | It had nothing to act on, such as a cancel with no active turn.                               |
| `refused`        | Its sender may not do what it asked; `reason` says why.                                       |
| `failed`         | It couldn't be handled, such as when the session ended first.                                 |

`POST /eve/v1/session/:sessionId` returns the message's `deliveryId`, so a client resuming from an old cursor knows which `delivery.settled` ends its response. Steering and coalesced messages each keep their own delivery.

### Turns and people

A turn doesn't end while it waits on a person or on its tasks; it pauses. `turn.paused.data.awaiting` names what it waits on: `{ interactionId }` for a person, or `{ callId }` for task calls still working. `turn.resumed` comes before its next model run, and only `turn.settled` ends it.

A question or sign-in from inside a running call does not end the turn either. This covers a workflow tool's `ctx.ask()`, including the built-in `ask_question` tool, and a delegated subagent's question or sign-in. The stream emits `interaction.opened`, then `turn.paused` awaiting it, committed with `delivery.settled` (`awaiting-input`) for the deliveries the turn was answering. An answer arrives as a new delivery with a `response.submitted` for each answer it carries, and `interaction.settled` once the interaction is decided. A request relayed from a subagent or a workflow tool run carries `origin` naming the session and request that asked, and `origin.call` naming the asker's call. A subagent's tool approval stays open until the subagent settles it, and the session relays that settlement.

A sign-in or tool approval the turn raises itself pauses it the same way. A message from the same person steers the turn and withdraws the request: an unanswered approval settles `withdrawn` and its call settles `rejected`, and a sign-in settles `withdrawn`. Messages from other people wait until the turn ends. Cancelling the turn interrupts both: a held approval or sign-in settles `interrupted`.

Each answer's `response.settled` reports what became of it: `applied` when it decided its interaction, `refused` when a response policy rejected it, `withdrawn` or `abandoned` when the interaction settled another way, and `expired` or `failed` otherwise.

### Task facts

A call to a tool that runs as a task, such as an agent tool, `agentRouter()`, the `workflow` tool, or a workflow tool that defines [`task(input, ctx)`](/docs/tools/workflows#run-calls-as-tasks-task) or [`serve(receive, ctx)`](/docs/tools/workflows#resumable-tasks-serve), keeps working after the model gets a receipt. `task.started` reports the task once, with its `taskId`, `name`, `kind` (`"agent"` for an agent tool, `"tool"` otherwise), and the call that started it. Each call the task serves, including later calls that reach a resumable task by its `taskId`, publishes `call.started` with that `taskId` and settles with `call.settled` on its own reply. Calls that share one reply reference the first call's output with `outputOf`. `task.ended` comes when the task's run ends, with `outcome` `"completed"`, `"failed"`, or `"cancelled"`. Results reach the model as a message in its history, so read outcomes from `call.settled`.

A session the task's run opens with `ctx.agent` is announced with `child.opened`, owned by the task. An agent tool's child session is owned by its call. A settled call does not end the child session; later calls with the same `taskId` reach it.

A turn doesn't end while its tasks are working. When the model ends its text early, or calls `eve__task_wait` before a result is ready, eve pauses the turn awaiting the working calls; the turn resumes once a result arrives or its caller writes. The text the model wrote before the pause is narration. See [Tasks](/docs/tools/tasks#turns-wait-for-their-tasks).

### Failures and cancellation

A failed model run, turn, or session carries `error: { code, message, id?, hint? }`: `id` is a support id that eve's server logs carry too, and `hint` a remedy when eve recognizes the failure on its `model.settled`, `turn.settled`, or `session.ended`. A turn that ends closes everything it left open in the same commit: running calls settle `interrupted`, open interactions settle `interrupted`, and their pending answers settle `withdrawn`. A task can outlive its turn and stays open.

A cancelled turn is not a failure: it settles with `outcome: "cancelled"` and `cause` naming the cancel delivery, and the session accepts the next message normally. Whatever the turn streamed before cancellation stays on the stream. Durable history keeps the accepted user input and previously settled work, and discards incomplete assistant output. Tool calls the cancellation stopped stay in history, each answered as cancelled, so the model sees that the work started and stopped instead of a request left unanswered. When a model call is retried, the abandoned attempt's run settles `abandoned`, and its unfinished calls with it.

A provider response ending with `content-filter` fails its run and turn with `MODEL_CALL_FAILED`
and a `hint` to review the request against the provider's content policy. eve does not retry the
filtered response or complete its partial text; deltas already streamed remain visible. The session
then waits for another user message.

## Positions

A reader materializes each fact and progress record as an event with a `meta` envelope:

```json
{
  "type": "content.completed",
  "scope": { "runId": "run_0", "turnId": "turn_0" },
  "data": {
    "partId": "part_0",
    "runId": "run_0",
    "kind": "text",
    "phase": "reply",
    "value": "Sunny and 72°F."
  },
  "meta": { "position": { "line": 6, "index": 0 }, "at": "2026-07-27T18:04:11.912Z" }
}
```

- **`meta.position`** is where the event sits: the zero-based stored `line`, and its `index` within that line. A line, once written, never changes or moves, so a position identifies its event across reconnects, rewinds, and replays.
- **`meta.at`** is the time of the commit that holds the event, or, for a progress record, of the latest commit before it.
- **`meta.endOfLine`** is `false` while more events of the same line follow. Readers that stop on a fact finish its line first.

That makes `(sessionId, line, index)` the key for ingesting a stream without duplicating rows when you re-read it:

```sql
insert into agent_events (session_id, line, index, type, data, emitted_at)
values ($1, $2, $3, $4, $5, $6)
on conflict (session_id, line, index) do nothing;
```

Positions are also a total order within a session: sort by `line`, then `index`.

A subagent's events live on its own stream. When a parent relays a child's request, the parent's `interaction.opened` is its own fact at its own position; correlate the two through `child.opened.data.sessionId` and the relayed fact's `origin`.

Authored [hooks](../guides/hooks) and channels receive the same events, with their position as `ctx.position`, after the line is written.

## Send a follow-up message

Once the turn has settled, POST your follow-up to its ID-addressed messages endpoint:

```bash
curl -X POST http://127.0.0.1:2000/eve/v1/session/<sessionId> \
  -H 'content-type: application/json' \
  -d '{"message":"Now send the short version."}'
```

The follow-up reuses the same durable session: same history, same state. A follow-up accepts exactly one of `message` or `inputResponses`. Use structured responses to answer one or more pending human-input requests by ID:

```bash
curl -X POST http://127.0.0.1:2000/eve/v1/session/<sessionId> \
  -H 'content-type: application/json' \
  -d '{"inputResponses":[{"requestId":"req_A","optionId":"approve"}]}'
```

Message sends default to `"steer"`. Before assistant output begins, eve interrupts pending model generation and continues the same turn with the correction. Reasoning and provider search progress do not count as assistant output. An executing eve tool finishes safely, and its result is preserved before the correction reaches the next model call. A steering message aborts the [`ctx.abortSignal`](/docs/tools/workflows#stop-early-for-a-new-message) of each `execute` workflow tool call the turn is waiting on: its questions are withdrawn, `sleep` and `ask_question` stop early, and the call settles with what its body returns. A steering message ends an `eve__task_wait` but never interrupts a task. Only the turn's own caller steers it; another caller's message waits for the turn to end. After assistant output starts, steering applies at the next committed workflow boundary; text already streamed remains visible. Channels and TypeScript `Session.send(...)` calls can select `turnPolicy: "queue"` when the active turn should finish first. Structured `inputResponses` answer their addressed requests.

If the session is waiting on a human-in-the-loop approval, respond with the channel’s Approve or Cancel controls. Text that doesn't match an option doesn't approve the call. From the person the turn serves, it steers the turn and cancels the approval, even when sent with `turnPolicy: "queue"`, since the turn can't end until that person acts; from anyone else, it waits until the turn ends. If they had already approved some calls in the batch, those calls still run. Cancelling the turn withdraws the approval, and a later answer to it approves nothing.

A pending prompt, whether a `ctx.ask()` question from a tool such as `ask_question`, a tool approval, or a session-limit prompt, can be answered with plain text, including prompts proxied from a subagent. A message answers the first open prompt, as described in [Several requests at once](/docs/human-in-the-loop#several-requests-at-once): a reply that matches one of its options, such as `approve` or `continue`, answers it as if the sender had pressed that option, and so does any message when the prompt allows free text. Send one message per prompt to answer several. The stream records a message that answers a question as a delivery whose `response.submitted` answers it. A message that doesn't answer the first open prompt follows the normal `turnPolicy`. A steering message withdraws the questions of the `execute` workflow tool calls the turn waits on, which settle `withdrawn`; a task's questions stay open. Use structured responses to target requests unambiguously.

A structured response matches any currently pending request by ID, not only the newest batch. It becomes stale only after that request was answered, cleared, or cancelled. eve delivers a stale response to the model as a new user message, and the model decides whether the old selection still matters. A stale approval never authorizes the earlier tool call; the model must request the action and approval again if they are still needed.

One delivery can answer requests from several batches. eve resumes approval-bearing batches in durable order and carries later answers forward until each batch can resume. If you answer only some approvals in a batch, eve saves those responses until the remaining approvals are answered. Meanwhile, unrelated messages can run tools and receive a completed reply. The saved partial responses neither block that reply nor trigger another model call after it.

When steering interrupts pending model generation, the interrupted run settles `interrupted`, with any usage the provider reported. The correction's `delivery.consumed` and the next `model.requested` for the same `turnId` follow.

Multiple steering messages retain their durable arrival order and may be folded into one input at the next boundary. A message accepted after turn settlement starts the next turn. See [message delivery and steering](./execution-model-and-durability#message-delivery-and-steering).

## Cancel the in-flight turn

POST to the session's cancel endpoint to stop the turn that is currently running. The body is optional; pass `turnId` (in every turn-scoped fact's `scope`) to scope the cancel to the turn you observed:

```bash
curl -X POST http://127.0.0.1:2000/eve/v1/session/<sessionId>/cancel
# {"ok":true,"sessionId":"<sessionId>","status":"accepted"}
```

`"accepted"` means the live session durably queued the request; cancellation completes asynchronously. The cancel arrives as a control delivery; confirm it on the stream as `turn.settled` with `outcome: "cancelled"` and `cause` naming that delivery. The session then accepts the next message normally. Each cancelled child reports its own boundary on its child-session stream. Cancelling also stops every working task, each reported as `task.ended` with `outcome: "cancelled"`, including while the session waits between turns. A live but already-parked session returns `"accepted"`; with no working tasks, cancellation is a no-op there. `"no_active_turn"` means the session or channel address is unknown or terminal. Both statuses are success, so clients can fire and forget. See the [eve channel](../channels/eve) for the full route contract.

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

Compaction summarizes context without adding a user message. User-role instructions are ordinary history and may be represented by the summary; system-role instructions remain outside it. Attributed [memory](../memory) records are excluded from the summary, canonicalized, and recalled again after the checkpoint. If a turn is active, eve queues the request until that turn settles. A compaction is a context change: `context.started` and `context.settled` with `kind: "compaction"`, around the summary's model run. If summarization fails before a checkpoint, the change settles `failed` and the session keeps its previous history.

Clear removes model-message history in place, including static and dynamic user-role instructions and recalled memory records, while preserving the session identity, system-role instructions, tools, skills, application-defined durable state, limits, and sandbox. It clears framework memory locks and replay bookkeeping but does not delete data from a provider's external store. It does not rerun instruction definitions or resolvers. Approvals, the session-limit prompt, and sign-ins the cleared history asked for are withdrawn: each settles its interaction. Requests relayed from tasks that keep running stay answerable. The clear is a context change with `kind: "clear"`.

Reset terminally retires the exact session ID. A reset ID never becomes a new session; create another session explicitly for a fresh conversation. Compact, clear, and reset return `"no_active_session"` when the target is already inactive.

A [stranded session](./execution-model-and-durability#stranded-sessions) cannot run commands. Reset still works: eve cancels the stranded workflow run and returns `"reset"`. Clear is refused with `409 session_stranded` (`SessionStrandedError` from a `Session` handle), because it would keep a session that cannot run. Compact returns `"no_active_session"` and cancel returns `"no_active_turn"`.

## Reconnect and rewind

The stream is durable. Every line is recorded before a step completes, so consumers can reconnect from their cursor when an HTTP connection ends. A nonnegative `startIndex` is a line position: the next line to read. Pass the last line you read plus one to pick up where you dropped off, or `0` to rewind to the start.

The stream route serves renewable leases over that durable stream. It sends heartbeats during quiet periods, then ends the response with `{"$eve":"stream.lease-ended"}` so the client reconnects from its current cursor. This bounds server-side stream readers even when a host does not report that the client disconnected. A finished session's stream ends with `{"$eve":"stream.ended"}`, so readers stop instead of reconnecting. Leases and heartbeats are transport details: they do not stop the run or appear as session events.

If a reconnect overlaps events you already handled, [`meta.position`](#positions) identifies the duplicates.

```bash
curl "http://127.0.0.1:2000/eve/v1/session/<sessionId>/stream?startIndex=<line>"
```

A negative `startIndex` reads relative to the stream's current tail. For example, `-1` reads the latest line:

```bash
curl "http://127.0.0.1:2000/eve/v1/session/<sessionId>/stream?startIndex=-1"
```

For a catch-up read that stops instead of following the live stream, pass `includeTailIndex=1`. The response then carries the `x-eve-stream-tail-index` header: the zero-based position of the last durably recorded line, or `-1` before the first, and the response ends after that line:

```bash
curl -i "http://127.0.0.1:2000/eve/v1/session/<sessionId>/stream?startIndex=<line>&includeTailIndex=1"
# x-eve-stream-tail-index: <tail>
```

The lookup is opt-in; requests without the parameter get no header. Passing `follow=false` instead bounds the response at the durable tail on the server and implies the header. A bounded read only reads recorded history, so it also works for a [stranded session](./execution-model-and-durability#stranded-sessions), whose live stream returns `409 session_stranded`. The TypeScript client wraps this into `stream({ follow: false })`.

## Use the client from TypeScript

For scripts, server-to-server calls, tests, evals, and custom UIs, `eve/client` wraps these routes in a typed client so you don't hand-roll the POST and NDJSON stream loop.

Start with the [Client SDK](../guides/client/overview) guide. It covers basic usage, sending messages, session state, streaming, and per-turn `outputSchema` results.

## Read a session in process

Code running inside the agent's own deployment, such as a hook, tool, schedule, or channel route, can read a session's durable stream without calling its own HTTP route. `eve/server` exposes the same `attach(sessionId).stream(...)` shape as the client, so it needs no deployment URL, credentials, or stream protocol:

```ts
import { sessions } from "eve/server";

const events = sessions.attach(sessionId).stream({ startIndex, follow: false });

for await (const event of events) {
  await saveEvent(sessionId, event.meta.position, event);
}
```

`stream()` accepts `startIndex` (negative values count back from the tail), `follow`, and `signal`. Key stored events on [`meta.position`](#positions), which stays stable across reads. With `follow: false`, the read ends at the durable tail observed when it opens; otherwise it keeps following new events until the stream closes or the signal aborts.

A read reflects events that are already durable. A hook runs after its line is written, so a bounded read there includes the event that triggered it. `sessions` reads any session ID without channel auth, so check that a caller may read a session before passing an ID from a request. It is available only in code that runs inside the eve server.

## Inspect the agent over HTTP

`GET /eve/v1/info` returns agent-info version 6, a JSON inspection snapshot of the effective compiled agent. It reports the selected config; active tools, instructions, memory slots, skills, channels, schedules, sandbox, connections, hooks, and instrumentation with explicit source ownership; dynamic resolvers separately from their session-specific output; local and remote agents in separate collections; prepared built-in effects; and shadowed or disabled source diagnostics. Memory tool wrappers include their selected memory-source dependency. Channel routes appear in the same effective order used by the HTTP host. Static instructions remain an ordered array whose entries expose `content` and `role`. Sandbox inspection exposes the opaque `revisionHash` that identifies its compiler-discovered environment inputs.

The info route belongs to the selected `channels/eve.ts` source and uses its resolved auth policy. Without an authored replacement, eve selects the default channel source with Vercel OIDC, local development access, and the production placeholder. Replacing or disabling that source replaces or removes the info route too; no native fallback serves it.

```bash
curl http://127.0.0.1:2000/eve/v1/info
```

With the default auth chain (`[vercelOidc(), localDev(), placeholderAuth()]`), a Vercel OIDC bearer takes precedence, `localDev()` accepts requests to an `eve dev` or `vercel dev` server, and everything else is rejected. A deployed Vercel target requires a valid OIDC bearer, with a same-project bypass for in-deployment callers. See [auth & route protection](../guides/auth-and-route-protection).

## Dispatch order

Every commit runs in this order:

1. **Write**: the line is written to the durable stream.
2. **Channel handler**: the channel's event handler runs for each fact and can update adapter state; the framework then re-evaluates the channel's `metadata(state)` and stores the result.
3. **Hooks**: authored [hooks](../guides/hooks) subscribed to each fact fire.
4. **Dynamic resolvers**: [dynamic](../guides/dynamic-capabilities) tool, skill, and instruction resolvers fire, and `ctx.channel.metadata` already holds the freshly projected metadata.

The order is structural, not incidental. Channels and hooks observe what was written; neither can change it. By the time a resolver or hook reads channel metadata, the channel has already updated its state and the projection is current.

## What to read next

- [Execution model & durability](./execution-model-and-durability): what makes a session durable and how parked work resumes.
- [Channels](../channels/overview): how platform addresses map to durable sessions.
- [Client SDK](../guides/client/overview): call these routes from scripts and server-side code.
- [Frontend](../guides/frontend/overview): `useEveAgent` instead of raw routes.
