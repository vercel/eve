---
issue: "None (maintainer-requested research)"
status: implemented on stack #4696
last_updated: "2026-10-13"
---

# Session event lifecycle

This is the v27 session stream contract as built on stack #4696. The contract lives in
`packages/eve/src/protocol/session-events/` and the shared fold in
`protocol/session-projection/`. Both are exported from `eve/events`.

Companion docs:

- [`session-changes-overview.md`](./session-changes-overview.md) maps the PRs, the numbers, and
  what breaks.
- [`session-event-tree.md`](./session-event-tree.md) covers ownership and how endings cascade.
- [`session-reactions.md`](./session-reactions.md) covers dynamic values and hooks (#4616).
- [`session-core-target.md`](./session-core-target.md) covers what comes after 1.0.

## Why

v26 had 34 event types, added one feature at a time, and few entities had a recorded beginning
and end. Readers reconstructed lifecycles from timing, text, and events that didn't arrive, each
slightly differently. Some examples:

- A response was done at "the first turn boundary" for the message's `meta.deliveryIds`.
- One declined approval wrote three events with three words for its outcome.
- The reply was whichever text didn't have `finishReason: "tool-calls"`.
- Nothing said "stop reading", so clients gave up after five empty reconnects.

In v27, every entity is introduced by one fact and ends with exactly one terminal fact. A
transition writes all of its facts as one stream line. Every reader folds the stream with the
same fold.

## The model

### Entities

| Entity         | What it is                                                        | Introduced by        | Ends with             |
| -------------- | ----------------------------------------------------------------- | -------------------- | --------------------- |
| Session        | A durable conversation and its ongoing work                       | `session.started`    | `session.ended`       |
| Delivery       | One submitted message, answer, control, or sign-in callback       | `delivery.admitted`  | `delivery.settled`    |
| Turn           | Agent work that can pause and resume                              | `turn.started`       | `turn.settled`        |
| Model run      | One logical model invocation, with one or more attempts           | `model.requested`    | `model.settled`       |
| Content part   | One block of model output: text, reasoning, a result, a file      | `content.completed`  | `content.completed`   |
| Call           | One invocation of a tool, agent, skill, or task control           | `call.requested`     | `call.settled`        |
| Task           | Work that outlives an immediate return                            | `task.started`       | `task.ended`          |
| Interaction    | An approval, question, sign-in, or budget prompt                  | `interaction.opened` | `interaction.settled` |
| Response       | One answer to an interaction, from a person or a sign-in callback | `response.submitted` | `response.settled`    |
| Context change | An operation on what the model sees next: a compaction or a clear | `context.started`    | `context.settled`     |

Two smaller records have no lifecycle. `child.opened` links a call or task to a child session,
whose lifecycle lives in its own stream. `usage.recorded` attributes usage to the run, call, or
context change that spent it.

```text
Session
├─ Delivery ──consumed into──▶ Turn
├─ Turn (cause: a delivery; follows: an earlier turn)
│    ├─ Model run
│    │    ├─ Content part
│    │    └─ Call ──served by──▶ Task
│    │         ├─ Call (nested)
│    │         └─ Interaction (approval)
│    │              └─ Response ──submitted in──▶ Delivery
│    └─ Interaction (sign-in, budget)
├─ Context change
│    └─ Model run (a summary)
└─ Task (can outlive turns)
     ├─ Interaction (question, sign-in)
     └─ Child session link
```

An entity's owner never changes. When an owner ends, the writer closes everything still open
under it in the same commit, leaves first, with `session.ended` last
([`session-event-tree.md`](./session-event-tree.md)). Calls and interactions outlive their model
run, and end with their turn or task. Tasks can outlive turns, and end before `session.ended`.

### Rules

1. **Introduce before reference.** A fact references an entity only after the fact that
   introduces it. The one exception is progress: while its run is open, the first progress
   record may announce a content part or call before the fact that introduces it.
2. **Exactly one terminal.** Each entity has one terminal type, with an outcome from a closed
   set. If a malformed stream has two, the first wins.
3. **Explicit closure.** When the machine ends something, it writes terminals for everything
   that ends with it, in the same commit. No reader infers an ending from text, `isError`,
   progress, or a missing event.
4. **One commit per line.** A transition's facts are one line,
   `{"at": <timestamp>, "facts": [...]}`, so a crash leaves all of a decision or none of it.

The checker (`checker.ts`) enforces these rules on every line written under `eve dev`, and in
the unit and integration tests.

### Outcomes

Things that resolve once _settle_. Long-lived containers that go idle _end_: sessions and tasks.
Content parts arrive _completed_. Every type is `family.verb`, and each type's role (introduces,
updates, terminal) is catalog data, so readers can handle families generically.

| Terminal              | Outcomes                                                                        |
| --------------------- | ------------------------------------------------------------------------------- |
| `session.ended`       | completed, failed                                                               |
| `delivery.settled`    | handled, awaiting-input, applied, ignored, refused, failed                      |
| `turn.settled`        | completed, failed, cancelled                                                    |
| `model.settled`       | completed, failed, interrupted, abandoned                                       |
| `call.settled`        | completed, failed, rejected, interrupted, abandoned                             |
| `task.ended`          | completed, failed, cancelled                                                    |
| `interaction.settled` | accepted, declined, invalid, failed, withdrawn, interrupted, abandoned, expired |
| `response.settled`    | applied, refused, failed, withdrawn, abandoned, expired                         |
| `context.settled`     | completed, failed, cancelled, interrupted                                       |

Words with a narrow meaning:

- **cancelled:** someone stopped it directly.
- **interrupted:** it was cut off because something it depends on stopped.
- **abandoned:** a newer instance replaced it: a retry, a newer attempt, or a revised answer.
- **withdrawn:** the asker no longer needs it, and `reason` says why.
- **rejected:** a call never ran because of a decision, and `cause` says whose.
- **declined** means a person said no. **refused** means policy said no.

## Catalog

27 facts and 3 progress types (`~`). Progress streams between commits and never enters the
lifecycle tables.

| Type                  | Role                 | Replaces in v26                                                 |
| --------------------- | -------------------- | --------------------------------------------------------------- |
| `session.started`     | Introduces           | `session.started`                                               |
| `session.ended`       | Terminal             | `session.completed`, `session.failed`                           |
| `delivery.admitted`   | Introduces           | New (only `meta.deliveryIds` before)                            |
| `delivery.consumed`   | Updates              | `message.received`                                              |
| `delivery.settled`    | Terminal             | New (inferred from turn boundaries before)                      |
| `turn.started`        | Introduces           | `turn.started`                                                  |
| `turn.paused`         | Updates              | `turn.waiting`, for waits on people only                        |
| `turn.settled`        | Terminal             | `turn.completed`, `turn.failed`, `turn.cancelled`               |
| `model.requested`     | Introduces           | New (resolvers ran on a preview of `step.started` before)       |
| `model.started`       | Updates              | `step.started`, once per attempt                                |
| `model.retried`       | Updates              | New: an attempt failed and the same run tries again             |
| `model.settled`       | Terminal             | `step.completed`, `step.failed`                                 |
| `content.delta~`      | Progress (announces) | `message.appended`, `reasoning.appended`                        |
| `content.completed`   | Introduces and ends  | `message.completed`, `reasoning.completed`, `result.completed`  |
| `call.input~`         | Progress (announces) | `action.input.appended`                                         |
| `call.requested`      | Introduces           | `actions.requested`, one fact per call                          |
| `call.started`        | Updates              | New (per-call `task.started` before, for task calls)            |
| `call.progress~`      | Progress             | `action.partial`                                                |
| `call.settled`        | Terminal             | `action.result`, and `task.settled` for the calls a task serves |
| `task.started`        | Introduces           | `task.started`, once per task                                   |
| `task.ended`          | Terminal             | New                                                             |
| `interaction.opened`  | Introduces           | `input.requested`, `authorization.required`                     |
| `interaction.settled` | Terminal             | `input.resolved`, `approval.settled`, `authorization.completed` |
| `response.submitted`  | Introduces           | `approval.candidate` with `pending`; new for other answers      |
| `response.admitted`   | Updates              | New (private batch state before)                                |
| `response.settled`    | Terminal             | `approval.candidate` with any other outcome                     |
| `child.opened`        | Introduces           | `agent.started`                                                 |
| `context.started`     | Introduces           | `compaction.requested`; new for a clear                         |
| `context.settled`     | Terminal             | `compaction.completed`, `context.cleared`                       |
| `usage.recorded`      | Record               | `usage` on step, turn, and session events                       |

`session.waiting` and `turn.resumed` are gone. An authored hook or channel handler keyed on a
removed v26 name fails the build with what to key on instead
(`public/definitions/removed-event-keys.ts`). `session.waiting` maps to `delivery.settled`,
`turn.settled`, or `idle(ctx.view)`. A turn going on after a pause shows as its next
`model.requested` or `delivery.consumed`.

## Payloads

<details>
<summary>Sessions and deliveries</summary>

```text
session.started    { parent?: {sessionId, callId}, predecessor?: {sessionId}, runtime?, trace? }
session.ended      { outcome: completed | failed, cause?, error? }

delivery.admitted  { deliveryId, principal?, source?: {channel, scheduleId?, caller?} | {control} | {callback}, clientContext? }
delivery.consumed  { deliveryId, turnId, parts }
delivery.settled   { deliveryId, outcome, turnId?, reason? }
```

- **Every reader stops at `session.ended`.** A failed session names what failed in `cause`, such
  as `{turnId}`, and carries the error. The turn it held settles `cancelled`, so channels post
  one failure notice, and `failure(view, turnId)` reads the session's error for that turn. The
  ending commit settles every unsettled delivery `failed`.
- **`predecessor`** names the session this one replaced, when eve started it in place of one
  whose deployment was retired. `runtime` identifies the eve instance, and `trace` holds W3C trace
  coordinates.
- **A delivery is any inbound operation** with a `deliveryId`: HTTP sends, channel webhooks,
  schedules, parent-to-child messages, controls (`{control: "cancel" | "clear" | "compact" |
"reset"}`), and sign-in callbacks (`{callback: "authorization"}`). Controls carry the caller's
  auth, so a cancelled turn's `cause` names who cancelled.
- **Deliveries are admitted at step boundaries,** because only steps write the stream. The HTTP
  202 response with the `deliveryId` stays the transport acknowledgement.
- **What a delivery did** is in the facts that cite it: `delivery.consumed {turnId, parts}` for a
  message (`parts: []` for an answer or context-only delivery), `response.submitted` for an
  answer, and the control's own fact with `cause: {deliveryId}`.
- **Steering.** A message from the turn's person, or its delegated caller, joins the open turn
  only while the model hasn't started its reply. Otherwise it waits and starts the next turn.
- **The settle rule.** A delivery settles when the work it started or joined settles:

  | Outcome          | When                                                                               |
  | ---------------- | ---------------------------------------------------------------------------------- |
  | `handled`        | The work settled. `turnId` points at the turn, whose `reply` lists the reply parts |
  | `awaiting-input` | The turn now waits on a person: an approval, a question, a sign-in, or budget      |
  | `applied`        | A control took effect                                                              |
  | `ignored`        | The channel's `deliver` hook returned nothing                                      |
  | `refused`        | Not allowed, such as an unauthenticated answer to a policy-gated approval          |
  | `failed`         | Something went wrong, including the session ending first                           |

  A turn that waits on its own tasks keeps its delivery open. The answer that resumes a paused
  turn carries the rest of the work in its own delivery.

- **User parts** are eve's own: `{kind: "text", text}` or
  `{kind: "file", mediaType, filename?, size?, ref?, url?, unavailable?}`. An image is a file
  part.

</details>

<details>
<summary>Turns and model runs</summary>

```text
turn.started     { turnId, cause, follows, trace? }
turn.paused      { turnId, awaiting: [{interactionId}] }
turn.settled     { turnId, outcome, reply?: partId[], cause?, error? }

model.requested  { runId, owner: {turnId} | {changeId} }
model.started    { runId, modelId, attempt }
model.retried    { runId, attempt, error }
model.settled    { runId, outcome, finishReason?, generationId?, error? }
```

- **Turn IDs** are deterministic (`turn_${n}` from the projection).
- **`follows`** is the turn whose context this one continues: the previous turn, or `null` after
  a clear. The `conversation()` selector walks `follows` back from the selected turn.
- **A turn pauses only for people.** `turn.paused` lists the interactions only a person can
  settle. The step that leaves the turn waiting writes it, and writes it again when someone new
  is asked. A turn waiting on tasks is still working. `waiting(view, turnId)` reads both kinds.
- **`turn.settled.reply`** lists the content parts that answer the turn.
- **A run is requested, then started.** `model.requested` lands in the commit that makes the
  next model call necessary, and `model.started` records the chosen model when the provider
  call begins. Model selection (dynamic resolvers, or reactions with #4616) runs between the
  two. A run that fails or is cancelled before starting
  settles without a `model.started`.
- **Attempts.** A failed provider attempt that published nothing writes `model.retried`, and
  the next attempt writes `model.started` again, in the same run. An attempt that published
  output can't be retried in place. Its run settles `abandoned`, and a new run continues the
  attempt count.
- **Usage** is `usage.recorded {owner: {runId}}` in the run's terminal commit, so a cancelled
  run reports what it spent.
- **A compaction's summary call** is a model run owned by the change (`owner: {changeId}`).

</details>

<details>
<summary>Content</summary>

```text
content.delta~     { partId, kind?, delta }      kind on the announcing record only
content.completed  { partId, runId, kind, value? | valueRef?, phase, interrupted?, mediaType?, fallbackText? }
```

- **Content parts are model output only.** A person's parts ride on `delivery.consumed`.
- **`kind` is open:** `text`, `reasoning`, `result`, and `file` today. `mediaType` and
  `fallbackText` let a reader show a kind it doesn't know.
- **`phase`** is `narration` (text followed by calls the turn continues with) or `reply`. Unknown
  values read as narration. Channels post on each `reply` part as it completes.
- **Interrupted versus abandoned.** A cancel completes each in-flight part with what streamed
  (`interrupted: true`). An abandoned run leaves its incomplete parts behind, and readers drop
  their previews.
- **Agent-sent files** are `kind: "file"` parts with a reference value, listed in the reply.

</details>

<details>
<summary>Calls and tasks</summary>

```text
call.input~     { callId, name?, kind?, delta }  name and kind on the announcing record only
call.requested  { callId, owner: {runId} | {callId}, capability: {kind, name, title?}, input? | inputRef? | inputError? }
call.started    { callId, clearedBy?: {policy} | {grant: {interactionId}} | {interactionId}, taskId? }
call.progress~  { callId, output, title? }       a bounded snapshot; the latest replaces earlier ones
call.settled    { callId, outcome, output? | outputRef? | outputOf?, error?, reason?, cause?, title? }

task.started    { taskId, startedBy: {callId}, kind: agent | tool, name }
task.ended      { taskId, outcome, reason?, error? }
```

- **`capability.kind`** is `tool`, `agent`, `skill`, or `control`. A `control` call is the model
  managing its own tasks (waiting on or cancelling them), which activity views usually leave
  out. Whether a call runs inline, as a workflow, remotely, or at the provider stays private.
- **Requested, then started.** `clearedBy` names the policy, the earlier grant, or the
  approval. It's absent when the call needed no approval. A call that never ran settles without
  `call.started`.
- **eve runs every local call itself,** after the model's response ends. The AI SDK only calls
  the model. Provider-executed calls are introduced and settled as the provider reports them.
- **Output appears once,** on `call.settled`. A `serve` task's one reply can settle several calls:
  the first carries the output, and the others carry `outputOf: {callId}`.
- **Outcomes:** `completed`; `failed`; `rejected` with `cause: {interactionId}` or
  `{policy: "task-limit"}`; `interrupted` with reason `turn-cancelled` or
  `authorization-required`; and `abandoned` when the run that made the call was abandoned.
- **Calls the AI SDK rejects** (an unknown tool, or input that fails the schema) never reach the
  stream, as before v27. The model hears the error and carries on. Only a provider-executed call
  eve can't resolve, or one whose input can't be presented, is introduced with `inputError` and
  settles `failed`.
- **Call IDs are unique in a session.** Some providers reuse an earlier turn's tool call ID. eve
  renames the later call (`call_0_2`) in the stream, the tables, and the model's history alike
  (#4726).
- **Nested calls** (`owner: {callId}`) appear for activity views and evals, but never enter the
  model's history.
- **A sign-in interrupts its call** (`authorization-required`). After the sign-in, the model
  calls again, as a new call.
- **Tasks.** `task.started` fires once, with the first call. Every call the task serves gets
  `call.started {taskId}` and its own `call.settled`. A task is working while any call it serves
  is open; idle `serve` tasks, which every subagent is, don't count against the 32-task cap.
- **Delegated usage** is `usage.recorded {owner: {callId}}` when the call settles, so a parent
  counts a child's usage once.

</details>

<details>
<summary>Interactions and responses</summary>

```text
interaction.opened   { interactionId, subject: {callId} | {turnId} | {taskId} | {responseId}, request, origin?, audience? }
interaction.settled  { interactionId, outcome, reason?, cause?, response? }
response.submitted   { responseId, interactionId, deliveryId, value?: {optionId?, text?} }
response.admitted    { responseId }
response.settled     { responseId, outcome, reason? }
```

- **Every request renders from common fields:**
  `{kind, prompt, title?, options?, allowFreeform?, display?, link?, signIn?}`. Options have
  `{id, label, description?, style?}`. A reader shows a kind it doesn't know from these fields.
- **Subjects:** an approval is about its call; a question about the asking call or task; a
  budget prompt about the turn; a sign-in about the held turn, a task, or a response.
- **Every answer is a response,** submitted in a delivery. Its checks end in `response.admitted`
  or `response.settled {refused | failed}`. A response that decides its interaction settles
  `applied`, and `interaction.settled.cause` names it. An answer is
  `{interactionId, optionId?, text?}` everywhere: client, channel, MCP, `eve invoke`.
- **A step's approvals settle together.** Answers are revisable until every approval in the
  batch has one, and a revision abandons the response it replaces. When the last answer arrives,
  every `interaction.settled`, with each call's `call.started` or `call.settled {rejected}`,
  lands in one commit.
- **Withdrawn, interrupted, abandoned.** A message from the turn's person withdraws its
  unanswered requests (`reason: "superseded-by-message"`), except a budget prompt, which holds
  the message until it's answered. A cancelled turn interrupts them. A newer sign-in attempt
  abandons the older one.
- **Stale answers become text.** An answer to a closed or unknown interaction reaches the model
  as the person's words, and can't approve anything. A stale answer to a budget prompt is
  dropped.
- **Policy-gated approvals** record each responder's answer as a response, attributed through its
  delivery's principal. Refused responses let channels notify the responder privately.
- **Sign-ins.** Each attempt is its own interaction, and completes through a callback delivery
  with no principal. The callback can only answer the attempt it names, and a repeated callback
  writes nothing once the attempt has settled. Its response carries no value, because the provider's payload stays
  private.
- **Relayed requests.** A child session's request becomes a parent interaction about the call
  that delegated to the child, with `origin: {sessionId, interactionId, call?}` naming the
  child's request and the call it asks about.

</details>

<details>
<summary>Children, context changes, and usage</summary>

```text
child.opened     { sessionId, owner: {callId} | {taskId}, name, stream }
context.started  { changeId, kind, turnId?, cause?, trigger?: {inputTokens} }
context.settled  { changeId, kind, outcome, selects?: null | {turnId}, error? }
usage.recorded   { owner?: {runId} | {callId} | {changeId}, kind: "model", usage }
```

- **A context change** is an operation on what the model sees next that isn't a turn. `kind` is
  `compaction` or `clear`, and is open. A threshold compaction names its turn and `trigger`; a
  manual compaction or a clear names its control delivery in `cause`. A clear writes both facts
  in one commit.
- **`selects`** is the change's effect on the conversation, so readers never branch on `kind`. A
  clear sets `null`, and the next turn `follows: null`. Compactions leave it out. A future rewind
  or branch switch would set `{turnId}`.
- **The transcript isn't the context.** The stream is what happened. What the model sees next
  stays private, so compaction summaries and cancelled-call text live only there.

</details>

### Example: a declined approval

This stream is from the edge-case integration suite, with IDs shortened and payloads trimmed.

```text
 0 facts     session.started
             delivery.admitted    {deliveryId: d0, source: {channel: "http"}}
 1 facts     turn.started         {turnId: t0, cause: {deliveryId: d0}, follows: null}
             delivery.consumed    {deliveryId: d0, turnId: t0, parts: [{kind: "text", text: "Deploy it."}]}
 2 facts     model.requested      {runId: r0, owner: {turnId: t0}}
 3 facts     model.started        {runId: r0, modelId, attempt: 0}
 4 facts     call.requested       {callId: c1, owner: {runId: r0}, capability: {kind: "tool", name: "deploy"}, input}
 5 facts     model.settled        {runId: r0, outcome: "completed", finishReason: "tool-calls"}
             usage.recorded       {owner: {runId: r0}, kind: "model", usage}
 6 facts     interaction.opened   {interactionId: i1, subject: {callId: c1}, request: {kind: "approval", …}}
 7 facts     turn.paused          {turnId: t0, awaiting: [{interactionId: i1}]}
             delivery.settled     {deliveryId: d0, outcome: "awaiting-input", turnId: t0}
             ── the answer arrives ──
 8 facts     delivery.admitted    {deliveryId: d8, source: {channel: "http"}}
 9 facts     response.submitted   {responseId: a1, interactionId: i1, deliveryId: d8, value: {optionId: "cancel"}}
             response.admitted    {responseId: a1}
10 facts     response.settled     {responseId: a1, outcome: "applied"}
             interaction.settled  {interactionId: i1, outcome: "declined", cause: {responseId: a1}, response: {optionId: "cancel"}}
             call.settled         {callId: c1, outcome: "rejected", cause: {interactionId: i1}}
11 facts     delivery.consumed    {deliveryId: d8, turnId: t0, parts: []}
12 facts     model.requested      {runId: r1, owner: {turnId: t0}}
13 facts     model.started        {runId: r1, modelId, attempt: 0}
14 progress  content.delta        {partId: p1, kind: "text", delta: "…"}
15 facts     content.completed    {partId: p1, runId: r1, kind: "text", value, phase: "reply"}
16 facts     model.settled        {runId: r1, outcome: "completed", finishReason: "stop"}
             usage.recorded       {owner: {runId: r1}, kind: "model", usage}
17 facts     turn.settled         {turnId: t0, outcome: "completed", reply: [p1]}
             delivery.settled     {deliveryId: d8, outcome: "handled", turnId: t0}
```

v26 wrote `approval.settled {cancelled}`, `input.resolved {denied}`, and
`action.result {rejected}` for the same decision. The resume signal was the next
`step.started`, and "done" was the `session.waiting` after `turn.completed`.

## The wire

### Lines

The stream route serves NDJSON (`application/x-ndjson`) with `x-eve-stream-version: 27`.
`startIndex` and `includeTailIndex` keep their meaning.

```ts
type StoredLine =
  | { at: string; facts: readonly Fact[] } // one commit
  | { progress: Progress }; // one delta or snapshot

interface Fact {
  type: FactType;
  scope?: Scope;
  data: FactData;
}
interface Scope {
  turnId?: string;
  taskId?: string;
  runId?: string;
  changeId?: string;
}
```

- **`at`** is the commit's time, for display and durations, never ordering.
- **`scope`** is stamped by the writer from the entity's owners, so readers that don't fold,
  such as log pipelines, can place a fact. It's on a progress record's announcing record only.
- **Transport records** are keyed `$eve` and never stored or counted: `heartbeat` every 10
  seconds of silence, `stream.lease-ended` when the route's 60-second lease runs out,
  `stream.ended` when the durable stream is done, and `position` markers. Readers ignore
  `$eve` records they don't recognize.
- **A position** is a line's zero-based index in the stream, the same value as `startIndex`. A
  fact's identity is its line's position plus its index in the line, so lines carry no IDs. The
  projection counts lines too, so the writer knows each line's position without reading the
  stream.
- **Line size.** The writer refuses a line over 8 MiB, below the platform's chunk limit. Each
  call settles in its own commit unless atomicity requires grouping, so lines stay small.
- **Duplicates.** A transport retry that writes a chunk twice shows up at two positions. The
  fold absorbs duplicated facts. A duplicated delta can double preview text until its part
  completes.

### Reading

- **Readers stop on facts,** never on silence. Everyone stops at `session.ended`.
  Request-scoped readers stop at their `delivery.settled`. Folding readers stop when `idle(view)`
  says nothing more will happen without another delivery.
- **Connection endings:** `stream.ended` stops; `stream.lease-ended` reconnects at once; a bare
  EOF or a read timeout reconnects with backoff.
- **Position markers** (`{"$eve": "position", "next": N}`) let the server skip lines. Readers
  handle them, but the server doesn't skip closed progress yet; that can ship in a minor.

### Observers: hooks and channels

Hooks keep `(event, ctx)`, including the `*` wildcard, and channels keep
`(event, ctx)` handlers per event type. `ctx` gains:

| Field      | Meaning                                                    |
| ---------- | ---------------------------------------------------------- |
| `position` | The line's position, and the fact's index in it            |
| `view`     | The session's tables as of the whole commit                |
| `cancel()` | (Hooks.) The turn settles `cancelled` with `cause: {hook}` |

- **Order per commit:** write, then channel handlers, then hooks. Progress goes to channels as
  it streams.
- **`ctx.view` reflects the whole commit.** Read what changed from the fact, and where things
  stand from the view.
- **A channel's `committed` handler** runs once per line, after its event handlers, for state
  that tracks the tables, such as a status, a task card, or the open prompts.
- **A `*` hook receives facts only,** not progress.
- **Invocation, not delivery.** Observers run for every fact, in order. A throwing hook is
  logged; with reactions (#4616), it fails the turn. eve doesn't guarantee that an external
  effect happened, or happened once.
- **The flush window.** `write()` resolves once the chunk is buffered. If the process dies
  inside the flush window, observers may have acted on a line that never became durable.

## The fold

### Tables

```text
SessionView @ position
├─ session        status · parent? · outcome? · error? · latestTurnId?
├─ deliveries     [deliveryId]     principal? · source? · status · turnId? · parts? · outcome?
├─ turns          [turnId]         cause · follows · status · reply? · outcome? · error?
├─ runs           [runId]          owner · modelId? · attempt? · status · finishReason? · usage?
├─ parts          [partId]         runId · kind · phase · interrupted? · value
├─ calls          [callId]         owner · capability · clearedBy? · taskId? · status · outcome? · input/output
├─ tasks          [taskId]         startedBy · kind · name · status · outcome?
├─ interactions   [interactionId]  subject · request · origin? · status · outcome? · response?
├─ responses      [responseId]     interactionId · deliveryId · value? · status · outcome?
├─ children       [sessionId]      owner · name · stream
├─ changes        [changeId]       kind · turnId? · cause? · status · outcome? · selects?
├─ usage          the total, and totals by kind
└─ selection?     the conversation's selected turn, after a context change chose one
```

Each row records the position and time of the line that introduced it (`introducedAt`,
`startedAt`) and, once ended, of the line that ended it (`closedAt`, `endedAt`). Previews of
streaming parts and calls live beside the tables, never in them.

### Selectors

`eve/events` exports `activeTurn`, `conversation`, `reply`, `failure`, `idle`, `queue`,
`waiting`, `openInteractions`, `tasks`, `callState`, `callLabel`, `callOutputSource`, and
`activity`. `activity({turnId?})` says what the session is doing now: thinking, running calls by
name, waiting on a person or on tasks, compacting, or idle. Built-in channels render status and
task cards from it.

Server code without a view folds the stream itself with the same fold. The Telegram sign-in
route and the invocation API do this, instead of scanning for events.

### Retention

- **Complete** retention keeps everything. Clients use it.
- **Operational** retention is what checkpoints and `ctx.view` hold. It keeps open entities and
  the owners they need, the latest turn, and every turn with working calls. It drops everything
  else that has closed. A settled call kept for its turn withholds an input or output over
  16,384 characters of JSON as a reference. A missing row means "not retained here", not
  "never existed".
- **No projection snapshots on the wire.** Readers fold from line 0.

## Files and large values

- **Bytes never go on the stream.** A file part carries an attachment reference (`ref`), or
  metadata plus `unavailable: true` when no store holds it.
- **Large values are "inline or reference".** Content values and call inputs and outputs can be
  a `ValueReference`: `{ref?, mediaType?, size?, preview?, withheld?}`. `withheld` marks a value
  left out on purpose, so it never reads as "no output".

## Child sessions and relays

- **Each stream describes one session.** The parent records `child.opened`, and the child's
  turns, calls, and interactions stay in the child's stream. Clients follow children with
  `AgentStreamFollower`. Child events are not forwarded into the parent stream (#666, #1725),
  because every level of nesting would copy them again.
- **A remote child's binding** (`url`, resolver) is written to a private side stream on the
  parent's run (namespace `eve.child.<childSessionId>`) before `child.opened`. The proxy route
  reads it there, so readers of the parent stream never see the remote URL.
- **Relays are their own contract,** under remote agent protocol 3, parsed tolerantly. A child
  relays each of its interaction facts, keyed by its own IDs, and the parent mirrors them. An
  answer given in the parent goes to the child, which decides, and the child's settlements
  close the parent's mirrors.

## Retries and recovery

- **In a step:** a provider attempt that published nothing retries in the same run
  (`model.retried`). One that published output abandons its run: the run settles `abandoned`,
  its calls settle `abandoned`, and a new run starts.
- **Whole steps:** when Workflow re-runs a failed step, closing an owner settles whatever the
  dead attempt left open. Reading the tail to close it exactly, and skipping facts already
  written, isn't built. It changes only the producer, so it can ship in a minor.
- **Attempts are assumed to run one after another.** A zombie writer remains an accepted risk
  until Workflow provides fencing (vercel/workflow#3811).
- **The outside world isn't repaired.** Side effects of tools that already ran aren't undone.

## Evolving after 1.0

Within stream version 27, new readers must read old lines and old readers must read new ones.

- **Readers ignore** unknown fields, fact types, progress types, and `$eve` records.
- **Outcomes are closed.** A new terminal outcome is a major change. Kinds and reasons are open:
  content, capability, interaction and context kinds, `phase`, `display`, option `style`, cause
  kinds, delivery sources, `finishReason`, error codes, and every `reason`. Each has a fallback,
  and TypeScript keeps them closed, so readers keep a default branch.
- **Minors may** add optional fields, open-set values, progress types, annotations on existing
  entities, families that reference existing entities, `$eve` records, and inline-to-reference
  moves. They may never change an existing entity's lifecycle, ownership, or the meaning of an
  existing fact.
- **Enforcement:** the stream checker in dev and tests, typechecked schemas
  (`conforming<T>()` holds each Zod schema to its TypeScript type), and `extension-contracts`
  for authoring surfaces.

## Compatibility at the break

- **Clients read v27 only.** The v21–v26 normalization is deleted.
- **Sessions don't cross the break.** A v27 deployment refuses pre-v27 checkpoints (minimum
  checkpoint version 16), so the deployment that owns an old session keeps it until it ends.
  Deliveries carry both answer shapes, so an old owner still receives answers through the
  pre-v27 shim (`execution/session-inbox/pre-v27.ts`). A v27 frontend shows an old session as
  empty.
- **Hook and channel event names break,** and their extension epochs are dropped.
  Instrumentation also moves to the stream's names (`session.ended`, `turn.settled`,
  `call.requested`/`call.settled`, `interaction.opened`/`interaction.settled`), and
  `session.waiting` is removed there too
  ([`instrumentation-session-events.md`](./instrumentation-session-events.md)).
- **Remote agent protocol 1 is deleted.** A v27 parent calling an older remote agent fails at
  call time with the existing mismatch error.
- **The legacy session import** (`execution/legacy-session/`) is still there. Whether any
  product still needs it is open.

## Where the build differs from the proposal

- **`turn.resumed` was dropped.** A resume shows as the turn's next `model.requested` or
  `delivery.consumed`, and `waiting(view, turnId)` reads what an open turn waits on.
- **`turn.paused` means waiting on people.** Task waits aren't pauses, and `awaiting` lists only
  interactions.
- **Model runs have attempts:** `model.started {attempt}` once per attempt, and
  `model.retried` between them.
- **A failed session cancels its turn,** rather than failing it, so channels post one notice.
- **Invalid calls stay hidden,** as on `main`, rather than being introduced with `inputError`.
- **eve runs every local call** after the response ends, so a call no longer runs while its
  run streams.
- **Instrumentation moved to the stream's vocabulary,** rather than keeping its own
  ([`instrumentation-session-events.md`](./instrumentation-session-events.md)).
- **The participants API became reactions** (#4616): `select`, `record`, and `render` over the
  view ([`session-reactions.md`](./session-reactions.md)).
- **Added:** the `control` capability kind, `session.started.predecessor`/`runtime`/`trace`, row
  `closedAt`, the channel `committed` handler, and titles on call progress and settlement.
- **Not built yet:** server-side catch-up skipping, whole-step recovery, `extendConversation`
  (the custom-reducer hook was removed instead), and a `session.view()` handle method.

## Directions

Each of these fits as a minor, using a mechanism the contract already has:

- **Edit, regenerate, rewind, and branch switching (#75):** new turns `follow` an earlier turn,
  and a rewind with no new turn is a context change kind that sets `selects`.
- **Forks:** `session.started.forkedFrom`.
- **Barge-in (#867):** the run settles `interrupted`, and the delivery joins the same turn.
- **Answers sent before their prompt existed (#786):** `delivery.admitted.seenThrough`.
- **Deadlines (#3546):** `expiresAt` on `interaction.opened`, settling `expired`.
- **Stop requests:** `turn.stopping` and `task.stopping`, so readers can show "Stopping…".
- **New interaction kinds:** human handoff, MCP elicitation, and forms, rendered from the
  common fields.
- **New content kinds:** media from models and tools (#3384).
- **Cancellation reasons:** a `cancel(reason)` that reaches `turn.settled` (deferred from #4616).

Realtime media transport (#637) doesn't fit, and isn't meant to: the stream records the
transcript, and media stays out of band.

### Toward a session log

The stream is the public half of a session log. The longer-run direction is to derive all
session state from entries: model history, private records, reaction results, and authored
state.

- **Two tiers, one commit.** Private entries would ride in the same commits as the public facts
  they accompany, reference public IDs, and never reach the wire.
- **State becomes folds.** The public tables, the model's context, reaction slots, and open work
  are folds. Checkpoints become snapshots, `{position, foldVersion, state}`. Steps receive a
  position and a snapshot, fold the rest, act, and commit.
- **Compaction stops being destructive,** because raw history stays in the log. Rewinding past
  a compaction needs that.
- **It can land after 1.0** without clients noticing. Each kind of private state moves
  separately: write entries beside the existing key, compare, switch readers, delete the key.
- **The hard parts:** deriving model history exactly, or prompt caching misses; where snapshots
  live on Workflow, and what reading a log suffix costs; and the volume of about 55 context keys.
- **Until then, new private state should be entry-shaped.** It goes through the commit path as
  records that could become entries. Each new ad hoc context key is a future migration.
