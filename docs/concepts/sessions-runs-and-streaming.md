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

Before handoff, eve validates that the saved session state has no pending work
inside the workflow. The current owner keeps its inbox while the successor
starts and validates the checkpoint. Once the successor takes over the session
hooks, the original owner forwards messages it accepted during the move and
parks on the stream anchor until the final owner reports the session result.

Authored channels also have channel-local continuation tokens. A token addresses
whichever session currently owns a platform conversation, such as a Slack thread.
That identity stays behind the channel boundary and is never accepted or returned
by the eve HTTP session API. See [Custom channels](../channels/custom#channel-operations-and-session-handles).

A session completes after 30 idle days by default; configure
`limits.sessionTimeoutMs` in `agent.ts`, or set it to `false` to disable the
timeout. The idle window restarts each time a turn settles, and a session never
expires while a turn is open. At expiration, eve emits `session.ended` with `outcome: "completed"` and
releases the session's continuation addresses so the next qualifying channel
message starts fresh. Stored session data is not deleted. See
[Agent config](../agent-config#runtime-limits).

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

| Family        | Facts                                                                | What it is                                                                                                                                                                                                                                                                                                             |
| ------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session`     | `session.started`, `session.ended`                                   | The session. `session.started` carries `runtime`, `parent` for a child session, `predecessor` when the session [replaced a stranded one](./execution-model-and-durability#what-a-replacement-session-receives), and `trace` when traced. `session.ended` has `outcome` `"completed"` or `"failed"`.                    |
| `delivery`    | `delivery.admitted`, `delivery.consumed`, `delivery.settled`         | One accepted message, answer, control, or callback. `delivery.consumed` carries the `parts` a turn received, and any `history` the delivery imported; `delivery.settled` reports what became of it.                                                                                                                    |
| `turn`        | `turn.started`, `turn.paused`, `turn.settled`                        | A turn. `turn.paused` lists the interactions it's `awaiting`. `turn.settled` has `outcome` `"completed"`, `"failed"`, or `"cancelled"` and, when completed, the `reply` part ids.                                                                                                                                      |
| `model`       | `model.requested`, `model.started`, `model.retried`, `model.settled` | One model run, owned by a turn or a context change. `model.started` names the `modelId` and the `attempt`, once per attempt; `model.retried` records an attempt that failed and is tried again; `model.settled` carries `outcome` and `finishReason`.                                                                  |
| `content`     | `content.completed`                                                  | One finished part of model output: `kind` `"text"`, `"reasoning"`, `"result"`, or `"file"`, its `value`, and its `phase`: `"reply"` or `"narration"`.                                                                                                                                                                  |
| `call`        | `call.requested`, `call.started`, `call.settled`                     | One tool, agent, or skill call. `call.requested` names its `capability` and `input`, and a remote agent's capability has `remote: true`; `call.started` carries `taskId` when the call reaches a task and `clearedBy` when an approval or policy let it run; `call.settled` carries `outcome` and `output` or `error`. |
| `task`        | `task.started`, `task.ended`                                         | Work that outlives the call that started it, such as an agent tool's child session. See [Task facts](#task-facts).                                                                                                                                                                                                     |
| `interaction` | `interaction.opened`, `interaction.settled`                          | A person's approval, question, budget prompt, or sign-in.                                                                                                                                                                                                                                                              |
| `response`    | `response.submitted`, `response.admitted`, `response.settled`        | One answer to an interaction, tied to the delivery it arrived in.                                                                                                                                                                                                                                                      |
| `child`       | `child.opened`                                                       | A child session a call or task opened; carries its `sessionId`, `name`, and the `stream` path to follow.                                                                                                                                                                                                               |
| `context`     | `context.started`, `context.settled`                                 | A context change: `kind` `"compaction"` or `"clear"`.                                                                                                                                                                                                                                                                  |
| `usage`       | `usage.recorded`                                                     | Model spend, owned by the run, call, or context change that spent it.                                                                                                                                                                                                                                                  |

Progress records are `content.delta` (a text or reasoning delta for a `partId`), `call.input` (a raw tool-input delta for a `callId`), and `call.progress` (a preliminary output snapshot for a `callId`).

Call labels use `capability.label` before execution, `call.progress.data.label` for a progress
snapshot, and `call.settled.data.label` at completion. The fold keeps the final label as
`call(view, callId)?.label`. A prompt's heading remains `request.title`.

The full catalog, its outcome sets, and TypeScript types are exported from `eve/events`, along with the shared fold and queries over [opaque session snapshots](#query-session-state):

```ts
import { FACT_CATALOG, foldEvents, activeTurn, reply } from "eve/events";
```

#### What a later release can add

Within stream version 27, a later minor release can add:

- fact types that only add information: a new family, or an update to a row such as `model.retried`, never the only way an entity opens or ends;
- progress record types;
- optional fields;
- outcomes, interaction kinds, displays, and option styles.

It never removes or renames a fact or field, changes what a fact means or which role it plays in its entity's lifecycle, or adds a required field. Anything else is a new stream version, which readers refuse.

Readers stay correct across these additions: they ignore fact and progress types and fields they don't know, and a terminal fact with an outcome they don't know still ends its row, keeping the outcome as sent. The TypeScript types name today's values only, so when you switch on an outcome, kind, display, or style, keep a default branch.

The fold skips positions it has already seen after reconnect. For retained lifecycle rows, repeated introductions and terminals are ignored; status-gated updates cannot reopen ended rows. Progress and usage at new positions are not deduplicated.

The optional `data.trace` on `session.started` and `turn.started` contains eve-owned W3C trace coordinates: `traceId`, `spanId`, and `traceFlags`. Use it to correlate stream consumers such as eval reporters with an observability backend. An uninstrumented target omits it.

### Streamed output

`content.delta` and `call.input` carry only their new text. Accumulate them in stream order, per `partId` or `callId`, when you need the text so far. When the durable writer is busy, eve may merge adjacent deltas for the same part or call; the resulting text and ordering stay the same. `content.completed` carries the authoritative value of each finished part, so a reader that reconnects without its accumulated text can wait for it instead of replaying the deltas.

When a streamed tool input becomes a validated call, its `call.input` records precede its `call.requested`. The client shows the potentially incomplete JSON as a `tool` part with `state: "streaming"` and its `inputText`, then as `state: "requested"` with the validated `input` on `call.requested`.

`call.progress` carries one complete preliminary output snapshot from an authored async-generator tool. A later snapshot for the same `callId` replaces it, and `call.settled` carries the final output. Treat snapshots as last-write-wins. Provider-executed tool progress and MCP progress notifications are not projected as `call.progress`.

A call the model makes through [`eve__tool` or `eve__skill`](/docs/concepts/built-in-tools#eve__search-eve__tool-and-eve__skill) is reported as a call to the entry it names. Its `call.requested` carries that entry's name and input, such as `linear__list_issues`, never the catalog tool's. An `eve__skill` call has `capability: { kind: "skill", name }`. The model's own task controls, `eve__task_wait` and `eve__task_cancel`, have `kind: "control"`; activity views usually leave them out. A `call.input` that announces a call carries the same `kind` beside its `name`. Calls through either tool publish no `call.input`, because their entry is known only once their input is complete.

Note: consider the privacy, confidentiality, and user-experience implications for displaying, storing, or transmitting reasoning content in your application.

### Replies and narration

A model often writes text before it calls a tool. Each text part's `content.completed.data.phase` tells you which it is: `"narration"` for text written on the way to more work, `"reply"` for the turn's answer. `turn.settled.data.reply` lists the reply's part ids, so a reader that only needs the answer can wait for the turn to settle and read those parts. `reply(ctx.view, turnId)` returns those parts in a hook or channel handler without exposing the backing table. When a turn requested an output schema, the structured result is a `content.completed` with `kind: "result"`.

Spend is recorded on `usage.recorded`, once per model run (`owner: { runId }`), once per delegated call for what the agent it called spent (`owner: { callId }`), and once per compaction (`owner: { changeId }`). Spend a task reports after its calls settled has no owner and `kind: "delegated-late"`. A session's total is the sum of its records; `usage(view).total` returns it. The usage window that [`limits.sessionUsage`](../agent-config#runtime-limits) reads starts at that total on the line where the session's own budget prompt settles `accepted`.

### Deliveries and responses

Everything that reaches a session arrives as a delivery: a message, an answer, a control such as `cancel` or `reset`, or a sign-in callback. `delivery.admitted` records it, with the sender's `principal` and its `source`. A message that a turn takes in is `delivery.consumed`, with the `parts` it received: text, plus file metadata without raw bytes or internal sandbox paths. A delivery that brought [prior history](../channels/eve#start-from-prior-history) also carries it there, in `history`. Every delivery ends with exactly one `delivery.settled`, except after a degraded termination (see below):

| Outcome          | Meaning                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| `handled`        | The turn that consumed it settled.                                                                  |
| `awaiting-input` | The turn paused on an interaction. The delivery's answer is the pause; the answer resumes the turn. |
| `applied`        | A control or answer took effect.                                                                    |
| `ignored`        | It had nothing to act on, or a cancel or clear ended its turn before the turn read it.              |
| `refused`        | Its sender may not do what it asked; `reason` says why.                                             |
| `failed`         | It couldn't be handled, such as when the session ended first.                                       |

`POST /eve/v1/session/:sessionId` returns the message's `deliveryId`, so a client resuming from an old cursor knows which `delivery.settled` ends its response. Steering and coalesced messages each keep their own delivery. The id is assigned before dispatch,
not derived from stream position. An answer-only delivery stops on its own `delivery.settled`.
A stranded reset records its control's admission and settlement before ending the session, with
`session.ended.data.cause.deliveryId` naming the reset.
An answer and message sent together by someone other than the turn's caller become separate deliveries: the answer reaches the waiting turn, and the message retains the receipt and waits. Follow the answer through its interaction.

To follow an accepted receipt in a client view, use `delivery(view, receipt.deliveryId)` from
`eve/events`:

| Observation          | Meaning                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `undefined`          | The delivery has not been observed in this view. Acceptance can precede stream admission. |
| `status: "admitted"` | Admitted but not yet consumed; `queue(view)` lists these while the session is open.       |
| `status: "consumed"` | A turn took the input; `turnId` identifies it.                                            |
| `status: "settled"`  | The delivery ended; `outcome` says how.                                                   |

A `session.ended` event also ends the wait. After a degraded termination that could not record
all closures, a retained delivery may still say `admitted` or `consumed`; do not wait for another
`delivery.settled` on a closed stream.

Client views retain observed history; hook and channel views can prune older settled deliveries. An arbitrary ID without an accepted receipt cannot distinguish an unknown delivery from one not yet admitted. `Delivery.result().status` describes a settled request (`completed`, `awaiting-input`, `failed`, or `cancelled`), not a live readiness state.

### Turns and interactions

A turn doesn't end while it waits on an interaction; it pauses. `turn.paused.data.awaiting` names the interactions it waits on, as `{ interactionId }`. Nothing announces the turn resuming: the next fact under it, such as its next `model.requested`, shows it's running again, and only `turn.settled` ends it. A turn waiting on its own work, such as its tasks, stays running without pausing.

Questions, approvals, and sign-ins raised by the turn or its calls all pause the turn. An answer arrives in a new delivery; `response.submitted` records it, and `interaction.settled` confirms the decision. Relayed requests carry `origin` coordinates for the asking call. Steering can withdraw a pending request; cancellation interrupts it. A submitted answer is not necessarily applied: check `response.settled` and `interaction.settled`. Each answer's `response.settled` reports what became of it: `applied` when it decided its interaction, `refused` when a response policy rejected it, `withdrawn` or `abandoned` when the interaction settled another way, and `expired` or `failed` otherwise.

### Task facts

A call to a tool that runs as a task, such as an agent tool, `agentRouter()`, the `workflow` tool, or a workflow tool that defines [`task(input, ctx)`](/docs/tools/workflows#run-calls-as-tasks-task) or [`serve(receive, ctx)`](/docs/tools/workflows#resumable-tasks-serve), keeps working after the model gets a receipt. `task.started` reports the task once, with its `taskId`, `name`, `kind` (`"agent"` for an agent tool, `"tool"` otherwise), and the call that started it. Each call the task serves, including later calls that reach a resumable task by its `taskId`, publishes `call.started` with that `taskId` and settles with `call.settled` on its own reply. Calls that share one reply reference the first call's output with `outputOf`. `task.ended` comes when the task ends, including immediate cancellation of agent and one-shot tasks, with `outcome` `"completed"`, `"failed"`, or `"cancelled"`. Results reach the model as a message in its history, so read outcomes from `call.settled`. The terminal is `task.ended`, not `task.settled`: the task ends once, while each call it serves settles separately.

`child.opened` announces a child session. Settling a call does not end that session; later calls with the same `taskId` can reach it. The turn remains running while its tasks work. See [Tasks](/docs/tools/tasks#turns-wait-for-their-tasks).

### Failures and cancellation

Before the next model request, eve repairs unambiguous orphaned local tool calls in saved history only when no result was recorded anywhere. An error result states that the execution outcome is unknown and external state must be checked before repeating side effects. This repair never executes the old call, moves recorded results, or settles work still owned by approvals, sign-in, workflows, or tasks. Provider-executed calls, SDK approvals, and duplicate call IDs are left unchanged.

A failed model run, turn, or session carries `error: { code, message, id?, hint? }`: `id` is a support id that eve's server logs carry too, and `hint` a remedy when eve recognizes the failure on its `model.settled`, `turn.settled`, or `session.ended`. A turn that ends closes everything it left open in the same commit: running calls settle `interrupted`, open interactions settle `interrupted`, and their pending answers settle `withdrawn`. A task can outlive its turn and stays open. A
session that fails ends the turn it held `cancelled`, since the session failed, not the turn: the
error is on `session.ended`, and `failure(view, turnId)` reads it for that turn. Built-in channels
post one notice for it.

Input queued inside a turn but not yet read settles `ignored` when cancellation or clear ends
that turn. It does not carry into the next turn. Messages still held by the session for a
later turn are not part of that turn's unread input.

A cancelled turn is not a failure: it settles with `outcome: "cancelled"` and `cause` naming the cancel delivery, and the session accepts the next message normally. Whatever the turn streamed before cancellation stays on the stream. Durable history keeps the accepted user input and previously settled work, and discards incomplete assistant output. Tool calls the cancellation stopped stay in history, each answered as cancelled, so the model sees that the work started and stopped instead of a request left unanswered. When a model call fails transiently before it published anything, the run records `model.retried` and tries again; once it has published output, its run settles `abandoned`, with its unfinished calls, and a new run tries again.

A provider `content-filter` response fails the run and turn with `MODEL_CALL_FAILED` and a `hint` to review the request against the provider's content policy. eve does not retry the filtered response; deltas already streamed remain visible, and the session can receive another message.

## Query session state

`SessionView` from `eve/events` is an opaque, immutable snapshot derived from the stream. Use
queries instead of reading tables or joining rows:

```ts
import { activeTurn, call, calls, openInteractions, usage } from "eve/events";

const currentTurn = activeTurn(agent.view);
const tools = calls(agent.view, { kind: "tool", turnId: currentTurn?.turnId });
const pending = openInteractions(agent.view);
const totals = usage(agent.view);
const observed = call(agent.view, callId);
if (observed?.state === "failed") console.error(observed.error.message);
```

Calls include their resolved `turnId`, `runId`, and `taskId` when known, so applications do not
join calls to runs to find their turn. `turns`, `deliveries`, `tasks`, `runs`, `parts`, and
`children` return curated observations. Identity lookups include `turn`,
`delivery`, `task`, and `interaction`. `waiting`, `activity`, and `reply` answer
the same lifecycle questions used by built-in clients and channels. These queries are
synchronous and perform no I/O; referenced payloads remain references until explicitly read.

`waiting(view, turnId)` returns `{ on: "session" }` while the session can make progress,
`{ on: "interaction", interactions }` when answers are needed, or
`{ on: "work", calls, tasks }` when calls or tasks hold the turn. It returns `undefined`
when the turn is absent or settled, or once the session has ended, even if a degraded end left the
turn open. `openInteractions(view, { about: { callId } })` includes the
call's approval, questions relayed through it, and interactions belonging to its task;
`{ about: { taskId } }` includes that task's interactions. A turn `about` filter also includes
interactions owned by its inline calls and responses, but not independent task-owned interactions.
A response `about` filter matches that response. Read `interaction.subject` to match the subject
itself. A response
already answered but still being weighed by a response policy remains open and appears in
`openInteractions` until it settles; `callState(view, callId)` distinguishes `approval` and
`blocked` from running work. Both selectors return immutable observations.

The public view contains no tables or preview dictionaries. Query results cannot mutate the
fold, and a snapshot you retain stays unchanged when later events arrive. Interactions omit
private sign-in callback URLs, including when returned by `waiting`, `activity`, or `openInteractions`. Use
`callPreview(view, callId)` and `contentPreviews(view)` for transient progress held by a client
or a custom fold; committed values remain separate. Hook and channel snapshots describe the
whole committed line, never half of it.

A custom reader uses the same fold:

```ts
import { emptySessionView, foldEvents, calls } from "eve/events";

let view = emptySessionView();
for await (const event of session.stream()) {
  view = foldEvents(view, [event]);
  render(calls(view, { kind: "tool" }));
}
```

`foldEvents` returns a new snapshot without changing its input. It retains incomplete lines
internally until their final event arrives and absorbs overlapping replay. Persist events and
session cursors to reconstruct a view; the opaque value is not a serialization format.

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

The follow-up reuses the same durable session: same history, same state. A follow-up accepts exactly one of `message` or `answers`. Use answers to answer one or more open interactions by ID:

```bash
curl -X POST http://127.0.0.1:2000/eve/v1/session/<sessionId> \
  -H 'content-type: application/json' \
  -d '{"answers":[{"interactionId":"req_A","optionId":"approve"}]}'
```

Message sends default to `"steer"`. Before assistant output begins, eve interrupts pending model generation and continues the same turn with the correction. Reasoning and provider search progress do not count as assistant output. An executing eve tool finishes safely, and its result is preserved before the correction reaches the next model call. A steering message aborts the [`ctx.abortSignal`](/docs/tools/workflows#stop-early-for-a-new-message) of each `execute` workflow tool call the turn is waiting on: its questions are withdrawn, `sleep` and `ask_question` stop early, and the call settles with what its body returns. A steering message ends an `eve__task_wait` but never interrupts a task. Only the turn's own caller steers it; another caller's message waits for the turn to end. After assistant output starts, steering applies at the next committed workflow boundary; text already streamed remains visible. Channels and TypeScript `Session.send(...)` calls can select `turnPolicy: "queue"` when the active turn should finish first. Structured `answers` answer the interactions they name.

If the session is waiting on a human-in-the-loop approval, respond with the channel’s Approve or Deny controls. Text that doesn't match an option doesn't approve the call. From the person the turn serves, it steers the turn and cancels the approval, even when sent with `turnPolicy: "queue"`, since the turn can't end until that person acts; from anyone else, it waits until the turn ends. If they had already approved some calls in the batch, those calls still run. Cancelling the turn withdraws the approval, and a later answer to it approves nothing.

A pending prompt, whether a `ctx.ask()` question from a tool such as `ask_question`, a tool approval, or the budget prompt, can be answered with plain text, including prompts proxied from a subagent. A message answers the first open prompt, as described in [Several requests at once](/docs/human-in-the-loop#several-requests-at-once): a reply that matches one of its options, such as `approve` or `deny`, answers it as if the sender had pressed that option, and so does any message when the prompt allows free text. Send one message per prompt to answer several. The stream records a message that answers a question as a delivery whose `response.submitted` answers it. A message that doesn't answer the first open prompt follows the normal `turnPolicy`. A steering message withdraws the questions of the `execute` workflow tool calls the turn waits on, which settle `withdrawn`; a task's questions stay open. Use structured responses to target requests unambiguously.

A structured response matches any currently pending request by ID, not only the newest batch. It becomes stale only after that request was answered, cleared, or cancelled. eve delivers a stale response to the model as a new user message, and the model decides whether the old selection still matters. A stale approval never authorizes the earlier tool call; the model must request the action and approval again if they are still needed.

One delivery can answer requests from several batches. Each answer stands as it arrives (`response.admitted`), and a later answer to the same request replaces it until the request settles. A batch of approvals the model asked for in one step settles together once each has an answer: the approved calls run then, and the model reads their results next. If you answer only some approvals in a batch, those answers stand until the rest arrive. A message that steers the turn instead settles the answered approvals on their answers and withdraws the rest. An answer a response policy weighs stays `response.submitted` until the policy allows it (`response.admitted`) or refuses it (`response.settled`).

When steering interrupts pending model generation, the interrupted run settles `interrupted`, with any usage the provider reported. The correction's `delivery.consumed` and the next `model.requested` for the same `turnId` follow.

Multiple steering messages retain their durable arrival order and may be folded into one input at the next boundary. A message accepted after turn settlement starts the next turn. See [message delivery and steering](./execution-model-and-durability#message-delivery-and-steering).

## Cancel the in-flight turn

POST to the session's cancel endpoint to stop the turn that is currently running. The body is optional; pass `turnId` (in every turn-scoped fact's `scope`) to scope the cancel to the turn you observed:

```bash
curl -X POST http://127.0.0.1:2000/eve/v1/session/<sessionId>/cancel
# {"ok":true,"sessionId":"<sessionId>","deliveryId":"delivery_cancel"}
```

The HTTP route returns `202` with the command's `sessionId` and `deliveryId`. Cancellation completes asynchronously. The cancel arrives as a control delivery; confirm it on the stream as `turn.settled` with `outcome: "cancelled"` and `cause` naming that delivery. Each cancelled child reports its own boundary on its child-session stream. An unguarded cancellation also stops working tasks, including between turns, with `task.ended` facts.

A live idle session accepts a no-op cancellation. A guard for a different turn, including `turnId: null` for no observed turn, cannot cancel unrelated work. The cancellation delivery settles when applied or ignored. An unknown or terminal session returns `409 session_not_active`, not a separate `no_active_turn` result.

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

Compaction summarizes context without adding a user message. User-role instructions are ordinary history and may be represented by the summary; system-role instructions remain outside it. Recalled [memory](../memory) stays outside history, so the summary never includes it, and a memory provider can capture the history before compaction rewrites it. If a turn is active, eve queues the request until that turn settles. A compaction is a context change: `context.started` and `context.settled` with `kind: "compaction"`, around the summary's model run. If summarization fails before a checkpoint, the change settles `failed` and the session keeps its previous history.

Clear removes model-message history in place, including static and dynamic user-role instructions, while preserving the session identity, system-role instructions, tools, skills, application-defined durable state, limits, and sandbox. It does not delete data from a memory provider's external store, and the next turn recalls again. It does not rerun instruction definitions or dynamic capabilities. Approvals, the session-limit prompt, and sign-ins the cleared history asked for are withdrawn: each settles its interaction. Requests relayed from tasks that keep running stay answerable. The clear is a context change with `kind: "clear"`.

Reset terminally retires the exact session ID. A reset ID never becomes a new session; create another session explicitly for a fresh conversation. All controls return delivery receipts when accepted. An inactive target throws `SessionNotActiveError` from a handle or returns `409 session_not_active` over HTTP.

A [stranded session](./execution-model-and-durability#stranded-sessions) cannot run commands. Reset still works: eve retires the stranded workflow run and returns its delivery. Its settlement follows retirement and address release. Clear and compact cannot repair a stranded owner; use reset instead.

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

`stream()` takes `SessionStreamOptions` from `eve/sessions`: `startIndex` (a durable line position, with negative values counting back from the tail), `follow`, and `signal`. Client readers also accept `streamReconnectPolicy`. Key stored events on [`meta.position`](#positions), which stays stable across reads. With `follow: false`, the read ends at the durable tail observed when it opens; otherwise it keeps following new events until the stream closes or the signal aborts.

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
4. **Intents**: eve acts on cancellation requests queued by `ctx.cancel()`.

Before the next model call, eve evaluates [dynamic capabilities](../guides/dynamic-capabilities), and `ctx.channel.metadata` already holds the freshly projected metadata.

The order is structural, not incidental. Channels and hooks observe what was written; neither can change it. By the time a dynamic capability or hook reads channel metadata, the channel has already updated its state and the projection is current.

## What to read next

- [Execution model & durability](./execution-model-and-durability): what makes a session durable and how parked work resumes.
- [Channels](../channels/overview): how platform addresses map to durable sessions.
- [Client SDK](../guides/client/overview): call these routes from scripts and server-side code.
- [Frontend](../guides/frontend/overview): `useEveAgent` instead of raw routes.
