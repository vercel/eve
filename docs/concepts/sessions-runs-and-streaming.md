---
title: "Sessions, Runs & Streaming"
description: "The ID-addressed session contract: messages, controls, the NDJSON event stream, and reconnecting."
---

Every eve app serves the same stable HTTP API for [sessions](./execution-model-and-durability). The API returns a session handle, streams the session's events, and lets a reader reconnect from a cursor.

## Identity by surface

The HTTP API and TypeScript client address a session by one `sessionId` for messages, controls, and streams. Every operation targets that exact session and never follows or creates a replacement implicitly.

The session ID and its event stream stay the same across a deployment or [compaction handoff](./execution-model-and-durability#compaction-handoff). eve doesn't support caller-assigned session IDs or globally addressed streams.

Authored channels also use channel-local continuation tokens. A token addresses whichever session currently holds a platform conversation, such as a Slack thread. The eve HTTP session API never accepts or returns these tokens. See [Custom channels](../channels/custom#channel-operations-and-session-handles).

A session completes after 30 idle days by default. Set `limits.sessionTimeoutMs` in `agent.ts` to change the window, or `false` to disable it. The idle window restarts each time a turn ends. A session never expires while a turn is open. At expiration, eve emits `session.ended` with `outcome: "completed"` and releases the session's channel addresses. The next qualifying channel message then starts a fresh session. Stored data follows the session's [run-data retention policy](../agent-config#run-data-retention). Outside development, the default policy requests deletion when private and unknown-audience sessions end, if the Workflow world supports deletion. See [Agent config](../agent-config#runtime-limits).

React, Vue, and Svelte apps use [`useEveAgent()`](../guides/frontend/overview) instead of calling these routes directly. Next.js and Nuxt apps can proxy them to the eve runtime from the same origin.

## Start a session

Omit `message` to create a prewarmed session that waits for its first message:

```bash
curl -X POST http://127.0.0.1:2000/eve/v1/session
```

The stream stays empty until the first message. Session setup and `session.started` are then recorded in the same line as that message's `delivery.admitted`, and the message is still `turn_0`. Creating a session without a message doesn't accept per-turn `clientContext`, `outputSchema`, callbacks, or activity observers.

Include `message` to create the session and start its first turn in one request:

```bash
curl -X POST http://127.0.0.1:2000/eve/v1/session \
  -H 'content-type: application/json' \
  -d '{"message":"Summarize the latest forecast."}'
```

Both forms return `202` with the `sessionId` in the JSON body and the `x-eve-session-id` header as soon as the run is accepted. The session may not accept input yet, so an immediate follow-up can return `409 session_not_ready`. Retry that code with bounded backoff. The TypeScript client retries sends for up to 20 seconds and respects the caller's abort signal.

## Stream a session

```bash
curl http://127.0.0.1:2000/eve/v1/session/<sessionId>/stream
```

The stream is newline-delimited JSON (NDJSON), stream version 27 (`x-eve-stream-version: 27`). Each stored line is either an **event line** or a **progress record**:

```json
{"at":"2026-07-27T18:04:11.912Z","facts":[{"type":"turn.settled","scope":{"turnId":"turn_0"},"data":{"turnId":"turn_0","outcome":"completed","reply":["part_0"]}},{"type":"delivery.settled","data":{"deliveryId":"d_1","outcome":"handled","turnId":"turn_0"}}]}
{"progress":{"type":"content.delta","scope":{"turnId":"turn_1","runId":"run_2"},"data":{"partId":"part_3","delta":"Sunny"}}}
```

- An **event line** (`{at, facts}`) holds, in its `facts` array, every event one state change produced, in order. Readers never see half of a line: a turn that ends, the deliveries it answered, and the work it closed land together.
- A **progress record** (`{progress}`) carries streamed output that no state depends on: text and reasoning deltas, streamed tool input, and preliminary tool output.

The stream route also sends transport records that aren't session events:

- `{"$eve":"heartbeat"}` while the stream is quiet.
- `{"$eve":"stream.lease-ended"}` when a renewable read ends. Reconnect from your cursor.
- `{"$eve":"stream.ended"}` once the session has ended and its stream is closed.

### Facts

Each entry in `facts` is an event, and events are grouped into families. Most events open, update, or end an item, such as a turn or a call. Informational events, such as `usage.recorded` and `child.sent`, add data without opening anything that must end. Every event carries `type` and `data`, and most carry a `scope` naming the turn, run, task, or context change it belongs to.

| Family        | Events                                                               | What it is                                                                                                                                                                                                                                                                                                        |
| ------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session`     | `session.started`, `session.ended`                                   | The session. `session.started` carries `runtime`, `parent` for a child session, `predecessor` when the session [replaced a stranded one](./execution-model-and-durability#what-a-replacement-session-receives), and `trace` when traced. `session.ended` has `outcome` `"completed"` or `"failed"`.               |
| `delivery`    | `delivery.admitted`, `delivery.consumed`, `delivery.settled`         | One accepted message, answer, control, or callback. `delivery.consumed` carries the `parts` a turn received, and any `history` the delivery imported; `delivery.settled` reports what became of it.                                                                                                               |
| `turn`        | `turn.started`, `turn.paused`, `turn.settled`                        | A turn. `turn.paused` lists the requests for input it's `awaiting`. `turn.settled` has `outcome` `"completed"`, `"failed"`, or `"cancelled"` and, when completed, the `reply` part ids.                                                                                                                           |
| `model`       | `model.requested`, `model.started`, `model.retried`, `model.settled` | One model run, for a turn or a context change. `model.started` names the `modelId` and `attempt` for each attempt. `model.retried` records a failed attempt that runs again. `model.settled` carries `outcome` and `finishReason`.                                                                                |
| `content`     | `content.completed`                                                  | One finished part of model output: `kind` `"text"`, `"reasoning"`, `"result"`, or `"file"`, its `value`, and its `phase`: `"reply"` or `"narration"`.                                                                                                                                                             |
| `call`        | `call.requested`, `call.started`, `call.settled`                     | One tool, agent, or skill call. `call.requested` names the tool, agent, or skill in `capability` (`remote: true` for a remote agent) and its `input`. `call.started` carries `taskId` for a task and `clearedBy` when an approval or policy let it run. `call.settled` carries `outcome` and `output` or `error`. |
| `task`        | `task.started`, `task.ended`                                         | Work that outlives the call that started it, such as an agent tool's child session. See [Task events](#task-facts).                                                                                                                                                                                               |
| `interaction` | `interaction.opened`, `interaction.settled`                          | A person's approval, question, budget prompt, or sign-in.                                                                                                                                                                                                                                                         |
| `response`    | `response.submitted`, `response.admitted`, `response.settled`        | One answer to a request for input, tied to the delivery it arrived in.                                                                                                                                                                                                                                            |
| `child`       | `child.opened`, `child.sent`                                         | A child session a call opened. `child.opened` carries its `sessionId`, `name`, and `stream` path. `child.sent` links a delivery the child accepted, as `childDeliveryId`, to the `callId` that sent it.                                                                                                           |
| `context`     | `context.started`, `context.settled`                                 | A context change: `kind` `"compaction"` or `"clear"`.                                                                                                                                                                                                                                                             |
| `usage`       | `usage.recorded`                                                     | Model spend, tied to the run, call, or context change that spent it.                                                                                                                                                                                                                                              |

Progress records come in three types:

- `content.delta`: a text or reasoning delta for a `partId`.
- `call.input`: a raw tool-input delta for a `callId`.
- `call.progress`: a preliminary output snapshot for a `callId`.

A call's label is `capability.label` before execution, `call.progress.data.label` in a progress snapshot, and `call.settled.data.label` at completion; `call(view, callId)?.label` reads the final one. A prompt's heading is `request.title`.

The conversation is a chain of turns. Each `turn.started` names the turn it `follows`, or `null` for a first turn. A completed `context.settled` can change the conversation with `selects`: `null` empties it, as a clear does, and `{ turnId }` makes that earlier turn the newest, leaving out the turns after it. The next turn then follows the selected turn. Because either can name any earlier turn, read the conversation with `conversation(view)` instead of assuming it holds every turn in order.

The full catalog, its outcome sets, and TypeScript types are exported from `eve/events`, along with the shared fold and queries over [opaque session snapshots](#query-session-state):

```ts
import { FACT_CATALOG, foldEvents, activeTurn, reply } from "eve/events";
```

The family-specific arrays `SESSION_OUTCOMES`, `DELIVERY_OUTCOMES`, `TURN_OUTCOMES`,
`MODEL_OUTCOMES`, `CALL_OUTCOMES`, `TASK_OUTCOMES`, `INTERACTION_OUTCOMES`,
`RESPONSE_OUTCOMES`, and `CONTEXT_OUTCOMES` list the outcomes known to this release.
`TERMINAL_OUTCOMES` maps terminal fact types to those arrays. `isTerminal(fact)`
narrows a fact to one that ends its entity; it does not test whether the whole
session has ended. These helpers come from `eve/events`.

#### What a later release can add

Within stream version 27, a later minor release can add:

- informational event types, such as a new family or a row update like `model.retried`;
- progress record types;
- optional fields;
- outcomes, interaction kinds, context-change kinds, displays, and option styles.

A new event type is never the only way an item opens or ends. A minor release never removes or renames an event type or field, and never adds a required field. It never changes what an event means or whether it opens, updates, or ends its item. Any other change is a new stream version, which readers refuse.

Readers ignore event types, progress types, and fields they don't know. An ending event with an unknown outcome still ends its row and keeps the outcome as sent. The TypeScript types name only current values, so keep a default branch when you switch on an outcome, kind, display, or style.

After a reconnect, `foldEvents` skips positions it has already seen. It ignores a repeated start or end of a row it holds, and an update can't reopen an ended row. It doesn't deduplicate progress and usage at new positions.

`session.started` and `turn.started` carry an optional `data.trace` with W3C trace coordinates: `traceId`, `spanId`, and `traceFlags`. Use them to correlate stream consumers, such as eval reporters, with an observability backend. An uninstrumented target omits it.

### Streamed output

`content.delta` and `call.input` carry only new text; accumulate them in stream order per `partId` or `callId`. eve may merge adjacent deltas for the same part or call without changing the text or its order. `content.completed` carries each finished part's final value. A reader that reconnects without its accumulated text can wait for it instead of replaying deltas.

A streamed tool input's `call.input` records precede its `call.requested`. The client shows the possibly incomplete JSON as a `tool` part with `state: "streaming"` and its `inputText`, then as `state: "requested"` with the validated `input`.

`call.progress` carries one complete preliminary output snapshot from an authored async-generator tool. Treat snapshots for a `callId` as last-write-wins; `call.settled` carries the final output. Provider-executed tool progress and MCP progress notifications don't appear as `call.progress`.

A call through [`eve__tool` or `eve__skill`](/docs/concepts/built-in-tools#eve__search-eve__tool-and-eve__skill) is reported as a call to the entry it names. Its `call.requested` carries that entry's name and input, such as `linear__list_issues`. An `eve__skill` call has `capability: { kind: "skill", name }`. The task controls `eve__task_wait` and `eve__task_cancel` have `kind: "control"`, and activity views usually leave them out. A `call.input` that announces a call carries the same `kind` beside its `name`. Calls through `eve__tool` or `eve__skill` publish no `call.input`, because eve knows the entry only once the input is complete.

Note: consider the privacy, confidentiality, and user-experience implications for displaying, storing, or transmitting reasoning content in your application.

### Replies and narration

Each text part's `content.completed.data.phase` is `"reply"` for the turn's answer. It's `"narration"` for text written on the way to more work, such as before a tool call. `turn.settled.data.reply` lists the reply's part ids, so a reader that needs only the answer can wait for the turn to end. In a hook or channel handler, `reply(ctx.view, turnId)` returns them. A turn that requested an output schema reports the structured result as a `content.completed` with `kind: "result"`.

`usage.recorded` records spend once per model run (`owner: { runId }`). It also records once per delegated call for what the called agent spent (`owner: { callId }`). A compaction summary run belongs to its context change. Its usage stays counted even when a hook cancels the turn as compaction finishes. Spend a task reports after its calls end has no `owner` and has `kind: "delegated-late"`. `usage(view).total` returns the sum of the session's records. `costUsd` is absent when no record reported a cost. The usage window that [`limits.sessionUsage`](../agent-config#runtime-limits) reads starts at that total on the line where the session's own budget prompt is accepted.

### Deliveries and responses

A delivery is anything that reaches a session: a message, an answer, a control such as `cancel` or `end`, or a sign-in callback. `delivery.admitted` records it with the sender in `principal` and its `source`. When a turn takes in a message, `delivery.consumed` carries the `parts` it received and any imported [prior history](../channels/eve#start-from-prior-history) in `history`. Parts hold text and file metadata, without raw bytes or sandbox paths. Every delivery ends with exactly one `delivery.settled`, except after a degraded termination (see below):

| Outcome          | Meaning                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------- |
| `handled`        | The turn that took it in ended.                                                         |
| `awaiting-input` | The turn paused for an approval, question, or sign-in. A later answer resumes the turn. |
| `applied`        | A control or answer took effect.                                                        |
| `ignored`        | It had nothing to act on, or a cancel or clear ended its turn before the turn read it.  |
| `refused`        | Its sender may not do what it asked; `reason` says why.                                 |
| `failed`         | It couldn't be handled, such as when the session ended first.                           |

`POST /eve/v1/session/:sessionId` returns the message's `deliveryId`. A client resuming from an old cursor uses it to find the `delivery.settled` that ends its response. Steering and coalesced messages each keep their own delivery. An answer-only delivery stops on its own `delivery.settled`.

Ending a stranded session records the end's `delivery.admitted` and `delivery.settled` before the session ends, with `session.ended.data.cause.deliveryId` naming that delivery. The recorded control is `source: { control: "reset" }`.

A control that the session's eve version doesn't support, such as one added in a later release, settles `failed` with a `reason` that names it. Sessions started by eve versions without this check drop the control, and its delivery never settles.

When someone other than the turn's caller sends an answer and a message together, they become separate deliveries. The answer reaches the waiting turn, and the message keeps the receipt and waits. Follow the answer through the request it answers.

To follow an accepted receipt in a client view, use `delivery(view, receipt.deliveryId)` from `eve/events`:

| Observation          | Meaning                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `undefined`          | The delivery has not been observed in this view. Acceptance can precede stream admission. |
| `status: "admitted"` | Admitted but not yet consumed; `queue(view)` lists these while the session is open.       |
| `status: "consumed"` | A turn took the input; `turnId` identifies it.                                            |
| `status: "settled"`  | The delivery ended; `outcome` says how.                                                   |

A `session.ended` event also ends the wait. A degraded termination may not record every ending, so a retained delivery can still say `admitted` or `consumed`. Don't wait for another `delivery.settled` on a closed stream.

Client views retain observed history; hook and channel views can prune older finished deliveries. An ID without an accepted receipt can't distinguish an unknown delivery from one not yet admitted. `Delivery.result().status` describes a finished request (`completed`, `awaiting-input`, `failed`, or `cancelled`), not a live readiness state.

### Turns and interactions

A turn waiting for an approval, question, or sign-in pauses rather than ends. `turn.paused.data.awaiting` lists the requests it waits on, as `{ interactionId }`. No event announces the turn resuming: the next event under it, such as `model.requested`, shows it's running. Only `turn.settled` ends it. A turn waiting on its own work, such as its tasks, stays running.

The same pause can be reported more than once, such as when a message arrives that doesn't resume the turn. To notify someone once per pause, compare `awaiting` with the last one you saw.

Questions, approvals, and sign-ins raised by the turn or its calls all pause the turn. An answer arrives in a new delivery: `response.submitted` records it, and `interaction.settled` confirms the decision. Relayed requests carry `origin` coordinates for the asking call. Steering can withdraw a pending request, and cancellation interrupts it. A submitted answer isn't necessarily applied. Its `response.settled` reports the result:

| Outcome                  | Meaning                                       |
| ------------------------ | --------------------------------------------- |
| `applied`                | The answer decided its request.               |
| `refused`                | A response policy rejected it.                |
| `withdrawn`, `abandoned` | The request ended another way.                |
| `expired`, `failed`      | The answer didn't apply for any other reason. |

### Task facts

A call to a tool that runs as a task keeps working after the model gets a receipt. Task tools include agent tools, `agentRouter()`, the `workflow` tool, and workflow tools that define [`task(input, ctx)`](/docs/tools/workflows#run-calls-as-tasks-task) or [`serve(receive, ctx)`](/docs/tools/workflows#resumable-tasks-serve). `task.started` reports the task once, with its `taskId`, `name`, `kind` (`"agent"` for an agent tool, `"tool"` otherwise), and the call that started it. Each call the task serves, including later calls that reach a resumable task by its `taskId`, publishes `call.started` with that `taskId` and its own `call.settled`. Calls that share one reply reference the first call's output with `outputOf`.

`task.ended` reports the task's end, including immediate cancellation of agent and one-shot tasks. Its `outcome` is `"completed"`, `"failed"`, or `"cancelled"`. The final event is `task.ended`, not `task.settled`, because the task ends once while each call it serves ends separately. Results reach the model as a message in its history, so read outcomes from `call.settled`.

`child.opened` announces a child session. Ending a call doesn't end that session; later calls with the same `taskId` can reach it. The turn keeps running while its tasks work. See [Tasks](/docs/tools/tasks#turns-wait-for-their-tasks).

`child.sent` records each delivery a child accepted for one of this session's calls, after the child returns its receipt. It opens nothing. The delivery's events are on the child's stream under `childDeliveryId`, and the call's outcome is its `call.settled`. A remote agent on an earlier protocol returns no receipt, so its deliveries have no `child.sent`.

### Failures and cancellation

Before the next model request, eve repairs a local tool call in saved history that has no recorded result. It adds an error result that says the outcome is unknown, so the model checks external state before repeating side effects. The repair never runs the old call or closes work held by approvals, sign-in, workflows, or tasks. eve leaves provider-executed calls, SDK approvals, and duplicate call IDs unchanged.

A failed model run, turn, or session carries `error: { code, message, id?, hint? }` on its `model.settled`, `turn.settled`, or `session.ended`. `id` is a support id that eve's server logs also carry, and `hint` is a remedy when eve recognizes the failure.

A turn that ends closes what it left open in the same line. Running calls and open requests for input end `interrupted`, and their pending answers end `withdrawn`. A task can outlive its turn and stays open.

A session that fails ends its turn `cancelled`, because the session failed, not the turn. The error is on `session.ended`, and `failure(view, turnId)` reads it for that turn. Built-in channels post one notice for it.

When cancellation or clear ends a turn, input queued inside it but not yet read ends `ignored` and doesn't carry into the next turn. Messages the session holds for a later turn aren't part of that unread input.

A cancelled turn isn't a failure. It ends with `outcome: "cancelled"` and a `cause` naming the cancel delivery, and the session accepts the next message normally. What the turn streamed stays on the stream. Session history keeps the accepted user input and finished work and discards incomplete assistant output. Tool calls the cancellation stopped stay in history, each answered as cancelled, so the model sees that the work started and stopped.

When a model call fails transiently before publishing anything, the run records `model.retried` and tries again. Once it has published output, the run ends `abandoned` with its unfinished calls, and a new run tries again.

A provider `content-filter` response fails the run and turn with `MODEL_CALL_FAILED` and a `hint` to review the request against the provider's content policy. eve doesn't retry it; deltas already streamed stay visible, and the session can receive another message.

## Query session state

`SessionView` from `eve/events` is an opaque, immutable snapshot derived from the stream. Read it with queries:

```ts
import { activeTurn, call, calls, openInteractions, usage } from "eve/events";

const currentTurn = activeTurn(agent.view);
const tools = calls(agent.view, { kind: "tool", turnId: currentTurn?.turnId });
const pending = openInteractions(agent.view);
const totals = usage(agent.view);
const observed = call(agent.view, callId);
if (observed?.state === "failed") console.error(observed.error.message);
```

`callOutputSource(view, callId)` returns the call that produced a call's output. `call(view, callId)?.output` already follows `outputOf`, so use `callOutputSource` when you need the producing call itself, such as its `callId` or label.

Calls include their resolved `turnId`, `runId`, and `taskId` when known, so you don't join calls to runs to find their turn. `turns`, `deliveries`, `tasks`, `runs`, `parts`, and `children` return curated observations, and `turn`, `delivery`, `task`, and `interaction` look one up by ID. `waiting`, `activity`, and `reply` answer the status questions that built-in clients and channels use. Queries are synchronous and perform no I/O; referenced payloads stay references until explicitly read.

| `waiting(view, turnId)` returns       | When                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| `{ on: "session" }`                   | The session can make progress.                                                              |
| `{ on: "interaction", interactions }` | Answers are needed.                                                                         |
| `{ on: "work", calls, tasks }`        | Calls or tasks hold the turn.                                                               |
| `undefined`                           | The turn is absent or ended, or the session has ended, even if a degraded end left it open. |

`openInteractions(view, { about })` filters by what holds the work:

| `about`          | Includes                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| `{ callId }`     | The call's approval, questions relayed through it, and requests from its task.                               |
| `{ taskId }`     | That task's requests.                                                                                        |
| `{ turnId }`     | The turn's requests, including those of its inline calls and responses, but not ones from independent tasks. |
| `{ responseId }` | That response.                                                                                               |

Read `interaction.subject` to match the subject itself. An answered request that a response policy still weighs stays in `openInteractions` until it ends. `callState(view, callId)` distinguishes `approval` and `blocked` from running work. Both selectors return immutable observations.

Query results can't change the view, and a snapshot you retain doesn't change when later events arrive. Request observations omit private sign-in callback URLs, including in `waiting`, `activity`, and `openInteractions` results. Use `callPreview(view, callId)` and `contentPreviews(view)` for transient progress held by a client or a custom fold; recorded values stay separate. Hook and channel snapshots always describe a whole recorded line.

A custom reader uses the same fold:

```ts
import { emptySessionView, foldEvents, calls } from "eve/events";

let view = emptySessionView();
for await (const event of session.stream()) {
  view = foldEvents(view, [event]);
  render(calls(view, { kind: "tool" }));
}
```

`foldEvents` returns a new snapshot without changing its input. It holds incomplete lines until their final event arrives and absorbs overlapping replay. The view isn't a serialization format; persist events and session cursors to reconstruct it.

## Positions

A reader turns each entry in `facts`, and each progress record, into an event with a `meta` field:

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
- **`meta.at`** is the time of the line that holds the event, or, for a progress record, of the latest event line before it.
- **`meta.endOfLine`** is `false` while more events of the same line follow. Readers that stop on an event finish its line first.

That makes `(sessionId, line, index)` the key for ingesting a stream without duplicating rows when you re-read it:

```sql
insert into agent_events (session_id, line, index, type, data, emitted_at)
values ($1, $2, $3, $4, $5, $6)
on conflict (session_id, line, index) do nothing;
```

Positions are also a total order within a session: sort by `line`, then `index`.

A subagent's events live on its own stream. When a parent relays a child's request, the parent's `interaction.opened` is its own event at its own position. Correlate the two through `child.opened.data.sessionId` and the relayed event's `origin`.

Authored [hooks](../guides/hooks) and channels receive the same events, with their position as `ctx.position`, after the line is written.

## Send a follow-up message

After the turn ends, POST a follow-up to the session's messages endpoint:

```bash
curl -X POST http://127.0.0.1:2000/eve/v1/session/<sessionId> \
  -H 'content-type: application/json' \
  -d '{"message":"Now send the short version."}'
```

The follow-up continues the same session, with the same history and state. A follow-up accepts exactly one of `message` or `answers`. Send `answers` to answer open requests by ID:

```bash
curl -X POST http://127.0.0.1:2000/eve/v1/session/<sessionId> \
  -H 'content-type: application/json' \
  -d '{"answers":[{"interactionId":"req_A","optionId":"approve"}]}'
```

Message sends default to `turnPolicy: "steer"`: the new message joins the running turn instead of waiting for it. [Message delivery and steering](./execution-model-and-durability#message-delivery-and-steering) explains when it applies.

A steering message aborts the [`ctx.abortSignal`](/docs/tools/workflows#stop-early-for-a-new-message) of each `execute` workflow tool call the turn is waiting on. The call's questions end `withdrawn`, `sleep` and `ask_question` stop early, and the call ends with what its body returns. Steering ends an `eve__task_wait` but never interrupts a task, and a task's questions stay open.

Only the turn's own caller steers it; another caller's message waits for the turn to end. Channels and TypeScript `Session.send(...)` calls can pass `turnPolicy: "queue"` to let the active turn finish first. Structured `answers` answer the requests they name.

Answer a human-in-the-loop approval with the channel's Approve or Deny controls; text that doesn't match an option approves nothing. Such text from the person the turn serves steers the turn and cancels the approval, even with `turnPolicy: "queue"`. The turn can't end until that person acts. From anyone else, it waits until the turn ends. Calls already approved in the batch still run. Cancelling the turn withdraws the approval, and a later answer to it approves nothing.

A pending prompt accepts a plain-text answer. Prompts include a `ctx.ask()` question from a tool such as `ask_question`, a tool approval, and the budget prompt, including ones proxied from a subagent. A message answers the first open prompt, as described in [Several requests at once](/docs/human-in-the-loop#several-requests-at-once). A reply matching one of its options, such as `approve` or `deny`, counts as pressing that option. Any message counts when the prompt allows free text. Send one message per prompt to answer several. On the stream, such a message is a delivery whose `response.submitted` answers the prompt. A message that doesn't answer the first open prompt follows the normal `turnPolicy`. Use structured responses to target requests unambiguously.

A structured response matches any pending request by ID, not only the newest batch. It becomes stale once that request is answered, cleared, or cancelled. eve delivers a stale response to the model as a new user message, and the model decides whether the old selection still matters. A stale approval never authorizes the earlier tool call; the model must request the action and approval again if still needed.

One delivery can answer requests from several batches. Each answer stands as it arrives (`response.admitted`), and a later answer to the same request replaces it until the request is decided. A batch of approvals the model requested in one step is decided together once each has an answer. The approved calls then run, and the model reads their results next. Partial answers stand until the rest arrive. A message that steers the turn instead applies the answers already given and withdraws the rest. An answer a response policy weighs stays `response.submitted` until the policy allows it (`response.admitted`) or refuses it (`response.settled`).

When steering interrupts model generation, the interrupted run ends `interrupted` with any usage the provider reported. The new message's `delivery.consumed` and the next `model.requested` for the same `turnId` follow.

Multiple steering messages keep their arrival order and may be folded into one input at the next boundary. A message accepted after the turn ends starts the next turn.

## Cancel the in-flight turn

POST to the session's cancel endpoint to stop the running turn. The body is optional; pass `turnId` (in the `scope` of every event that belongs to a turn) to cancel only the turn you observed:

```bash
curl -X POST http://127.0.0.1:2000/eve/v1/session/<sessionId>/cancel
# {"ok":true,"sessionId":"<sessionId>","deliveryId":"delivery_cancel"}
```

The route returns `202` with the `sessionId` and the cancel's `deliveryId`, and cancellation completes asynchronously. Confirm it on the stream as `turn.settled` with `outcome: "cancelled"` and a `cause` naming that delivery. Each cancelled child session reports its own cancellation on its own stream. A cancel without a `turnId` guard also stops working tasks, including between turns, with `task.ended` events.

A live idle session accepts a cancel as a no-op. A `turnId` guard for a different turn, including `turnId: null` for no observed turn, can't cancel unrelated work. The cancel's `delivery.settled` reports `applied` or `ignored`. An unknown or terminal session returns `409 session_not_active`, not a separate `no_active_turn` result.

Custom channel routes request the same cancellation through
`from(address).cancel()` or `attachSession(sessionId).cancel()`. See
[custom channels](../channels/custom#channel-operations-and-session-handles).

## Compact, clear, and end

Session controls are addressed by session ID and accept no continuation token:

```bash
curl -X POST http://127.0.0.1:2000/eve/v1/session/<sessionId>/compact
curl -X POST http://127.0.0.1:2000/eve/v1/session/<sessionId>/clear
curl -X POST http://127.0.0.1:2000/eve/v1/session/<sessionId>/end \
  -H 'content-type: application/json' \
  -d '{"reason":"Start over"}'
```

Compaction summarizes history without adding a user message. If a turn is active, eve queues the request until that turn ends. User-role instructions are ordinary history and may be summarized; system-role instructions stay outside it. Recalled [memory](../memory) stays outside history, so the summary never includes it, and a memory provider can capture history before compaction rewrites it. On the stream, compaction is a context change: `context.started` and `context.settled` with `kind: "compaction"`, around the summary's model run. If summarization fails before a checkpoint, the compaction ends `failed` and the session keeps its previous history.

Clear removes model-message history in place, including static and dynamic user-role instructions. It keeps the session identity, system-role instructions, tools, skills, [`defineState`](./state) values, limits, and sandbox. Unchanged user-role instructions aren't inserted again. Clear doesn't delete data from a memory provider's external store, and the next turn recalls again. Approvals, the session-limit prompt, and sign-ins the cleared history asked for are withdrawn. Unlike a compaction, clear doesn't wait for a running turn. It cancels the turn, which ends `cancelled`, stops the calls it waits on, and ends working tasks with `task.ended`. A stopped task never reports into the cleared conversation. On the stream, clear is a context change with `kind: "clear"`.

A cancel stops turns, not a compaction or clear. A cancel that arrives while either runs ends `ignored`, and the compaction or clear finishes. A cancel, clear, or compact sent to a prewarmed session before its first message ends `ignored` once the session starts.

End permanently retires the session ID; create another session for a fresh conversation. Every control returns a delivery receipt when accepted. An inactive target throws `SessionNotActiveError` from a handle or returns `409 session_not_active` over HTTP.

A [stranded session](./execution-model-and-durability#stranded-sessions) can't run commands, so clear and compact can't repair it. End still works: eve retires the stranded session and returns the end's delivery receipt. The delivery ends after the session is retired and its addresses are released.

## Reconnect and rewind

The stream is stored, so a consumer can reconnect from its cursor when an HTTP connection ends. A nonnegative `startIndex` is the next line to read. Pass the last line you read plus one to resume, or `0` to rewind to the start.

The stream route serves renewable leases. It sends heartbeats while the stream is quiet, then ends the response with `{"$eve":"stream.lease-ended"}`. The client then reconnects from its cursor. Leases bound each read even when a host doesn't report a client disconnect. A finished session's stream ends with `{"$eve":"stream.ended"}`, so readers stop instead of reconnecting. Leases and heartbeats don't stop the run or appear as session events.

If a reconnect overlaps events you already handled, [`meta.position`](#positions) identifies the duplicates.

```bash
curl "http://127.0.0.1:2000/eve/v1/session/<sessionId>/stream?startIndex=<line>"
```

A negative `startIndex` reads relative to the stream's current tail. For example, `-1` reads the latest line:

```bash
curl "http://127.0.0.1:2000/eve/v1/session/<sessionId>/stream?startIndex=-1"
```

Pass `includeTailIndex=1` for a catch-up read that stops instead of following the live stream. The response carries the `x-eve-stream-tail-index` header, the zero-based position of the last recorded line (`-1` before the first), and ends after that line:

```bash
curl -i "http://127.0.0.1:2000/eve/v1/session/<sessionId>/stream?startIndex=<line>&includeTailIndex=1"
# x-eve-stream-tail-index: <tail>
```

Requests without the parameter get no header. `follow=false` instead bounds the response at the recorded tail on the server and implies the header. A bounded read only reads recorded history, so it also works for a [stranded session](./execution-model-and-durability#stranded-sessions), whose live stream returns `409 session_stranded`. The TypeScript client exposes this as `stream({ follow: false })`.

## Use the client from TypeScript

`eve/client` wraps these routes in a typed client for scripts, server-to-server calls, tests, evals, and custom UIs. Start with the [Client SDK](../guides/client/overview) guide, which covers sending messages, session state, streaming, and per-turn `outputSchema` results.

## Read a session in process

Code inside the agent's deployment, such as a hook, tool, schedule, or channel route, can read a session's stream with `sessions` from `eve/server`. It doesn't call the HTTP route. It has the client's `attach(sessionId).stream(...)` shape and needs no deployment URL, credentials, or stream protocol:

```ts
import { sessions } from "eve/server";

const events = sessions.attach(sessionId).stream({ startIndex, follow: false });

for await (const event of events) {
  await saveEvent(sessionId, event.meta.position, event);
}
```

`stream()` takes `SessionStreamOptions` from `eve/sessions`: `startIndex` (a line position; negative values count back from the tail), `follow`, and `signal`. Client readers also accept `reconnect: false` or a `ReconnectOptions` object from `eve/client`. With `follow: false`, the read ends at the recorded tail observed when it opens. Otherwise it follows new events until the stream closes or the signal aborts. Key stored events on [`meta.position`](#positions), which stays stable across reads.

A read sees only recorded events. A hook runs after its line is written, so a bounded read there includes the event that triggered it. `sessions` reads any session ID without channel auth, so check that a caller may read a session before passing an ID from a request. It's available only in code that runs inside the eve server.

## Inspect the agent over HTTP

`GET /eve/v1/info` returns agent-info version 5, a JSON snapshot of the effective compiled agent:

```bash
curl http://127.0.0.1:2000/eve/v1/info
```

The snapshot reports:

- the selected config;
- active tools, instructions, memory slots, skills, channels, schedules, sandbox, connections, hooks, and instrumentation, each with its source;
- dynamic resolvers, separately from their session-specific output;
- local and remote agents, in separate collections;
- prepared built-in effects;
- shadowed or disabled source diagnostics.

Memory tool wrappers include their selected memory-source dependency, and channel routes appear in the order the HTTP host uses. Static instructions are an ordered array of entries with `content` and `role`. The sandbox's opaque `revisionHash` identifies its compiler-discovered environment inputs.

The payload includes authored text and server paths, so the route serves only operator callers: `service` and `runtime` callers, and, when the channel's auth includes `localDev()`, callers it admits on a development server. Any other caller the channel admits, such as a `user` or `anonymous` caller, gets `403` with `{ "code": "info_forbidden", "ok": false }` and an `error` message. To give another credential access, return `principalType: "service"` or `allowAgentInfo: true` from its authenticator. See [Agent info access](../guides/auth-and-route-protection#agent-info-access).

The version changes only when the shape breaks. A server can add fields and enum values within a version, so ignore unknown fields and handle unknown enum values. `kind` discriminants, such as an owner's, a model endpoint's, or a module's backing `kind`, are closed: a new variant comes with a new version.

The info route belongs to the selected `channels/eve.ts` source and checks its auth policy before the operator check. Replacing or disabling that source replaces or removes the info route too. Without an authored source, eve uses the default auth chain `[vercelOidc(), localDev(), placeholderAuth()]`. A Vercel OIDC bearer takes precedence, and `localDev()` accepts requests to an `eve dev` or `vercel dev` server. Everything else is rejected. A deployed Vercel target requires a valid OIDC bearer, with a same-project bypass for in-deployment callers. See [auth & route protection](../guides/auth-and-route-protection).

## Dispatch order

Each new event line goes through these stages in order:

1. **Write**: the line is written to the stream.
2. **Channel handler**: the channel's event handler runs for each event and can update adapter state. eve then re-evaluates the channel's `metadata(state)`.
3. **Hooks**: authored [hooks](../guides/hooks) subscribed to each event fire.
4. **Intents**: eve acts on cancellation requests queued by `ctx.cancel()`.

Before the next model call, eve evaluates [dynamic values](../guides/dynamic-capabilities) from `defineDynamic`. Hooks and dynamic values read the current `ctx.channel.metadata`.

Channels and hooks observe what was written and can't change it.

## What to read next

- [Execution model & durability](./execution-model-and-durability): how a session survives restarts and how parked work resumes.
- [Channels](../channels/overview): how platform addresses map to sessions.
- [Client SDK](../guides/client/overview): call these routes from scripts and server-side code.
- [Frontend](../guides/frontend/overview): `useEveAgent` instead of raw routes.
