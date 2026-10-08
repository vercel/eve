---
issue: "None (maintainer-requested research)"
status: draft
last_updated: "2026-10-08"
---

# Session event lifecycle

Companion docs:

- [`dynamic-participants.md`](./dynamic-participants.md) makes dynamic resolvers and memory providers functions over real events, using an event this proposal adds. Its pipeline is independent of this proposal; its API change ships with it.
- [`session-machine-simplification.md`](./session-machine-simplification.md) covers structural cleanup in the session machine. Two of its items help this proposal land.

## Introduction

Every eve reader folds the same session stream:

- the web and React clients, and the dev TUI;
- Slack and the other channels;
- evals, ACP, and the invocation API;
- authored hooks;
- the server's own projection.

Today that stream has 34 event types, added one feature at a time. Most of them say that something happened, but few entities have a recorded beginning and a recorded end. So readers reconstruct lifecycles from timing, text, and events that didn't arrive. Each reader does it slightly differently, and it is often impossible to do this unambiguously.

This proposal replaces the vocabulary at the next stream-version break (v27). The goal is a smaller conceptual framework where every piece of the system has an explicit lifecycle:

- **Ten entities:** `session`, `delivery`, `turn`, `model run`, `content part`, `call`, `task`, `interaction`, `response`, and `context change`. Each one is introduced by one fact and closed by exactly one terminal fact, with an outcome from a closed set.
- **Lifecycles are not inferred** When the machine ends something, it produces an event that records this in the same commit, including events for other things that are ended at the same time.
- **One commit per stream line** Multiple facts that happen atomically share a single stream line, and the session projection retains its own counter for stream position. This means events no longer need to be stamped with ULIDs (instead they get literal stream indicies) and readers resume exactly.
- **Additive evolution after the break** New kinds, fields, and families don't need a version bump, and older readers stay correct ([Future proofing](#future-proofing)).

The proposed catalog has 30 types (27 facts and 3 progress types), down from 34. Compatibility is cut on purpose: v27 clients read v27 streams only, and sessions don't cross the break.

### Where the contract lives

Today the event contract has no single home. Its pieces are spread across the package, and several readers re-derive parts of it:

| Piece              | Today                                                                                                                                                                                                                     | With this proposal                                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Types and encoding | `protocol/message.ts` (2,018 lines): types, 34 builders, encoding, headers. `message-version.ts` normalizes v21–v26, and `event-id.ts` and `event-dedupe.ts` handle `meta.id`                                             | `protocol/session-events/`: Zod schemas per family, the envelope, a runtime catalog, and a checker. Producers build typed literals, and old versions are deleted                                      |
| Lifecycle state    | The server projection (`protocol/session-projection.ts`) and the client reducers (`message-reducer*.ts`, `conversation-reducer.ts`) fold separately. `TurnSegment` and `message-response.ts` add their own boundary rules | One public fold with typed tables and selectors, shared by client and server                                                                                                                          |
| Readers' own folds | Telegram's sign-in lookup, the invocation API's 64-event window, evals (`derive-run-facts.ts`), ACP, and the TUI                                                                                                          | Selectors over the shared fold                                                                                                                                                                        |
| Authoring surfaces | Hook and channel event maps (`public/definitions/`); dynamic resolver and memory keys reuse event names                                                                                                                   | Hook and channel maps keyed by the catalog's events; dynamic resolvers and memory providers as functions over the events their kind receives ([`dynamic-participants.md`](./dynamic-participants.md)) |
| Parent–child relay | `subagents/callback-route.ts` re-declares v26 event shapes with strict schemas                                                                                                                                            | Its own tolerant relay contract, keyed by child IDs                                                                                                                                                   |

After the break, a new fact or field touches one family module. The checker, the old-reader conformance test, and `extension-contracts` catch drift ([The contract module](#the-contract-module), [Evolving safely after 1.0](#evolving-safely-after-10)).

### What the current model leaves out

v26 leaves readers to guess when a response is done, how a decision ended, when to stop reading, and more.

<details>
<summary>Nine guesses readers make today</summary>

| Readers guess                                     | Example                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| When a response is done                           | `send()` matches events by `meta.deliveryIds`, which answers resumed through tools, workflows, or child sessions don't carry, so `respond()` ends "at its first turn boundary". The invocation API, CLI `invoke`, and evals each define "done" their own way                                 |
| Whether a message was queued, ignored, or refused | A queued message, one the channel ignores, and one refused for lack of authentication leave no record. A message held behind the budget prompt needed an "announced?" flag                                                                                                                   |
| How one decision ended                            | A declined approval writes `approval.settled {cancelled}`, `input.resolved {denied}`, and `action.result {rejected}`. The first shared fold (#4141) read `cancelled` as a withdrawal, and ACP dropped the reason because `input.resolved` settled the call before `action.result` carried it |
| Whether a sign-in completed                       | Telegram's sign-in callback (`findPendingAuthorization`) takes the latest `authorization.required` without checking whether it completed                                                                                                                                                     |
| When to stop reading                              | Nothing on the stream says stop. Clients give up after five empty reconnects (`streamIdleReconnectPolicy`), `keepAlive` and the agent follower make that infinite, and runs that end without closing their stream (#3221) look like idle sessions                                            |
| A work outcome, from the model's receipt          | A task call's `action.result` is a receipt. Evals take its status as the call's outcome, while channel task cards special-case receipts so the call keeps running until `task.settled`                                                                                                       |
| Which text is the reply                           | About a dozen places (channel defaults, evals, the invocation API, the client) test `message.completed.finishReason !== "tool-calls"`. Text in a held step is reported as `tool-calls` to hide it                                                                                            |
| An entity nobody introduced                       | A resumed approved call's result arrives with no request before it. A tool call with invalid input gets a failed `action.result` without ever appearing in `actions.requested`                                                                                                               |
| What coordinates mean                             | Payloads repeat `turnId`, `sequence`, and `stepIndex`. A relayed child request's coordinates have meant the child's turn and step in one version, and the parent's serving call in another                                                                                                   |

</details>

## The model

### Entities

| Entity         | What it is                                                        | Introduced by        | Ends with             |
| -------------- | ----------------------------------------------------------------- | -------------------- | --------------------- |
| Session        | A durable conversation and its ongoing work                       | `session.started`    | `session.ended`       |
| Delivery       | One submitted message, answer, control, or sign-in callback       | `delivery.admitted`  | `delivery.settled`    |
| Turn           | Agent work that can pause and resume                              | `turn.started`       | `turn.settled`        |
| Model run      | One logical model invocation                                      | `model.requested`    | `model.settled`       |
| Content part   | One block of model output: text, reasoning, a result, a file      | `content.completed`  | `content.completed`   |
| Call           | One invocation of a tool, agent, or skill                         | `call.requested`     | `call.settled`        |
| Task           | Work that outlives an immediate return                            | `task.started`       | `task.ended`          |
| Interaction    | An approval, question, sign-in, or budget prompt                  | `interaction.opened` | `interaction.settled` |
| Response       | One answer to an interaction, from a person or a sign-in callback | `response.submitted` | `response.settled`    |
| Context change | An operation on what the model sees next: a compaction or a clear | `context.started`    | `context.settled`     |

Two smaller records hang off these:

- **Child links** record a call or task that opened a child session (`child.opened`). The child's own lifecycle lives in its own stream.
- **Usage records** (`usage.recorded`) attribute model and other usage to the run, call, or context change that spent it. They have no lifecycle.

Every entity records where it came from when it's introduced:

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
├─ Context change (turn: the one it ran in, if any)
│    └─ Model run (a summary)
└─ Task (can outlive turns)
     ├─ Interaction (question, sign-in)
     └─ Child session link
```

**Owners and containers.** An entity's owner records where it came from, and never changes. What closes it is its container: runs and their parts close with their turn or context change; calls and interactions stay open after their run settles, until the turn or task they belong to ends; tasks can outlive turns, and end before `session.ended`.

### Three kinds of records

|             | Facts                                                   | Progress                                       | Private records                                       |
| ----------- | ------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------- |
| Examples    | `call.settled`, `interaction.opened`                    | `content.delta`, `call.input`, `call.progress` | Suspended steps, answer routes, grants, model history |
| On the wire | Yes, grouped by commit                                  | Yes, one per line                              | Never                                                 |
| Meaning     | A decision the machine made, or an accepted observation | A preview of a value that a fact will complete | Execution payloads and handles                        |
| Folded into | The lifecycle tables                                    | Previews only                                  | Execution state                                       |

### Lifecycle rules

1. **Introduce before reference.** A fact references an entity only after the fact that introduces it. The one exception: while its model run is open, a progress record may announce a content part or call before the fact that introduces it. This is because progress records don't contribute to facts directly. The `content.completed` record contains the entire message, and requiring us to encode the entire start/completion lifecycle event stack for each bit of content would make all of our text/reasoning flows do an additional durable write / pass through channels and hooks.
2. **Exactly one terminal event.** Each entity has one terminal type with an outcome from a closed set. If a malformed stream has two, the first wins.
3. **Explicit closure.** When the machine ends something, it emits terminal events in the same commit for everything that ends with it. Nothing is closed by inference.
4. **No lifecycle inference.** No reader derives lifecycle from output text, `isError`, a missing event, or progress.
5. **All transitions are atomic** Whenever a transition happens (e.g. turn closing), all facts about that (turn closed, approval abandoned, etc.) are computed and committed as a single line in the session history. The shape of that line is `{ 'at': <timestamp>, 'facts': [<event1>, <event2>, ...]}`.

### Outcomes

Verbs follow a few rules:

- **Introductions.** `requested` when an entity still needs a decision before it can run, such as a model run's model and tools or a call's clearance, followed by `started` when it runs. `started` alone when it runs from the start. `opened` when it waits on a person. `submitted` for an answer, and `admitted` for input that passed its checks.
- **Terminals.** Things that resolve once settle: deliveries, turns, model runs, calls, interactions, responses, and context changes. Long-lived containers that go idle and are reused end: sessions and tasks. Content parts arrive `completed`.
- **Families are single words,** and a type is `family.verb`. A family named after a resource stands for operations on it: `model` for model runs, `context` for context changes. Each type's role (introduces, updates, terminal) is catalog metadata, so readers can handle families generically without parsing verbs.

Terminal outcome sets are closed for the life of the major version:

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

<details>
<summary>Glossary</summary>

| Word           | Meaning                                                                     | Used by                                               |
| -------------- | --------------------------------------------------------------------------- | ----------------------------------------------------- |
| accepted       | The answer was taken                                                        | interaction                                           |
| declined       | A person said no                                                            | interaction                                           |
| refused        | Policy said no                                                              | response, delivery                                    |
| invalid        | The answer didn't fit the request                                           | interaction                                           |
| withdrawn      | The asker no longer needs it; `reason` says why                             | interaction, response                                 |
| expired        | Time ran out                                                                | interaction, response                                 |
| failed         | Something went wrong                                                        | every family                                          |
| completed      | Finished normally                                                           | session, turn, model run, call, task, context change  |
| cancelled      | Someone stopped it directly                                                 | turn, task, context change                            |
| interrupted    | Cut off because something it depends on stopped                             | model run, call, content, interaction, context change |
| rejected       | Never ran because of a decision; `cause` says whose                         | call                                                  |
| abandoned      | Replaced by a newer instance: a retry, a newer attempt, or a revised answer | model run, call, interaction, response                |
| handled        | The work a delivery started or joined settled                               | delivery                                              |
| awaiting-input | Further progress needs a person's input                                     | delivery                                              |
| applied        | A control took effect, or a response decided its interaction                | delivery, response                                    |
| ignored        | The channel chose not to deliver it                                         | delivery                                              |

</details>

## Event catalog

### The 30 types

`~` marks progress: streamed between commits and never folded into the lifecycle tables.

| Type                  | Entity         | Role                 | Replaces in v26                                                 |
| --------------------- | -------------- | -------------------- | --------------------------------------------------------------- |
| `session.started`     | Session        | Introduces           | `session.started`                                               |
| `session.ended`       | Session        | Terminal             | `session.completed`, `session.failed`                           |
| `delivery.admitted`   | Delivery       | Introduces           | **New** (only `meta.deliveryIds` before)                        |
| `delivery.consumed`   | Delivery       | Updates              | `message.received`                                              |
| `delivery.settled`    | Delivery       | Terminal             | **New** (inferred from turn boundaries before)                  |
| `turn.started`        | Turn           | Introduces           | `turn.started`                                                  |
| `turn.paused`         | Turn           | Updates              | `turn.waiting`                                                  |
| `turn.resumed`        | Turn           | Updates              | **New** (the next `step.started` before)                        |
| `turn.settled`        | Turn           | Terminal             | `turn.completed`, `turn.failed`, `turn.cancelled`               |
| `model.requested`     | Model run      | Introduces           | **New** (resolvers ran on a preview of `step.started` before)   |
| `model.started`       | Model run      | Updates              | `step.started`; **new** for compaction summary calls            |
| `model.settled`       | Model run      | Terminal             | `step.completed`, `step.failed`                                 |
| `content.delta~`      | Content part   | Progress (announces) | `message.appended`, `reasoning.appended`                        |
| `content.completed`   | Content part   | Introduces and ends  | `message.completed`, `reasoning.completed`, `result.completed`  |
| `call.input~`         | Call           | Progress (announces) | `action.input.appended`                                         |
| `call.requested`      | Call           | Introduces           | `actions.requested`, now one fact per call                      |
| `call.started`        | Call           | Updates              | **New** (per-call `task.started` before, for task calls)        |
| `call.progress~`      | Call           | Progress             | `action.partial`                                                |
| `call.settled`        | Call           | Terminal             | `action.result`, and `task.settled` for the calls a task serves |
| `task.started`        | Task           | Introduces           | `task.started`, now once per task                               |
| `task.ended`          | Task           | Terminal             | **New**                                                         |
| `interaction.opened`  | Interaction    | Introduces           | `input.requested`, `authorization.required`                     |
| `interaction.settled` | Interaction    | Terminal             | `input.resolved`, `approval.settled`, `authorization.completed` |
| `response.submitted`  | Response       | Introduces           | `approval.candidate` with `pending`; **new** for other answers  |
| `response.admitted`   | Response       | Updates              | **New** (private batch state before)                            |
| `response.settled`    | Response       | Terminal             | `approval.candidate` with any other outcome                     |
| `child.opened`        | Child link     | Introduces           | `agent.started`                                                 |
| `context.started`     | Context change | Introduces           | `compaction.requested`; **new** for a clear                     |
| `context.settled`     | Context change | Terminal             | `compaction.completed`, `context.cleared`                       |
| `usage.recorded`      | Usage record   | Record               | `usage` on step, turn, and session events                       |

`session.waiting` goes away, from the stream and from hooks and channels. Readers ask the `idle` selector instead, and observers key on the fact that ends the work ([Observers](#observers-hooks-and-channels)).

### Why the new types exist

Each new type records something v26 left for readers to infer:

- **`delivery.admitted`:** a message, answer, control, or sign-in callback was admitted. Without it, a queued message is invisible until a turn consumes it, and a refused or ignored one is invisible forever.
- **`delivery.settled`:** the response to a delivery is complete, and how it ended. It replaces every reader's version of "the turn boundary that belongs to my message", including `respond()`'s first-boundary fallback.
- **`turn.resumed`:** the turn left a pause, and why (a delivery, or finished tasks). Before, the only signal was the next `step.started`, and approved calls that ran before the next model call had no resume at all.
- **`model.requested`:** the turn decided to call the model, before the model and tools are chosen. Dynamic resolvers run on it; before, they ran on a hand-built preview of `step.started`, because the published one already carried the chosen model.
- **`call.started`:** the call was cleared and began running, and what cleared it, or which task serves it. Before, a call waiting for approval looked like a running one, an auto-approved call looked like one a grant cleared, and "the call was handed to a task" was conflated with "the call completed" in the receipt.
- **`task.ended`:** the task itself stopped. v26 settled each call a task served, but the task had no end, so "is this subagent still alive?" was a guess.
- **`response.submitted`, `.admitted`, and `.settled`:** every answer to an interaction, from submission through its checks to whether it decided the interaction. Before, policy-gated answers were candidates, partial batch answers lived only in private state and a client overlay, and sign-in completions were callbacks outside the delivery model.
- **`usage.recorded`:** the only carrier of usage, attributed to the run, call, or context change that spent it, or to nothing, as for cache warming. Before, usage rode on step, turn, and session events, and delegated usage was easy to count twice.
- **`context.started` and `.settled`:** one lifecycle for operations on what the model sees next. v26 gave compaction a start and a success, but no failure and no usage for its summary call (#3483), and recorded a clear on its own. Future rewinds, branch switches, and context edits become new kinds, not new families.

<details>
<summary>Every v26 type and where it goes</summary>

```text
v26                              v27
session.started ───────────────▶ session.started        parent?: {sessionId, callId}
session.completed ─┬───────────▶ session.ended          {completed | failed}
session.failed ────┘
session.waiting ───────────────▶ ✕ removed: the idle selector; observers use delivery.settled, turn.settled, or idle(ctx.view)
(meta.deliveryIds) ────────────▶ delivery.admitted · delivery.consumed · delivery.settled
message.received ──────────────▶ delivery.consumed      {turnId, parts}

turn.started ──────────────────▶ turn.started           {cause, follows}; no sequence
turn.waiting ──────────────────▶ turn.paused            {awaiting}
(the next step.started) ───────▶ turn.resumed           {cause}
turn.completed ─┐
turn.failed ────┼──────────────▶ turn.settled           {completed | failed | cancelled, reply?}
turn.cancelled ─┘

step.started ──────────────────▶ model.requested        {runId, owner: {turnId}}
                                 model.started          {runId, modelId}, once the model is chosen
step.completed ─┬──────────────▶ model.settled          {outcome, finishReason, generationId}
step.failed ────┘
(usage on step, turn, session) ▶ usage.recorded         {owner?, kind, usage}
compaction.requested ──────────▶ context.started        {changeId, kind: "compaction", trigger}
(the summary model call) ──────▶ model.requested · model.started · model.settled   owner: {changeId}
compaction.completed ──────────▶ context.settled        {kind, completed | failed | cancelled | interrupted}
context.cleared ───────────────▶ context.started + .settled   {kind: "clear", selects: null}

message.appended ──────┐
reasoning.appended ────┴───────▶ content.delta~         {partId, kind, delta}
action.input.appended ─────────▶ call.input~            {callId, name, delta}
message.completed ───┐
reasoning.completed ─┼─────────▶ content.completed      {partId, kind, value, phase, interrupted?}
result.completed ────┘

actions.requested ─────────────▶ call.requested         one per call; capability, not dispatch
(clearance, private before) ───▶ call.started           {clearedBy?, taskId?}
action.partial ────────────────▶ call.progress~
action.result ─────────────────▶ call.settled           the only place a call's output appears
task.started ──────────────────▶ task.started (once) + call.started {taskId} (every call it serves)
task.settled ──────────────────▶ call.settled (+ task.ended when the task stops)
agent.started ─────────────────▶ child.opened

input.requested ─────────┐
authorization.required ──┴─────▶ interaction.opened     {kind: approval | question | budget | sign-in}
approval.candidate ────────────▶ response.submitted · response.settled
(private pending answers) ─────▶ response.admitted
(sign-in callbacks) ───────────▶ delivery.admitted {source: callback} + response.*
input.resolved ──────────┐
approval.settled ────────┼─────▶ interaction.settled    one terminal; one closed outcome set
authorization.completed ─┘
```

</details>

### Payloads by family

<details>
<summary>Sessions</summary>

```text
session.started     { parent?: {sessionId, callId} }
session.ended       { outcome: completed | failed, cause?, error? }
```

- Every reader stops at `session.ended`. Nothing after it counts.
- **Redeploys write nothing.** When a newer deployment takes an idle session over, eve re-runs session-scoped resolvers with the session's original `session.started` ([`dynamic-participants.md`](./dynamic-participants.md)). A marker for readers can come later as a minor ([Directions that fit](#directions-that-fit)).
- A failed session references what failed, for example `cause: {turnId}`; the error details live on that entity.
- The ending commit settles every delivery that was admitted but not settled, with `failed` and `reason: "session-ended"`, and settles any open context change `interrupted`. Inbox payloads that were never read were never introduced, so `session.ended` is their only signal.
- A reset ends the session, not the channel's conversation. Following the conversation into its next session is the channel's job, outside the stream contract.

</details>

<details>
<summary>Deliveries</summary>

```text
delivery.admitted  { deliveryId, principal?, source?: {channel, scheduleId?, caller?} | {control} | {callback}, clientContext? }
delivery.consumed  { deliveryId, turnId, parts }
delivery.settled   { deliveryId, outcome, turnId?, reason? }
```

- **What a delivery is.** It's the `deliveryId` minted for each inbound operation (`channel/delivery-metadata.ts`): HTTP sends, channel webhooks, schedules (as the app principal), parent-to-child messages, controls, and sign-in callbacks.
- **No declared kind.** The facts that cite a delivery record what it did:

  | Effect         | Recorded as                                                             |
  | -------------- | ----------------------------------------------------------------------- |
  | A message      | `delivery.consumed {turnId, parts}`                                     |
  | Context only   | `delivery.consumed {turnId, parts: []}`; the notice text stays private  |
  | An answer      | `response.submitted {deliveryId}`, for a question, approval, or sign-in |
  | A control      | That control's fact, with `cause: {deliveryId}`                         |
  | `outputSchema` | Private                                                                 |

- **Admitted at step boundaries.** The session admits deliveries in the workflow body, and only steps write the stream. So `delivery.admitted` lands in the next step's first commit. During a running turn that's up to one model call late. HTTP's 202 with the `deliveryId` stays the transport acknowledgement, and clients keep their optimistic local submission.
- **Folded deliveries** admitted together each get their own `delivery.consumed` and `delivery.settled` (#3313).
- **Steering is visible at consumption.** A delivery steered into the open turn names that turn; a queued one is consumed by the next turn. Only the turn's principal, or its delegated caller, steers.
- **What resumes a paused turn:** only a message from the turn's own person, or an answer. A context-only delivery never resumes a turn or withdraws its requests (#4276). It waits, is consumed when the turn next runs, and starts the next turn if the paused one is cancelled or cleared.
- **Controls are deliveries.** Cancel, clear, compact, and reset get an ID and carry the caller's auth, so `turn.settled {cancelled, cause}` names who cancelled. Today `SessionCommand` carries neither.
- **Sign-in callbacks are deliveries,** with three differences from a send:
  - **No principal.** The identity provider redirects a browser, and the callback route drops request headers on purpose. Whoever holds the link can complete it, as today. Attribution follows `source`, so a callback is never credited to the session's principal, the way other deliveries without auth are.
  - **Narrow.** A callback answers only the sign-in attempt it names. It never steers, starts a turn, or withdraws anything, and it's admitted ahead of queued messages.
  - **Once per attempt.** The `deliveryId` derives from the attempt, so a repeated callback, from a browser refresh or a route retry, is dropped at admission and leaves no trace beyond server logs. That also keeps an unauthenticated route from adding lines at will.
- **`deliver` shapes only the channel's own sends.** The channel's `deliver` hook runs for sends from the session's channel, as today. Controls and callbacks never pass through it, so only a channel send can settle `ignored`.
- **User parts** use eve's own schema, not the AI SDK's: `{kind: "text", text}` or `{kind: "file", mediaType, filename?, size?, ref?}`, plus an explicit unavailable marker. Image inputs are file parts. `textOf(parts, {files: "placeholder" | "omit"})` replaces the flattened `message` string.

**The settle rule.** A delivery settles when the work it started or joined settles, or when the session can make no more progress for it without another delivery.

| Outcome          | When                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| `handled`        | The work it started or joined settled. `turnId` points at the turn, whose `reply` lists the reply parts |
| `awaiting-input` | Further progress needs a person's input: an answer or a sign-in                                         |
| `applied`        | A control took effect. A clear or compact settles `applied` once its context change completes           |
| `ignored`        | The channel's `deliver` hook returned nothing                                                           |
| `refused`        | Not allowed, such as an unauthenticated answer to a policy-gated approval                               |
| `failed`         | Something went wrong, including the session ending first                                                |

- **Answers join the work they resume.** An answer settles `handled` when the resumed turn settles, or `awaiting-input` if the turn stops again.
  - An answer that doesn't complete its approval batch settles `awaiting-input` at once.
  - An answer to an interaction whose subject has no open turn settles `applied`.
- **Only task waits keep a delivery open.** A turn parked on working tasks continues the same work when they finish, so its delivery stays open. Every other pause (approvals, questions, sign-ins, budget prompts) settles it `awaiting-input`, and the answer's delivery carries the resumed work. CLI `invoke` and the invocation API stop at `delivery.settled`, and read the prompt or sign-in link from the open interaction.

</details>

<details>
<summary>Turns and model runs</summary>

```text
turn.started     { turnId, cause, follows }
turn.paused      { turnId, awaiting: [{interactionId} | {callId} | {taskId}] }
turn.resumed     { turnId, cause }
turn.settled     { turnId, outcome, reply?: partId[], cause?, error? }

model.requested  { runId, owner: {turnId} | {changeId} }
model.started    { runId, modelId }
model.settled    { runId, outcome, finishReason?, generationId?, error? }
```

- **Turn IDs** stay deterministic (`turn_${n}` from the projection). Retry recovery relies on that.
- **`follows`** is the turn whose context this one continues: the previous turn, or `null` after a clear. Readers render the conversation through the `conversation()` selector, which walks `follows` back from the selected turn, not through line order. The selected turn is the newest one, unless a later context change set `selects`.
- **`turn.paused.awaiting`** lists what the turn waits on.
- **`turn.resumed`** is emitted wherever the machine leaves a pause, including when approved calls run before the next model call.
- **`turn.settled.reply`** lists the parts that answer the turn: text, a structured result, or files. Deliveries reach it through `delivery.settled.turnId`, so folded deliveries share one reply.
- **Runs have IDs.** `sequence` and `stepIndex` leave every payload. The client derives a per-turn step ordinal for display.
- **A run is requested, then started.** `model.requested` lands in the commit that makes the next model call necessary: the turn's start, the last call result, an answer, or steering. Model participants run after it, and `model.started` records the model they chose when the provider call begins. A run that fails before starting settles `failed`, and one cancelled first settles `interrupted`, without a `model.started`.
- **Run outcomes:** `completed`; `failed`; `interrupted`, for a cancel (later also steering or barge-in); and `abandoned`, when a retry superseded the run. Usage is a `usage.recorded {owner: {runId}}` in the run's terminal commit, so a cancelled run reports what it spent (#952).
- **Runs belong to a turn or a context change.** A compaction's summary call is a model run owned by the change, so its usage counts like any other run's, including attempts whose summary is rejected (#3483). It uses `compactionModel` if one is configured, otherwise the model the turn's current run chose; between turns, the model participants run on its `model.requested` ([`dynamic-participants.md`](./dynamic-participants.md)).

</details>

<details>
<summary>Content</summary>

```text
content.delta~     { partId, kind, delta }                 the first record announces the part
content.completed  { partId, runId, kind, value, phase, interrupted? }
```

- **Content parts are model output only.** A user's parts ride on `delivery.consumed`.
- **`kind` is open:** text, reasoning, structured results, and files today.
- **Announce, then introduce.** `content.delta` announces a part with its first delta, and `content.completed` introduces it with its full value.
- **`phase` marks narration versus reply.** `narration` is text followed by calls the turn continues with, including text in a step held for approvals; `reply` ended the run. Channels act on it as each part completes, and `turn.settled.reply` is the final word.
- **Interrupted versus abandoned:**
  - **Interrupted:** a cancel stops the output deliberately, and what was said stands. The cancellation path completes each in-flight part with what streamed (`interrupted: true`), then settles the run `interrupted`. Whether that text enters the model's context stays producer behavior; today it doesn't.
  - **Abandoned:** a retry superseded the attempt. The run's terminal leaves its incomplete parts behind, and readers drop their previews.
- **Agent-sent files** are content parts: `content.completed {kind: "file", value: {ref, mediaType, filename, size}, phase: "reply"}`, owned by the run that sent them and listed in `turn.settled.reply`.
- **Notices that aren't model output become delivery outcomes.** "Authentication is required to respond to this approval." becomes `delivery.settled {refused, reason}`.

</details>

<details>
<summary>Calls</summary>

```text
call.input~     { callId, name, delta }                     the first record announces the call
call.requested  { callId, owner: {runId} | {callId}, capability: {kind, name, title?}, input? | inputError? }
call.started    { callId, clearedBy?: {policy} | {grant: {interactionId}} | {interactionId}, taskId? }
call.progress~  { callId, output }                          a bounded snapshot; the latest replaces earlier ones
call.settled    { callId, outcome, output? | outputOf?, error?, reason?, cause? }
```

- **Output appears once, on `call.settled`.** What the model saw isn't published separately: for a sync call it's the output; a task call's receipt is implied by `call.started {taskId}`; denial and cancel text follows from `reason`.
- **Requested, then started.** `call.requested` records what the model asked for, and `call.started` records that the call was cleared and began. `clearedBy` names the policy, the grant (the earlier interaction that granted it), or the approval, and is absent when the call needed no approval. A call that never ran settles without a `call.started`. Calls the AI SDK runs while streaming get both facts in one commit.
- **Outcomes:**
  - `completed`;
  - `failed`, for an execution error or invalid input;
  - `rejected`, with `cause: {interactionId}` or `{policy}`;
  - `interrupted`, with reason `turn-cancelled` or `authorization-required`;
  - `abandoned`, when a retry superseded the attempt and eve can't tell whether the tool ran.
- **Every call the model made is introduced.** When validation fails, `call.requested` carries `inputError` instead of `input`, and `call.settled {failed}` follows. If the run ends before a call announced by `call.input` is requested, the run's terminal abandons the preview; a call that was never requested never ran.
- **Calls settle by what actually happened, as far as eve can tell.** The AI SDK runs tools while it streams. When emission can tell that a tool ran and has its output, the call settles `completed` or `failed`, even if the run is then abandoned. When it can't, the call settles `abandoned`.
- **Each call settles in its own commit,** unless atomicity requires grouping (an approval batch, whose facts are small). That keeps every line no larger than today's largest event.
- **Nested calls** (for example, the connection calls `connection_execute` makes) have `owner: {callId}`. They appear for activity views and evals but never enter the model's history.
- **Sign-ins:** a call that needs a sign-in settles `interrupted` with `authorization-required`. After the sign-in the model calls again, and that's a new call.
- **Capability, not dispatch.** `capability.kind` is open (`tool`, `agent`, `skill` today). Whether a call runs inline, as a workflow, remotely, or at the provider stays private.
- **Task-limit refusals are rejections:** `call.settled {rejected, cause: {policy: "task-limit"}}`, so readers no longer special-case `TOO_MANY_TASKS` failures (`isTaskRetryRefusal`).
- **Delegated usage** is a `usage.recorded {owner: {callId}}` in the commit that settles the call, never on `task.ended`, so a parent counts a child's usage once.

</details>

<details>
<summary>Tasks</summary>

```text
task.started    { taskId, startedBy: {callId}, kind: agent | tool, name }
call.started    { callId, taskId }                          every call the task serves, including the first
call.settled    { callId, outcome, output? | outputOf? }
task.ended      { taskId, outcome: completed | failed | cancelled, reason? }
```

- **One start, one end.** `task.started` fires once, when the first call starts the task. Each call the task serves gets `call.started {taskId}` and later its own `call.settled`.
- **One reply, several calls.** A `serve` task's `ctx.reply(output)` settles every call received so far with one output. The first call's `call.settled` carries it, and the others carry `outputOf: {callId}`.
- **When a task ends:** its body returns or throws; 30 seconds pass after a cancel it doesn't return from; or the session ends, before `session.ended`.
- **Working versus idle** is a selector: a task is working while any call it serves is unsettled. The 32-task cap counts working tasks only. Idle `serve` tasks, which every subagent is, don't count.
- **This replaces** the per-call `task.started` and `task.settled` from [`eve-tasks.md`](./eve-tasks.md).

</details>

<details>
<summary>Interactions and responses</summary>

```text
interaction.opened   { interactionId, subject, request, origin?, audience? }
interaction.settled  { interactionId, outcome, reason?, cause?, response? }
response.submitted   { responseId, interactionId, deliveryId, value? }
response.admitted    { responseId }
response.settled     { responseId, outcome, reason? }
```

The family follows HumanInput's request model: one interaction per request.

- **Requests render without knowing their kind.** Every request carries `{kind, prompt, title?, options?, allowFreeform?, display?, link?}`, extending today's `InputRequest`, plus kind-specific fields.
- **One closed outcome set for every kind.** Kind-specific detail rides on `response`.

  | Kind     | Subject                                                | Outcomes                                                                |
  | -------- | ------------------------------------------------------ | ----------------------------------------------------------------------- |
  | approval | Its call                                               | accepted, declined, invalid, withdrawn, interrupted, abandoned, expired |
  | question | The asking call, or the task whose run asked           | accepted, withdrawn, interrupted, expired                               |
  | sign-in  | The held turn, the task whose run asked, or a response | accepted, declined, failed, withdrawn, interrupted, abandoned, expired  |
  | budget   | The turn                                               | accepted, declined, withdrawn, interrupted                              |

- **Outcomes say how a request ended, without parsing reasons:**
  - `withdrawn` when the asker no longer needs an answer, such as after a steering message (`reason: "superseded-by-message"`);
  - `interrupted` when its owner stopped: the turn was cancelled, or the owner ended;
  - `abandoned` when a newer instance replaced it: a newer sign-in attempt, or a retried step.

  Channels map these straight to card states: "no longer needed", "cancelled", or replaced by the newer card.

- **Every answer is a response.** A person's answer, or a sign-in callback, arrives as a delivery and becomes `response.submitted`. Its checks (policy, the responder's sign-in) end in `response.admitted`, or in `response.settled {refused | failed}`. A response that decides its interaction settles `applied` in the same commit as `interaction.settled`, whose `cause` names it. A deciding answer that needs no checks writes all of this in one commit.
- **A step's approvals settle together.**
  - Answers are revisable until every approval in the step has one.
  - An admitted answer that leaves the batch incomplete stays open as `response.admitted`. Readers show the latest admitted response as pending; it isn't permission to execute. A revision is a new response, and the one it replaces settles `abandoned`.
  - When the last answer arrives, the deciding responses settle `applied`, and every `interaction.settled`, with the matching `call.started` approvals and `call.settled` rejections, lands in one commit.
  - A steering message from the turn's person withdraws the unanswered approvals, and answers already given stand.
- **No settlement by inference.** A decline is one commit with `interaction.settled {declined}` and `call.settled {rejected, cause: {interactionId}}`.
- **Each sign-in attempt is its own interaction.** A newer attempt settles the older one `abandoned`. A sign-in's subject is the turn, because the calls that asked leave the step and the model calls them again.
- **A sign-in completes through a callback delivery** ([Deliveries](#payloads-by-family)). Its response carries no `value` on the wire, because the identity provider's payload stays private.
- **`invalid` stays terminal,** as today: the answer named an option the approval doesn't offer, and the call doesn't run.
- **Policy-gated approvals** record each responder's answer as a response, attributed through its delivery's principal. Slack uses refused responses to notify the responder privately. Only `interaction.settled` closes the interaction, and other open responses settle `withdrawn` when it settles another way.
- **Relayed requests:** a request from a child session or workflow run has the parent's serving call as its subject, and `origin: {sessionId, interactionId}` names the child's request. Relays chain hop by hop ([Child sessions and relays](#child-sessions-and-relays)).
- **Who answered** joins through the response's delivery and its principal. Sign-in challenge fields (`url`, `userCode`, the callback URL) carry over, visible to the same readers as today.

</details>

<details>
<summary>Children and context changes</summary>

```text
child.opened     { sessionId, owner: {callId} | {taskId}, name, stream }
context.started  { changeId, kind, turnId?, cause?, trigger? }
context.settled  { changeId, kind, outcome, selects?, error? }
```

- **`child.opened`** links a child session. Where a remote child runs, and which credential resolver reaches it, stays off the stream ([Child sessions and relays](#child-sessions-and-relays)).
- **Transcript versus context.** The **transcript** is what happened: the stream, append-only. The **context** is what the model sees next. It stays private, so framework messages, cancelled-call text, and compaction summaries live only there, while nested calls and interrupted text live only in the transcript.
- **A context change is an operation on the context that isn't a turn.** `kind` is open: `compaction` and `clear` today.
  - Every change writes both facts. A clear is instant, so both land in one commit. `kind` repeats on `context.settled`, so readers and guards that don't fold can tell a failed compaction from a failed clear.
  - Every compaction is visible, including one that only reorganizes memory records or prunes tool results without calling a model. Each summary call is a model run with `owner: {changeId}`, so a compaction that retries its summary owns several.
  - `turnId` names the turn a threshold compaction ran in. A manual compaction or a clear runs between turns, and its `cause` is its control delivery. A threshold compaction records `trigger: {inputTokens}`; recovery from a context-length error (#3795) would be another trigger.
  - A threshold compaction runs inside the responding run's window. The threshold counts the chosen model's whole request, including instructions and tools, so the check happens after `model.requested` and the model participants, and the change settles before `model.started`.
  - Outcomes: `completed`; `failed`; `cancelled`, for a direct stop; and `interrupted`, when its turn is cancelled or the session ends.
  - The `idle` selector is false while a change is open.
- **What a compaction does.** It first caps oversized tool results in the older part of the history, which often suffices with no model call. Otherwise its summary run writes a handoff note for the next model: progress, decisions, constraints, remaining work, and exact identifiers. The note becomes an assistant message after "Summary of our conversation so far:", followed by the recent messages, and a later compaction updates the note rather than summarizing a summary. The note stays in the context; readers see that the change happened and what its run cost.
- **`selects` carries the effect on the conversation,** so readers never branch on `kind`. A clear sets `null`: the conversation is empty until the next turn, which `follows: null`. Compactions omit it, because they change the context, not the transcript. A reader that meets an unknown kind shows "Context changed" and still applies `selects`.
- **What `follows` and `selects` enable later.** With `conversation()` in place from the start, in-session edit and regenerate become turns that follow an earlier turn. Branch navigation falls out of grouping sibling turns.
  - A rewind or branch switch with no new turn is a new kind of context change that sets `selects: {turnId}`. Because `selects` ships in v27.0, older readers follow it. A branch switch that summarizes the abandoned branch, as pi does, owns a model run like a compaction.
  - Edits to specific earlier entries, such as dropping a large tool result from the context, are another kind. They'd add an optional `targets` field.
  - Rewinding past a compaction needs history that compaction discards today. Until a producer keeps it, such a request settles `refused` with `reason: "context-unavailable"`.
  - Forks into a new session (#75) can add `session.started.forkedFrom`.

</details>

<details>
<summary>A compaction and a clear, line by line</summary>

Positions continue from earlier turns; scopes are omitted.

```text
── a manual compaction between turns ──
10 facts  delivery.admitted  {deliveryId: d3, principal, source: {control: "compact"}}
          context.started    {changeId: x1, kind: "compaction", cause: {deliveryId: d3}}
                             ── memory capture runs ──
11 facts  model.requested    {runId: r3, owner: {changeId: x1}}
          model.started      {runId: r3, modelId}
12 facts  model.settled      {runId: r3, outcome: "completed", finishReason: "stop"}
          usage.recorded     {owner: {runId: r3}, kind: "model", usage}
          context.settled    {changeId: x1, kind: "compaction", outcome: "completed"}
          delivery.settled   {deliveryId: d3, outcome: "applied"}
                             ── memory recall runs ──

── a threshold compaction inside turn t2 ──
20 facts  call.settled       {callId: c7, outcome: "completed", output}
          model.requested    {runId: r6, owner: {turnId: t2}}
                             ── model participants run; the request is over the threshold ──
21 facts  context.started    {changeId: x2, kind: "compaction", turnId: t2, trigger: {inputTokens: 183400}}
22 facts  model.requested    {runId: r5, owner: {changeId: x2}}
          model.started      {runId: r5, modelId}
23 facts  model.settled      {runId: r5, outcome: "completed", finishReason: "stop"}
          usage.recorded     {owner: {runId: r5}, kind: "model", usage}
          context.settled    {changeId: x2, kind: "compaction", outcome: "completed"}
24 facts  model.started      {runId: r6, modelId}

── a clear, then the next message ──
30 facts  delivery.admitted  {deliveryId: d5, principal, source: {control: "clear"}}
          context.started    {changeId: x3, kind: "clear", cause: {deliveryId: d5}}
          context.settled    {changeId: x3, kind: "clear", outcome: "completed", selects: null}
          delivery.settled   {deliveryId: d5, outcome: "applied"}
31 facts  delivery.admitted  {deliveryId: d6, principal}
          turn.started       {turnId: t4, cause: {deliveryId: d6}, follows: null}
          delivery.consumed  {deliveryId: d6, turnId: t4, parts}
          model.requested    {runId: r8, owner: {turnId: t4}}
```

- Without a memory provider, lines 10 and 11 merge, and so do 21 and 22. A summary run has no participants, so its requested and started facts share a commit.
- A compaction that only caps tool results writes `context.started` and `context.settled`, with no run.
- The summary's text goes into the context, not the transcript, so a summary run has no content parts and no progress.
- After line 30, `conversation()` is empty until `t4`, which follows nothing. The earlier turns stay in the transcript.

</details>

### Example: a declined approval

One line per commit or progress record; scopes are omitted. [Wire format](#wire-format) shows lines 6 and 8 as stored.

```text
0 facts     delivery.admitted   {deliveryId: d1, principal}
            turn.started        {turnId: t1, cause: {deliveryId: d1}, follows: null}
            delivery.consumed   {deliveryId: d1, turnId: t1, parts}
            model.requested     {runId: r1, owner: {turnId: t1}}
1 facts     model.started       {runId: r1, modelId}
2 progress  call.input          {callId: c1, name: "deploy", delta: "{\"env\":\"prod\"}"}
3 facts     call.requested      {callId: c1, owner: {runId: r1}, capability: {kind: "tool", name: "deploy"}, input}
4 facts     model.settled       {runId: r1, outcome: "completed", finishReason: "tool-calls"}
            usage.recorded      {owner: {runId: r1}, kind: "model", usage}
5 facts     interaction.opened  {interactionId: i1, subject: {callId: c1}, request: {kind: "approval", prompt, options}}
            turn.paused         {turnId: t1, awaiting: [{interactionId: i1}]}
            delivery.settled    {deliveryId: d1, outcome: "awaiting-input", turnId: t1}
            ── the answer arrives ──
6 facts     delivery.admitted   {deliveryId: d2, principal}
            response.submitted  {responseId: a1, interactionId: i1, deliveryId: d2, value}
            response.settled    {responseId: a1, outcome: "applied"}
            interaction.settled {interactionId: i1, outcome: "declined", cause: {responseId: a1}}
            call.settled        {callId: c1, outcome: "rejected", cause: {interactionId: i1}}
            turn.resumed        {turnId: t1, cause: {deliveryId: d2}}
            model.requested     {runId: r2, owner: {turnId: t1}}
7 facts     model.started       {runId: r2, modelId}
8 progress  content.delta       {partId: p1, kind: "text", delta: "Understood, I won't deploy."}
9 facts     content.completed   {partId: p1, runId: r2, kind: "text", value, phase: "reply"}
            model.settled       {runId: r2, outcome: "completed", finishReason: "stop"}
            usage.recorded      {owner: {runId: r2}, kind: "model", usage}
            turn.settled        {turnId: t1, outcome: "completed", reply: [p1]}
            delivery.settled    {deliveryId: d2, outcome: "handled", turnId: t1}
```

<details>
<summary>The same exchange in v26</summary>

```text
message.received   {turnId, sequence, message, parts}
turn.started       {turnId, sequence}
step.started       {turnId, sequence, stepIndex: 0, modelId}
action.input.appended {callId: c1, toolName: "deploy", inputDelta}
actions.requested  {actions: [{callId: c1, kind: "tool-call", toolName: "deploy"}], …}
input.requested    {requests: [{kind: "tool-approval", action: {callId: c1}}], …}
step.completed     {finishReason: "tool-calls", usage, …}
turn.waiting       {on: "input", usage, …}
session.waiting    {usage, continuationToken}
                   ── the answer arrives; linked only through meta.deliveryIds ──
approval.settled   {outcome: "cancelled"}                ← means "declined"
input.resolved     {resolutions: [{outcome: "denied"}]}  ← settles c1 by inference
action.result      {status: "rejected", error, result}   ← a third word for c1's status
step.started       {stepIndex: 1}                        ← the only resume signal
message.appended   {messageDelta}
message.completed  {finishReason: "stop", message}       ← the reply, by finishReason
step.completed     {finishReason: "stop", usage}
turn.completed     {turnId, sequence, usage}
session.waiting    {usage, continuationToken}            ← the reader decides this ends the answer
```

</details>

## How events move through the system

### Wire format

**Transport.** The stream route serves NDJSON over HTTP, as today: UTF-8, one JSON record per line, as `application/x-ndjson; charset=utf-8`. The parameters and headers below keep their names and only the version changes. The `streamControlVersion` parameter goes away, because v27 clients always understand control records.

| Parameter or header                  | Meaning                                                               |
| ------------------------------------ | --------------------------------------------------------------------- |
| `startIndex` (query)                 | The position to read from. A negative value counts back from the tail |
| `includeTailIndex` (query)           | Asks for the tail position at open, for bounded reads                 |
| `x-eve-stream-version` (response)    | `27`                                                                  |
| `x-eve-stream-format` (response)     | `ndjson`                                                              |
| `x-eve-session-id` (response)        | The session                                                           |
| `x-eve-stream-tail-index` (response) | The tail position when the read opened, if asked                      |

**Three kinds of record.** Every line is a JSON object, and readers tell the kinds apart by key.

| Record    | Key        | Stored and counted | Written by                      |
| --------- | ---------- | ------------------ | ------------------------------- |
| Commit    | `facts`    | Yes                | The writer, once per transition |
| Progress  | `progress` | Yes                | The writer, as output streams   |
| Transport | `$eve`     | No                 | The stream route                |

Transport records are a position marker after each range that catch-up skips (`{"$eve":"position","next":N}`), a heartbeat every 10 seconds (`{"$eve":"heartbeat"}`), and the connection endings `stream.lease-ended` and `stream.ended`. Readers ignore `$eve` records they don't recognize, so new ones ship as minors. v26 sent blank lines as heartbeats; readers may still skip blank lines, but the server no longer sends them.

```ts
type StoredLine =
  | { at: string; facts: readonly Fact[] } // one commit
  | { progress: Progress }; // one delta or snapshot

interface Fact {
  type: FactType;
  scope?: Scope;
  data: FactData;
}
interface Progress {
  type: ProgressType;
  scope?: Scope; // on the announcing record only
  data: ProgressData;
}
interface Scope {
  turnId?: string;
  taskId?: string;
  runId?: string;
  changeId?: string;
}
```

**Fields:**

- **`at`** is the commit's timestamp: ISO 8601 in UTC, stamped by the writer when it writes the line. Every fact in the commit shares it. It's for display and durations, never ordering: positions order lines, steps run on different machines, and a retried step stamps a new time. Progress carries no timestamp; readers that time deltas, such as time to first token, use arrival time or instrumentation.
- **`facts`** is always an array, even with one fact. Facts are in order, so a fact may reference an entity introduced earlier in the same line.
- **`type`** is `family.verb`, with exactly one dot. Families are single words.
- **`scope`** is stamped by the publisher from the entity's owners: its turn, task, model run, and context change. Owners never change, so scope never goes stale. It lets readers that don't fold, such as log pipelines and eval matchers, place a fact.
- **`data`** is the payload ([Payloads by family](#payloads-by-family)).

<details>
<summary>Lines 6 and 8 of the declined approval, as stored</summary>

Wrapped for reading; on the wire, each record is one line. `…` marks fields left out here.

```text
// Line 6: one commit, seven facts
{"at": "2026-10-07T21:04:11.912Z",
 "facts": [
   {"type": "delivery.admitted",
    "data": {"deliveryId": "d2", "principal": …}},
   {"type": "response.submitted", "scope": {"turnId": "t1", "runId": "r1"},
    "data": {"responseId": "a1", "interactionId": "i1", "deliveryId": "d2", "value": …}},
   {"type": "response.settled", "scope": {"turnId": "t1", "runId": "r1"},
    "data": {"responseId": "a1", "outcome": "applied"}},
   {"type": "interaction.settled", "scope": {"turnId": "t1", "runId": "r1"},
    "data": {"interactionId": "i1", "outcome": "declined", "cause": {"responseId": "a1"}}},
   {"type": "call.settled", "scope": {"turnId": "t1", "runId": "r1"},
    "data": {"callId": "c1", "outcome": "rejected", "cause": {"interactionId": "i1"}}},
   {"type": "turn.resumed", "scope": {"turnId": "t1"},
    "data": {"turnId": "t1", "cause": {"deliveryId": "d2"}}},
   {"type": "model.requested", "scope": {"turnId": "t1"},
    "data": {"runId": "r2", "owner": {"turnId": "t1"}}}
 ]}

// Line 8: progress that announces a text part
{"progress": {"type": "content.delta", "scope": {"turnId": "t1", "runId": "r2"},
              "data": {"partId": "p1", "kind": "text", "delta": "Understood, I won't deploy."}}}

// A later delta for the same part would be minimal
{"progress": {"type": "content.delta", "data": {"partId": "p1", "delta": " Anything else?"}}}

// What a catch-up read sends instead of line 8, since p1 completed at line 9
{"$eve": "position", "next": 9}
```

</details>

<details>
<summary>Why one line per commit</summary>

Workflow stores one chunk whole, but makes no such promise for several chunks flushed together. If a commit's facts were separate lines, a crash or a step retry could leave half a decision on the stream, as v26 can. Avoiding that would put commit boundaries on every line, as Kafka transactions do with control markers. Every reader would then buffer to the boundary, advance its cursor only at commit ends, and skip torn commits that stay on the append-only stream forever. Systems that store the commit as one record avoid all of that: pi's durable package delivers event batches one per commit, NEventStore stores a commit as one timestamp and a list of events, and a Datomic transaction carries one timestamp for all its datoms. The cost here is the `facts` array, and a fact index in each fact's identity.

</details>

<details>
<summary>Positions: each line's index is its permanent identity</summary>

- **A line is one stored chunk.** The writer stores one chunk per write, so a commit is atomic on the stream: a crash leaves the whole commit or none of it.
- **A position** is a line's zero-based index in the session's stream: the number of lines stored before it.
  - Positions are immutable and never reused, even under a future retention policy.
  - Every fact in a commit shares its line's position. A fact's identity is the session, the position, and its index within the line.
  - Positions are Workflow chunk indexes, the same values as `startIndex`.
- **Nothing on a line repeats the position.** Lines carry no position field, and facts carry no event IDs; `meta.id` and `meta.deliveryIds` go away. Clients count lines, as they do today. The deduper becomes `position > last`, which handles reconnect overlap and merging a cached log. An app that caches lines stores each line's position with it.
- **The writer counts too.** The session projection that every publishing step saves gains a line counter, so every checkpoint, including a handoff checkpoint, knows its exact position without reading the stream. That gives observers `ctx.position` and gives retries a starting point.

</details>

<details>
<summary>Progress rules</summary>

1. The first progress record for an entity announces it, with its kind or name and scope. Later records are minimal (`{partId, delta}`).
2. Delta granularity is unspecified, and consecutive records may be merged, so coalescing is a producer change (#3701).
3. Any progress may be absent. Completing facts always carry the full value.
4. Progress for an entity known to be closed is ignored; so is a minimal delta for an unknown entity.
5. Previews live outside the lifecycle tables.

</details>

<details>
<summary>Size and duplicates</summary>

- **Envelope cost matters,** because progress dominates line counts. A five-character delta costs 233 bytes as v26 `message.appended` and about 105 as minimal v27 progress.
- **Line size.** A commit can't be split without losing atomicity, so the publisher caps lines below the platform's per-chunk limit (10 MiB over the WebSocket writer). Because each call settles in its own commit, no line grows beyond today's largest event.
- **Duplicates.** A chunk that a transport retry writes twice now shows up at two positions, where the client's `meta.id` deduper used to catch it. On Vercel the WebSocket writer, enabled since the Workflow 5.1 upgrade (#4456), dedupes resends by writer and sequence. The HTTP fallback can still duplicate a multi-page batch after a network failure. The fold's idempotence absorbs duplicated facts; duplicated progress can double preview text until its part completes. That's rare, and accepted.

</details>

### Reading the stream

- **Catch-up skips closed progress by default.** For example, if you reconnect to a session that has several model invocations with completed content, the stream no longer needs to send the now-irrelevant progress deltas. These progress deltas are likely to make up the majority of event lines, so this is a nice perf win when reconnecting to live sessions (enabled by us formalizing which events count as progress and what facts close that progress.
  - After each omitted range, before the next line it sends, the server writes `{"$eve":"position","next":N}`. A reader assigns positions by counting from its requested cursor and jumps forward at each marker, so it can resume after any line it finished processing.
  - Live lines are always contiguous.
  - A full mode, which omits nothing, remains for tools such as `eve logs --events`.
- **v27 clients talk only to v27 servers,** so leases (60 s) and heartbeat records (10 s) are always on, and the version-negotiation branches go away.
- **How a connection ends:**

  | Ending                    | Meaning                                     | Reader does             |
  | ------------------------- | ------------------------------------------- | ----------------------- |
  | `{"$eve":"stream.ended"}` | The durable stream is done                  | Stops                   |
  | `stream.lease-ended`      | The server's lease on this response ran out | Reconnects at once      |
  | Bare EOF or read timeout  | Transport failure                           | Reconnects with backoff |

- **Silence is no longer a stop signal.** The read timeout only detects dead connections. Readers stop on facts:
  - everyone stops at `session.ended`;
  - request-scoped readers stop at their `delivery.settled`;
  - folding readers stop when the `idle` selector says so (this captures things like "nothing is happening / will happen until the user sends another message).
- **Retry budgets.** One policy remains for transport failures: bounded for one-shot reads, unbounded with capped backoff for readers that follow. The idle reconnect budget, `keepAlive`, and the follower's `Infinity` case go away.

### Observers: hooks and channels

Hooks and channel handlers keep their signatures:

- hooks `(event, ctx)`, including the `*` wildcard, where `event` is the fact `{type, scope?, data}`;
- channels `(data, channel, ctx)`.

What changes is the vocabulary they key on, and what `ctx` holds:

| `ctx` field        | Today                      | v27                                                                       |
| ------------------ | -------------------------- | ------------------------------------------------------------------------- |
| `session`          | `{id, auth, turn, parent}` | Unchanged; `turn` keeps meaning the session's current turn                |
| `scope`            | —                          | The fact's actual owners, for example a task's facts after its turn ended |
| `position`         | —                          | The line, plus the fact's index within it                                 |
| `view`             | —                          | The session's tables and selectors, as of this whole commit               |
| `cancel()` (hooks) | Aborts the running turn    | Unchanged; the turn settles `cancelled` with `cause: {hook}`              |

The channel handler's third argument becomes an observer-only subtype of `SessionContext`, so tools don't see these fields. The channel handler for `session.ended` gets a `ctx`, which today's `session.failed` handler lacks.

- **`ctx.view` reflects the whole commit.** A handler for `interaction.settled` sees the call already settled when the same commit settles it. Handlers read what changed from the fact, and where things stand from `ctx.view`.
- **Order per commit:** write, then channel handlers, then hooks, synchronously. Today channels run before the write, so a channel could post about an event whose write then failed. Progress goes to channels live.
- **Observers see only facts.** `session.waiting` goes away for hooks and channels too, rather than surviving as a notification that isn't a line. What it signalled comes from facts and the view:
  - "the response to this message is done": `delivery.settled`;
  - "the turn is over": `turn.settled` or `turn.paused`;
  - "nothing is running": `idle(ctx.view)`, checked in the handler for the fact that ends the work;
  - its data: `usage` is a selector, and channel handlers already get the continuation token on their `channel` argument (`channel.continuation`).

  An authored handler keyed on `session.waiting` fails the build with that guidance. Adapters stop shaping written events.

- **What observers can rely on:**
  - **Invocation, not delivery.** Observers run for every fact, in order, and a handler that throws is logged and counts as invoked. eve doesn't guarantee that an external effect succeeded, or happened only once.
  - **Recovery after a step retry.** The order gives an implicit cursor: if line N+1 exists, line N's observers ran. A retried step re-dispatches only the last line it recovers, with that commit's view, so at most one invocation repeats.
  - **The flush window.** `write()` resolves once the chunk is buffered, not stored. If the process dies inside the writer's flush window, observers may have acted on a fact that never became durable. Hooks have this gap today, and channels gain the same one in exchange for no longer running before the write. Running observers only after the write is durable stays the goal, once Workflow exposes write acknowledgements or a flush on step writables. It isn't worth forcing with tail polling or a writable per commit.
- **Observers keep a handler per event type.** They choose among many types, including frequent progress, so eve skips what nobody subscribed to, and built-in channels override their defaults one event at a time. Participants differ: each is one function over the few events its kind receives ([`dynamic-participants.md`](./dynamic-participants.md)).
- **A `*` hook receives facts only.** Today a wildcard hook runs for every delta, sequentially and awaited, which adds noise and time on the streaming path. Progress reaches a hook only through an explicit key, such as `content.delta`.
- **Guards for conditions.** `eve/events` exports type guards such as `isCompaction`, `isCompleted`, `hasKind(…)`, and `hasOutcome(…)`. Observers branch on open values and fall back for unknown ones. Participants rarely need guards, because each kind of participant receives only the events eve narrows for it ([`dynamic-participants.md`](./dynamic-participants.md)).
- **Channels:**
  - `deliver` shapes only the channel's own sends ([Deliveries](#payloads-by-family)).
  - Built-in channels render status from the shared `activity` selector, instead of rebuilding it from their own handlers and state. Slack, for example, keeps `pendingTaskResults` and `pendingToolCallMessage` today to say "Reviewing results…" and to tell narration from a reply.
  - Channel routes, such as Telegram's sign-in button and Slack's interaction buttons, read selectors through the session handle instead of scanning the stream.
- **Model messages never reach observers,** as is already true for authored hooks.

### Tables, selectors, and retention

The fold that produces the tables is shared by the client, the server, and anyone else, and it's public.

<details>
<summary>The tables, selectors, and retention modes</summary>

```text
SessionView @ position
├─ session        status · parent?
├─ deliveries     [deliveryId]     principal? · source? · status · turnId? · outcome?
├─ turns          [turnId]         cause · follows · status · awaiting? · reply?
├─ runs           [runId]          owner · modelId? · status · finishReason?
├─ parts          [partId]         runId · kind · phase? · interrupted? · status
├─ calls          [callId]         owner · capability · clearedBy? · taskId? · status · outcome?
├─ tasks          [taskId]         startedBy · kind · name · status · outcome?
├─ interactions   [interactionId]  kind · subject · origin? · status · outcome?
├─ responses      [responseId]     interactionId · deliveryId · status · outcome?
├─ children       [sessionId]      owner · name · stream
├─ changes        [changeId]       kind · turnId? · cause? · status · outcome? · selects?
└─ usage          totals by owner and kind
```

- **The tables are public, read-only, and typed,** one per family. Fields are what the facts introduce and settle, plus status and the position of the introducing fact, and they follow the same stability rules as the wire. That position lets participant re-runs receive the original event exactly.
  - Bookkeeping stays out of the public types: indexes, pruning marks, and the client-only overlay that marks an approval answered before the server confirms.
  - The projection stops hiding behind the `conversationProjection` symbol.
- **Selectors over the fold.** We have a set of convenience functions for working with the folded state. This includes fallbacks for open kinds and common questions. The starting set comes from what the TUI and the web chat read today:
  - turns: `turn`, `activeTurn`, `conversation`, `reply`, `failure`;
  - work: `call`, `task`, `tasks`, `interaction`, `openInteractions({kind?, subject?})`;
  - deliveries: `delivery`, `queue`;
  - session: `idle`, `usage`, `children`, `child`, `childForCall`;
  - status: `activity({turnId?})`, what the session is doing right now for status lines: thinking, running calls by name, waiting on a person or on tasks, reviewing results, compacting, or idle.
- **Selectors work outside observers too.** Channel routes and server code read them through the session handle (`session.view()`), served from the saved projection.
- **Extending state without rebuilding the reducer:**

  ```ts
  const reducer = extendConversation({
    initial: () => ({ deploys: 0 }),
    reduce(extra, fact, view) {
      return fact.type === "call.settled" &&
        view.calls[fact.data.callId]?.capability.name === "deploy"
        ? { deploys: extra.deploys + 1 }
        : extra;
    },
  });
  useEveAgent({ reducer });
  ```

- **The client's UI model stays AI SDK-shaped.** `ConversationState` keeps `UIMessage`-style parts with `type` discriminators, built from the tables, and gains run and part IDs.
- **Two retention modes:**
  - **Complete,** for clients and explicit history reads. It keeps everything folded for a loaded session.
  - **Operational,** for server checkpoints and `ctx.view`. It keeps the session and its open turn; every open call, task, interaction, response, context change, and unsettled delivery; whatever the observed commit touched, until that commit's callbacks finish; and older records while execution still needs them. It prunes the rest. A missing row means "not retained here", not "never existed".
  - Aggregates such as usage are folded, so they don't pin their sources.
- **No projection snapshots on the wire.** The wire contract stays facts only. Server readers fold from line 0, skipping closed progress, because the stream's shape is stable across deployments while a saved projection's internal shape isn't.

</details>

### Files and large values

- **Bytes never go on the stream.** Today client `data:` URLs and raw MCP media results can.
- **Files are references.** With the attachment store from #4223, file parts carry the attachment's hash as `ref`, resolved through a session-scoped route (`GET /eve/v1/sessions/:id/attachments/:sha`), not the internal `eve-attachment:` URI.
  - Without a store, file parts carry metadata plus an explicit `unavailable` marker.
  - Retrieval follows the store's access policy and lifetime. A deleted or expired object reads as missing, and that never changes a recorded outcome.
- **Fields that may be large are "inline value or reference" from day one:** delivery file parts, content values, and call inputs and outputs. A reference is `{ref, mediaType?, size?, preview?}`. A producer emits a reference only when a supported retrieval route exists for it.
- **Absent, inline, referenced, and redacted values are distinct,** so a withheld output never reads as "no output".

### Child sessions and relays

- **Each session's stream describes only that session.** The parent records `child.opened`. The child's turns, calls, and interactions live in the child's stream.
- **Hierarchical views come from a multi-stream fold.** The client's `AgentStreamFollower` already follows each child with its own cursor. It becomes the documented fold, exposed as `children()` and `child(id)`. Server-side child views for channels (#2087, #3945) can come later as additive selectors.
- **The remote binding moves off the stream.** For a remote child, `{url, resolverId}` goes to a private side stream on the session's anchor run (`getRun(anchor).getWritable({namespace: "eve.child.<childSessionId>"})`), written durably before `child.opened`. The parent's proxy route reads it there. Today the proxy scans the parent stream from line 0 on every connect (`findRemoteAgentBinding`), and every reader sees the remote URL.
- **Relays become their own contract.** Today parent and child exchange v26 stream events: the subagent adapter forwards child requests, and the remote callback route parses them with strict schemas and closed enums (`subagents/callback-route.ts`). Instead:
  - relay messages are keyed by the child's IDs, under a bumped remote agent protocol version, and parsed tolerantly;
  - a relayed request becomes an ordinary parent interaction with `subject: {callId}` and `origin: {sessionId, interactionId}`, so parent hooks and channels see it like any other (this subsumes #3785);
  - forwarding a response to the child is an execution effect after the write, retried, and idempotent per child session and interaction;
  - the child records its own response, settles its interaction, and reports back, and the parent settles its mirror; cancellation withdraws across hops;
  - a sign-in callback lands on the session that owns the attempt, and the parent's mirror settles through the relay.

<details>
<summary>Why not forward child events into the parent stream (#666, #1725)</summary>

#666 asked for one durable journal per root session. A parent-only client saw a subagent's action start, then silence, then the child's final result in one piece. Regenerating that result at the root cost a second model call and defeated the point of a specialized child. #1725 (a community PR) autosaves child turn events into the parent stream as `subagent.event`.

The remaining benefit is one stream and one cursor for clients that don't use eve's client. The costs grow with depth:

- every hop rewrites its descendants' events, so storage grows with tree depth;
- the root's history and catch-up grow with the whole tree;
- writers contend on the root;
- foreign lifecycles and orderings enter a stream whose rules assume it describes one session;
- readers of the root can see what was meant for a child's audience.

Streaming children doesn't need copying: `streamSubagent` and `AgentStreamFollower` already do it. If one stream ever becomes necessary, the server can multiplex selected child streams at read time, tagging each line with its source stream and position, without storing anything twice. That would be additive.

</details>

### Retries and recovery

A model call retried after it emitted anything abandons its run, and a retried step folds from its checkpoint position and closes what the dead attempt left open. Recovery is best-effort, and attempts are assumed to run one after another.

<details>
<summary>How recovery works, and its limits</summary>

**Inside a step.** `harness/model-call/retry.ts` retries a model call up to three times on transient provider errors.

- If the emitter accepted nothing from the failed attempt, the retry stays in the same run.
- Otherwise the run settles `abandoned`, its calls settle as described in [Calls](#payloads-by-family), and a new run starts. That fixes #3308's ghost tool cards. Counting at the emitter can only err toward abandoning, which leaves a harmless empty run.

**Whole steps.** Workflow re-runs a failed step from its checkpoint. On `attempt > 1` the step:

1. reads the tail once, then folds from the checkpoint's position to the tail;
2. skips facts already present that its inputs fully determine (accepts, consumes, turn starts), which works because those IDs are deterministic;
3. closes what the dead attempt left open: runs, calls, and interactions `abandoned`;
4. re-dispatches observers for the last recovered line only.

Recovery is best-effort. If the read fails, the step logs it and continues the way `main` does today, without closures. A write from the dead attempt that lands after the read is missed, as on `main`, and can leave the server's counted positions slightly behind; clients count lines themselves and aren't affected.

**Attempts are assumed to run one after another.** The ownership lease (860 s) outlives the maximum function duration (800 s), and optimistic inline start is off by default. Self-hosted multi-instance worlds, `WORKFLOW_OPTIMISTIC_INLINE_START`, and long-duration functions break the assumption. Zombie writers like #2599's remain an accepted risk:

- the fold's tolerance rules absorb most of the stream pollution;
- duplicate side effects, shared-resource races, and cost aren't addressed.

Workflow-level fencing (fenced appends and a lost-ownership signal, vercel/workflow#3811) would close most of that. It isn't expected soon and isn't a prerequisite; the writer keeps a private place to hook it in. Neither would undo effects that already happened.

**The outside world isn't repaired.** Side effects of tools that already ran aren't undone.

</details>

### The contract module

The wire contract lives in one self-contained module, `protocol/session-events/`, and the shared fold in `protocol/session-projection/`.

<details>
<summary>Layout and rules</summary>

```text
protocol/session-events/
  envelope.ts   lines, fact and progress envelopes, IDs, scope, cause, principal, error, usage, value references
  families/     session, delivery, turn, model, content, call, task, interaction, response, child, context, usage
                each: payload schemas, plus a descriptor {idField, introducedBy, terminal, owner}
  catalog.ts    unions, type → family, descriptor table, open-set fallbacks
  checker.ts    invariant checker for test streams
protocol/session-projection/   folds per family, public tables, selectors
```

- **Self-contained.** A guard forbids imports from `shared/`, `harness/`, `connections/`, or `ai`, so runtime refactors can't silently change the wire. That's also why the AI SDK's types leave `protocol/`: the UI part picks on `message.received`, and the provider-metadata type behind `generationId`, which becomes a plain string.
- **Zod schemas, kept out of clients.** Types are inferred from the schemas. A plain runtime catalog (type → family, fallbacks) serves the client fold, and a guard keeps Zod out of client bundles. Validation runs in tests and dev only, so nothing is validated on the delta hot path.
- **No builders in `protocol/`.** Facts are typed literals built by their owners: the session machine and `hitl/` for lifecycle, the emission code for content and calls.
- **Authoring surfaces are checked against the catalog.** The hook and channel maps stay explicit, so a new fact doesn't silently become a hook event, but they're type-checked against the catalog. Each kind of participant's `event` parameter is typed from the catalog too.
- **Guards ship with the catalog.** The public `eve/events` entry exports the client catalog's types and the guards. It has no runtime dependencies, so clients, hooks, channels, and participants share it.

</details>

### Compatibility at the break

- **No upcaster.** Clients read v27 only, and the v21–v26 normalization (`protocol/message-version.ts`) is deleted. The CLI, ACP, and eval runners report the existing unsupported-version error against older deployments.
- **Sessions don't cross the break.** Pre-break checkpoints are refused by v27 successors, so the deployment that owns a session keeps it until it ends ([`single-workflow-session-upgrades.md`](./single-workflow-session-upgrades.md)). Self-hosted services drain, or their channels start fresh sessions (#4092).
- **Pre-break history isn't readable by v27 clients.** If a product needs it, a read-only upcaster can go into the stream route later without touching anything else.
- **Hook and channel event names break.** Their retained `extension-contracts` epochs (32 hook and 39 channel fixtures) are dropped with a reason. In the same release, dynamic resolvers and memory providers become one function per action over catalog events, without aliases, migrated by a codemod ([`dynamic-participants.md`](./dynamic-participants.md)). Instrumentation keeps its own vocabulary.
- **The remote agent protocol version is bumped.** A v27 parent calling a v26 remote agent fails at call time with the existing mismatch error. Remote agent protocol 1 is deleted.

## Codepaths that change

Before and after for the reader and producer paths the break changes most.

<details>
<summary>"Is my response done?"</summary>

**Today.** `ClientSession` reads until a `TurnSegment` says the segment ended, filtering by `meta.deliveryIds`:

```ts
// client/session.ts
const matches = event.meta?.deliveryIds?.includes(deliveryId) === true;
const terminal = event.type === "session.failed" || event.type === "session.completed";
if (!matches && terminal && (!started || event.type === "session.completed")) {
  throw new Error("The session ended before the accepted message reached its turn boundary.");
}
if (!started && !matches) continue;
const attributed = event.meta?.deliveryIds !== undefined;
if (!terminal && attributed && !matches) continue;
started = true;
// …
reachedBoundary = segment.observe(event); // folds, then applies the turn.waiting / session.waiting rules
```

**With v27.** Read until `delivery.settled` for this `deliveryId`, or `session.ended`. The reply is `turn.settled.reply` for the settled delivery's `turnId`, and `respond()` uses the same rule. `TurnSegment`, `endsTurnSegment`, the stamping of delivery IDs on every event, and the "unattributed event" branches go away.

</details>

<details>
<summary>"Which text is the reply?"</summary>

**Today.** About a dozen readers test `message.completed.finishReason !== "tool-calls"`, among them `client/session-utils.ts`, the invocation API, evals, and the Telegram, Twilio, Discord, Teams, GitHub, Linear, Slack, and Chat SDK defaults. The producer reports text in a held step as `tool-calls` so those readers hide it.

**With v27.** Channels post on `content.completed` with `phase: "reply"`, as each part completes. Readers that want the final answer read `turn.settled.reply`. The held-step special case disappears, because narration is narration.

</details>

<details>
<summary>The client message reducer</summary>

**Today.** `client/message-reducer.ts` and its helpers (about 1,350 lines) build UI messages from events keyed by `turnId` and `stepIndex`, and repair what the stream doesn't say. When a turn ends, it marks streaming text done and drops tool parts still streaming their input:

```ts
parts: removeStreamingToolParts(closeStreamingRuns(message.parts)),
```

Task calls special-case the receipt, and approval state is pieced together from `input.requested`, `approval.settled`, `input.resolved`, and `action.result`.

**With v27.** The shared fold produces the tables, and the UI model is a projection of them keyed by run, part, and call IDs. Every repair becomes a terminal the producer wrote: interrupted parts complete with `interrupted: true`, abandoned runs drop their previews, calls settle explicitly. The per-event repair code and the receipt special cases are deleted.

</details>

<details>
<summary>Following a stream</summary>

**Today.** `client/open-stream.ts` reconnects on every transport ending, counting empty reconnects against `streamIdleReconnectPolicy` (five by default). `keepAlive` makes the budget infinite, and `AgentStreamFollower` sets `maxAttempts: Infinity`. The client and the route negotiate a control version before lease records are used.

**With v27.** The connection-ending table in [Reading the stream](#reading-the-stream) replaces the heuristics: `stream.ended` stops, a lease end reconnects at once, and anything else is a transport failure with backoff. Readers stop on facts. The idle budget, `keepAlive`, the `Infinity` special case, and the control-version branches are deleted.

</details>

<details>
<summary>Publishing a commit</summary>

**Today.** `execution/publish-session-events.ts` publishes one event at a time. Channel forwarding and the adapter run before the write, and the adapter may reshape the event (the continuation token on `session.waiting`):

```ts
const emit = async (event) => {
  const stamped = await writer.write(await dispatcher.deliver(event));
  recordPublishedEvent(ctx, stamped);
  return stamped;
};
// publish: await dispatcher.runHooks(await emit(event));
```

**With v27.** The publisher writes a whole transition as one line, counts it in the projection, then runs channel handlers and hooks with `ctx.view` and `ctx.position`. Relay forwarding moves to an execution effect after the write, and nothing reshapes what's written.

</details>

<details>
<summary>Server readers that scan the stream</summary>

**Today,** three server readers scan the stream by hand:

- Telegram's sign-in callback reads the stream from line 0 and keeps the latest `authorization.required`, whether or not it completed.
- The invocation API folds its own mini-projection over the last 64 events (`INVOCATION_EVENT_WINDOW_SIZE`), which a long reply's deltas can push an open request out of.
- The remote child proxy scans the parent's stream from line 0 on every connect to find the child's binding.

**With v27.** Telegram and the invocation API read `openInteractions({kind: "sign-in"})` from the shared fold through the session handle. The proxy reads the child's private side stream. All three scans are deleted. The first two fixes can land before the break, on today's fold.

</details>

<details>
<summary>Retried model calls and steps</summary>

**Today.** `harness/model-call/retry.ts` retries regardless of what the failed attempt published, and a retried step starts over with new IDs. The dead attempt's output stays on the stream, and readers clean up with heuristics: the client reducer drops tool parts still streaming their input (`removeStreamingToolParts`) and marks streaming text done (`closeStreamingRuns`).

**With v27.** An in-step retry abandons the run if the emitter accepted anything, and a retried step recovers from its checkpoint position ([Retries and recovery](#retries-and-recovery)). Readers just fold.

</details>

<details>
<summary>The relay callback route</summary>

**Today.** `subagents/callback-route.ts` parses child events with `.strict()` objects and closed enums such as `z.enum(["pending", "rejected", "failed", "timed-out", "stale"])`. A newer child with one new field is rejected by an older parent.

**With v27.** Relay messages are keyed by child IDs and parsed tolerantly under the new remote protocol version. Local and remote children converge on one message shape, replacing the parallel paths in `forward-session-input.ts`, `subagents/hitl-proxy.ts`, and `subagents/event-proxy-step.ts`.

</details>

## Future proofing

### Evolving safely after 1.0

After the break, and through 1.x, the stream should evolve without breaking anyone. Streams continue across deployments, and clients may be older or newer than the server, so within a major version new readers must read old lines and old readers must read new ones.

- **One major version plus additive minors.** Clients accept any minor and refuse unknown majors. Sessions don't cross a major.
- **Every reader, including server relays,** ignores unknown fields, unknown fact types, and unknown progress types, and maps unknown values of open sets to their fallback. Readers still validate the required structure and closed outcomes of facts they know; an unknown closed outcome is a contract violation.
- **Closed and open sets.** Terminal outcomes are closed. These are open, each with a fallback:

  | Open set                                                          | Fallback                                              |
  | ----------------------------------------------------------------- | ----------------------------------------------------- |
  | Content `kind`                                                    | A generic block, using `mediaType` and `fallbackText` |
  | Capability `kind`                                                 | A generic call card, using `name`                     |
  | Interaction `kind`                                                | A generic prompt, using the common request fields     |
  | `phase`                                                           | Narration                                             |
  | Context change `kind`                                             | "Context changed", still applying `selects`           |
  | Cause kind                                                        | "System"                                              |
  | Delivery source kind, `finishReason`, error codes, every `reason` | Open strings                                          |

- **What an older reader may and may not do.** It may show less detail. It must not misread a known entity's lifecycle, or offer an interaction it doesn't know how to perform.
  - New fact types may introduce new families or annotate existing entities. They may never change an existing entity's open or closed status, its ownership, or the meaning of existing facts, and a new family can't become a required owner of a known entity.
  - New executable work that affects whether the session is idle must use a lifecycle older readers understand.
  - For an unknown interaction kind, a reader renders the common fields, and offers a response only through the declared common mechanisms: standard options, explicitly allowed free text, or a link.
- **Enforcement, to start:**
  - a protocol capability in `extension-contracts`, whose classifier passes additive changes and flags breaking ones. It covers the public tables too;
  - an old-reader conformance test: the v27.0 fold, frozen at release, run over golden streams from the current producer;
  - the stream checker in tests.

<details>
<summary>What each kind of change ships as</summary>

| Change                                                                                                                            | Ships as | Why older readers stay correct                                    |
| --------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------- |
| A new optional field                                                                                                              | Minor    | They ignore it                                                    |
| A new value in an open set: a content, capability, interaction, or context change kind, or a `reason`                             | Minor    | They render the fallback                                          |
| A new progress type                                                                                                               | Minor    | They ignore it, and completing facts carry full values            |
| A new annotation on an existing entity                                                                                            | Minor    | They ignore it, and the entity's lifecycle doesn't change         |
| A new family that references existing entities                                                                                    | Minor    | They ignore it, and it can't own a known entity                   |
| Moving a large value from inline to a reference                                                                                   | Minor    | Those fields are "inline or reference" from v27.0                 |
| A new `$eve` transport record                                                                                                     | Minor    | Transport records are never counted, and unknown ones are ignored |
| A new outcome in a closed set, a newly required field, a removed type, or a change to ownership or to what an existing fact means | Major    | Older readers would misread a lifecycle                           |

</details>

### Directions that fit

These are just hypothetical. Each would land as a minor, using a mechanism the contract already has.

<details>
<summary>Twenty-two directions, and how each lands</summary>

| Direction                                            | How it lands                                                                                                                                                                      |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edit, regenerate, rewind, and branch switching (#75) | New turns `follow` an earlier turn, and siblings become versions. A rewind or branch switch with no new turn is a new context change kind, and older readers follow its `selects` |
| Forks into a new session                             | `session.started.forkedFrom {sessionId, position}`                                                                                                                                |
| Steering with replacement input, barge-in (#867)     | The run settles `interrupted`, its parts complete with what streamed, and the steering delivery is consumed into the same turn                                                    |
| Answers sent before their prompt existed (#786)      | `delivery.admitted.seenThrough: position`, so a message isn't taken as the answer to a prompt opened after it                                                                     |
| Deadlines and escalation on `ctx.ask` (#3546)        | `expiresAt` on `interaction.opened`; the interaction settles `expired`, and a new interaction opens for another audience                                                          |
| Stop requests                                        | `turn.stopping` and `task.stopping` updates between a cancel decision and the terminal, so readers can show "Stopping…"                                                           |
| Session metadata                                     | `agent`, `deployment`, and `title` on `session.started`                                                                                                                           |
| A deployment marker                                  | `session.redeployed`, or an optional `revision` on `turn.started`, so readers can show that the agent was updated mid-session                                                     |
| What a run could use                                 | A per-run summary on `model.started`, such as the names of the tools and skills it was offered                                                                                    |
| Visible compaction summaries                         | An optional `summary` on `context.settled`, since the handoff note is written for a model, not a person                                                                           |
| Who signed in                                        | `account` on a sign-in's `interaction.settled.response`, when the connection reports it, visible to the same readers as the challenge fields                                      |
| Fewer channel API calls                              | A channel handler that runs once per commit                                                                                                                                       |
| Human handoff, MCP elicitation, forms                | New interaction kinds, rendered from the common request fields and answered through the declared mechanisms                                                                       |
| Plans, todo lists, environment setup (#544)          | A new family that references turns and calls, without owning them                                                                                                                 |
| Media from models and tools (#3384)                  | New content kinds with `mediaType`, `fallbackText`, and references                                                                                                                |
| Model fallback within a run                          | An optional field on `model.settled` naming the model that actually served                                                                                                        |
| Visible memory recall                                | An annotation on the turn naming what was recalled                                                                                                                                |
| Principal-scoped sessions (#661)                     | `session.started.principal`, plus redaction in place, so positions stay global                                                                                                    |
| Retries that reuse completed work                    | A private journal of run and tool results, plus a context change kind, with `targets`, for completed runs that recovery dropped from the context                                  |
| Server-side views of children (#2087, #3945)         | Selectors over followed child streams                                                                                                                                             |
| One stream for clients that don't fold children      | Read-time multiplexing of selected child streams, each line tagged with its source stream and position, with nothing stored twice                                                 |
| Durable-before-observers, fencing, coalescing        | Producer changes behind the writer, with no change to the vocabulary                                                                                                              |

</details>

Realtime media transport (#637) doesn't fit, and isn't meant to: the stream records the transcript, and media stays out of band.

### Toward a session log

The stream is the public half of a session log. The longer-run direction is for all session state to be derivable from events: model history, private records, resolver results, and authored state. That doesn't happen at v27, but v27 shouldn't block it.

- **Two tiers, one commit model.** Public facts go on the wire, as specified here. Private entries would live only in the log, ride in the same commits as the facts they accompany, and reference public IDs. Each type declares its audience.
- **Everything else becomes a fold:** the public tables, the model's context, resolved capabilities, and open work. Checkpoints become snapshots of those folds at a position, which can be rebuilt. The machine side is in [`session-machine-simplification.md`](./session-machine-simplification.md#toward-a-session-log).
- **Never in the log:** code, secrets (only references), live progress, leases, and Workflow internals.

<details>
<summary>A sketch of the private tier</summary>

| Entry                                          | Holds                                                                                                                                              | Today                                                                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `capabilities.changed`                         | One participant's full result at one scope: tool declarations and references, instructions, skills, connections, subagents                         | `eve.{session,turn,step}DynamicToolMetadata`, the dynamic model references, `dynamicSkillManifest`, runtime revisions |
| `contribution.recorded`                        | Model input besides the conversation: memory recall, notices, skill and connection announcements, `outputSchema`                                   | `eve.memory.preparedPreamble`, `pendingSkillAnnouncement`, `pendingDynamicInstructionUserMessages`                    |
| `context.summarized`                           | A compaction's summary and its boundary                                                                                                            | The rewritten history                                                                                                 |
| `model.recorded`, `call.recorded`              | What history replay needs: provider metadata such as reasoning signatures, and what the model saw of a call when it differs from the public output | Model history in the checkpoint                                                                                       |
| `suspension.recorded`, `.released`             | A suspended step, and how to resume it                                                                                                             | HumanInput's suspended steps                                                                                          |
| `authorization.recorded`, `relay.recorded`     | Matching sign-in callbacks; where a relayed request's answers go                                                                                   | `eve.runtime.pendingAuthorization`; HumanInput's relayed routes                                                       |
| `task.bound`, `child.bound`, `result.recorded` | A task's workflow run; a remote child's binding; results that retries reuse                                                                        | The task table; the private side stream, already                                                                      |
| `owner.changed`, `address.claimed`             | Handoffs between runs; continuation aliases                                                                                                        | The session anchor; continuation hook tokens                                                                          |
| `state.updated`, `channel.recorded`            | `defineState` slots; channel-owned state such as posted card IDs                                                                                   | Durable context slots; channel adapter state                                                                          |
| `sandbox.attached`, `.released`                | The session's sandbox                                                                                                                              | `eve.sandbox`                                                                                                         |

Model history, turn delivery IDs, grants, and limits are folds, not entries.

</details>

- **Capabilities as keyed replacement.** Each `capabilities.changed` replaces one participant's result at one scope, and the fold merges session, then turn, then run, the way `buildDynamicSubagentTools` already merges session and turn selections. Participants own separate slots, so there's nothing to diff, and folding costs grow with the number of participants rather than the session's length. pi patches its prompt instead, because many extensions edit one shared prompt.
- **Filter, derive, or split.** Deriving the public stream from the log is the most flexible; a split is the natural way to get there.

  <details>
  <summary>The three layouts</summary>

  |                        | Filter: one stream, the route strips private parts     | Derive: the private log is the truth, the public stream is projected from it | Split: v27's public stream, plus a parallel private stream             |
  | ---------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
  | Atomicity              | Free: one chunk                                        | The log append is the commit; the public write follows, outbox-style         | The private part is written first; the public line is the commit point |
  | Leak safety            | Every reader must filter                               | Safe by construction: only what the projector emits is public                | Safe                                                                   |
  | Public positions       | Shared with the log; private-only commits show as gaps | Each view numbers its own lines, deterministically                           | As today                                                               |
  | New views              | Hard                                                   | Natural: a new wire version, a view scoped to one person, a debug view       | Partly                                                                 |
  | A missing public write | Can't happen                                           | Repaired exactly by deriving again                                           | Recovered best-effort, as in v27                                       |
  | Cost                   | One write; every read pays for private bulk            | Two writes, public facts stored twice, a projector cursor                    | Two writes, nothing stored twice                                       |

  A derived view's positions stay stable only while its derivation is frozen. A view is never derived again in place, because clients hold its cursors; a new projector means a new view with its own numbering. v27's private child bindings already follow the split layout.

  </details>

- **What v27 keeps open:** positions belong to a stream or view; gap markers already let a reader skip positions it isn't sent; public facts can be computed from the commit alone; participants record results in one place; and nothing here calls the public stream the record of private state.
- **Until then, new private state should be entry-shaped.** It goes through the commit path as records that could become entries, even while it's stored in checkpoints. Each new ad hoc context key is a future migration.

## Implementation plan

### Phases

**1. Before the break, on `main` (v26 wire).** Each item lands on its own and makes the break smaller. None depends on HumanInput, and most don't touch the files it changes.

- Read turn identity from the projection everywhere. `program.ts` restarts `turn_${n}` in each owner run, so after a handoff a failing session reports the wrong turn ([`session-machine-simplification.md`](./session-machine-simplification.md)).
- Move Telegram's sign-in lookup and the invocation API onto the shared fold.
- Record golden scenario streams and stream-cost metrics: lines and bytes per reply, catch-up volume, and time to first byte on reload. They size delta coalescing (#3701) and the catch-up holdback, and later serve as v27 golden inputs.
- Count stream positions in the saved projection, and run channel handlers after the write.
- Add the v27 contract module, its fold, tables, selectors, and `eve/events` guards, with no runtime use yet.
- Move remote child bindings to the private side stream, keeping the scan as a fallback for older sessions until the break.
- Route new private state through the commit path as entry-shaped records ([Toward a session log](#toward-a-session-log)).

**2. Structural prerequisites, after HumanInput.** HumanInput (#4342–#4344) is now rebased onto the session-state stack and in review. Two items from [`session-machine-simplification.md`](./session-machine-simplification.md) matter here:

- **Lifecycle only in the projection** is required before interactions move to v27. Otherwise `hitl/` and the machine both write turn facts: HumanInput still builds `turn.waiting` and `message.completed` events.
- **One commit path** for the small publishing steps is recommended. It makes "one transition, one commit, one line" uniform.

The participant pipeline from [`dynamic-participants.md`](./dynamic-participants.md) fits here too, but nothing depends on it.

**3. The break.** One stream-version change, developed on a long-lived integration branch and released together.

- The new envelope lands first and carries v26 types inside it until each family moves. Readers already ignore types they don't know, so the branch stays green.
- Each family change then updates its producer, fold, wire readers, server observers, and docs together.
- The integration branch rebases on `main` regularly.

```text
envelope · positions · catch-up · transport endings
 ├─ observer context; session.waiting removed
 ├─ session · turn · model run
 │    └─ content · reply · files
 │         └─ calls · tasks
 ├─ deliveries · controls and sign-in callbacks as deliveries
 ├─ interactions · responses             ◀── lifecycle only in the projection
 ├─ child links · relay contract · remote protocol bump
 └─ retry recovery                       ◀── runs, calls, and interactions
participants as functions over events · eve/events guards
client tables · selectors · activity · extendConversation · framework bindings
compatibility deletions · docs · release notes
```

**4. After the break, as additive minors.**

- A general retrieval route for large non-file values.
- A private journal of run and tool results, so retries reuse them. Plus a context change kind for completed runs lost to recovery.
- Rewind and branch switching: new context change kinds, and raw history across compaction.
- `seenThrough` on `delivery.admitted`, so a message isn't taken as the answer to a prompt opened after it (#786).
- Stop requests, session metadata, interaction deadlines, and the other directions above.
- A private session log ([Toward a session log](#toward-a-session-log)).
- Server-side child selectors for channels.
- A reasoning opt-out.
- Fencing, once Workflow provides it.

### Coordination

<details>
<summary>PRs and issues, and the plan for each</summary>

| PR or issue                        | Relation                                                   | Plan                                                                                                                                                |
| ---------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| #4342–#4344 HumanInput             | Rewrites `hitl/`; the interaction family follows its model | Land first. In review, ask for an "answer admitted" output for `response.admitted`, and for `commitSessionStep` to become the session's commit path |
| #4223 first-class attachments      | Supplies the file store and retrieval route                | Ideally its store and refs land before the break, so v27.0 ships refs. Its outbound files map to file content parts                                 |
| #4194 `fetchFile` on `eveChannel`  | Inbound web uploads by URL                                 | Compatible                                                                                                                                          |
| #3222 close terminal streams       | Readers rely on terminal runs closing their stream         | Land                                                                                                                                                |
| #3701 delta coalescing             | Progress granularity                                       | Land with a window measured by the golden streams                                                                                                   |
| #4031 `meta.index` on reads        | The same positions, assigned on read                       | Compatible on v26; v27 subsumes it                                                                                                                  |
| #4099 `clientContext`              | A display-relevant delivery attribute                      | Lands on `delivery.admitted` in v27                                                                                                                 |
| #3785 hooks for proxied events     | Relayed requests                                           | Subsumed: relayed interactions are ordinary parent facts                                                                                            |
| #3580, #3581 web state and history | Client readers                                             | Rebase onto the client tables, or land first and port                                                                                               |
| #2948 deferred tail                | Tail cost and the route's handshake                        | Reconcile with catch-up filtering                                                                                                                   |
| #1725 forward child events (#666)  | Conflicts with separate child streams                      | Close ([why](#child-sessions-and-relays))                                                                                                           |
| #4092 stranded sessions            | Self-hosted impact of the break                            | Align the release notes                                                                                                                             |

</details>

### Size

About −400 lines net in source (plausibly +300 to −1,200) across roughly 10,000 touched, plus about −1,900 from the compatibility cut. Tests are the largest churn. All estimates come from reading code.

<details>
<summary>Estimates by area, and facts per turn</summary>

This is an estimate from reading `main` at `285d4e09b`, to within a few hundred lines per row.

| Area                       | Today                                                                                          | Change                                                                                                               | Net  |
| -------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---- |
| Contract                   | `protocol/message.ts` 2,018 lines with 34 builders; event IDs and dedupe 60                    | Zod schemas for 30 types, envelope, runtime catalog, checker; builders become typed literals at owners               | −900 |
| Emitters                   | 87 builder calls in 18 files; coordinate plumbing                                              | Scope stamped centrally; run and part IDs; no `sequence` or `stepIndex`                                              | −100 |
| Publisher                  | `publish-session-events.ts` 511, ordered emitter 278                                           | A commit as one line; position counter; write → channels → hooks; observer `ctx`; no `session.waiting`               | +100 |
| Route and transport        | `eve-channel/request.ts` 684, `open-stream.ts` 387, `ndjson.ts` 162                            | Catch-up filtering with markers; `stream.ended`; idle budget and version branches removed                            | +70  |
| Deliveries                 | Delivery-ID stamping; controls without auth                                                    | Three facts, the settle rule, `ignored` and `refused`, controls and callbacks as deliveries, settling at session end | +380 |
| Calls, tasks, turn closure | Cancel paths repair history only                                                               | `call.started`, `task.ended`, `outputOf`, `turn.resumed`, interrupted parts, best-effort settlement                  | +180 |
| Interactions               | HumanInput's 26 v26 builder calls in `hitl/`                                                   | Responses for every answer, one interaction per sign-in attempt, atomic batch settlement                             | +50  |
| Retry recovery             | —                                                                                              | Recovery read, closures, skipped determined facts, last-line replay, in-step abandonment                             | +250 |
| Server fold                | `protocol/session-projection.ts` 685                                                           | Delivery, run, part, response, child, and context families; per-family tolerance; two retention modes; previews      | +300 |
| Server stream scans        | Telegram, the invocation window, the remote binding scan                                       | Shared fold and the private side stream                                                                              | −100 |
| Relay                      | `forward-session-input.ts`, `callback-route.ts`, `hitl-proxy.ts`, `event-proxy-step.ts` (~700) | Tolerant relay messages keyed by child IDs, retried after the write                                                  | +50  |
| Client reducers            | Message reducer family 1,353; conversation reducer and state 390                               | Tables, selectors, `extendConversation`; the UI model keyed by IDs                                                   | −250 |
| Client response boundaries | `TurnSegment`, delivery-ID filtering, `message-response.ts`                                    | `delivery.settled` and `turn.settled.reply`                                                                          | −270 |
| Evals, TUI, `invoke`, ACP  | `derive-run-facts.ts` 263, ACP adapter 665, TUI reducer                                        | Selectors and renames                                                                                                | −140 |
| Channels                   | About ten `finishReason` checks; task cards 470 and 485                                        | `phase`; no receipt special case; renames                                                                            | −100 |
| Files                      | AI SDK part types; `data:` URLs                                                                | eve-owned parts, refs, the file content kind                                                                         | +60  |
| Instrumentation bridge     | `instrumentation/native-events.ts` 403                                                         | Facts mapped onto its unchanged vocabulary                                                                           | +30  |

- **Source:** about −400 lines net, out of roughly 10,000 touched across about 160 source files. The plausible range is +300 to −1,200. The types added in review (`model.requested`, `call.started`, responses, `usage.recorded`) mostly ride existing code paths and stay within each row's precision. Deletions are inference code and coordinate plumbing; additions are deliveries, recovery, catch-up, and closure, which are new guarantees rather than reshuffled code. Interactions are the least certain row, because HumanInput's final shape isn't settled.
- **Removed by the compatibility cut, beyond that:**
  - the v21–v26 normalization (258 lines, plus client handling);
  - hook and channel epoch fixtures (71 files, about 850 lines);
  - the legacy session import (638 lines);
  - remote agent protocol 1 (172 lines).

  That's about −1,900 in total.

- **Tests:** 187 test files quote v26 type names (about 2,400 references) and make about 670 builder calls. That's the largest churn: about 6,000–10,000 lines touched, roughly flat in net.
- **Docs:** 56 pages mention v26 names (about 690 mentions). Some are participant keys, which go away in the same release when participants become functions.
- **Phase 1** adds about 3,000–4,000 lines, mostly the contract module and tests, which the break then uses.

Lifecycle records per turn, not counting progress:

| Scenario                                | v26 events | v27 facts | Difference                                                                                             |
| --------------------------------------- | ---------- | --------- | ------------------------------------------------------------------------------------------------------ |
| A message and a text reply              | 7          | 10        | `delivery.admitted`, `delivery.settled`, `model.requested`, and `usage.recorded`; no `session.waiting` |
| Three parallel tool calls, then a reply | 13         | 23        | The same per run, plus `call.requested` and `call.started` per call instead of one `actions.requested` |
| Ten parallel tool calls, then a reply   | 20         | 44        | The same, with ten calls                                                                               |
| The declined approval above             | 16         | 24        | Two of each delivery fact, `turn.resumed`, and the response's facts; one settlement, not three         |

v27 writes more lifecycle facts, because deliveries get explicit ends, every call gets its own request and start, and runs record when they were requested and what they spent. The added facts mostly ride commits that exist anyway: `model.requested` lands with what caused it, `call.started` with an auto-cleared call's request, and `usage.recorded` with the run's terminal. Facts in one commit share a line, so the line count is lower than the fact count. Progress dominates line counts either way, and catch-up skipping removes it from reloads.

</details>

### Validation

<details>
<summary>Checks for each family change, and before release</summary>

- **Every family change runs:**
  - the checker over golden streams;
  - old-reader conformance;
  - the tolerance cases;
  - every reader it touches, in the same change.
- **Scenario suites:**
  - cancel mid-tool;
  - an approval batch with a revision;
  - a sign-in callback delivery, and a repeated callback;
  - a task outliving its turn;
  - a child relay, local and remote;
  - a handoff;
  - injected step and in-step retries;
  - a crash after a write and before dispatch, where the last line is dispatched again exactly once.

  They assert observer invocations, the view at each commit, and positions.

- **Cost:** the golden-stream metrics rerun after the envelope lands and before release: lines, bytes, reload time to first byte, catch-up memory high-water, and writer flush latency.
- **Scale smoke:** 32 working tasks with long progress, and a 100,000-line session reload, on world-local and world-vercel.

</details>

### Accepted risks and non-goals

<details>
<summary>The risks this accepts, and what it doesn't try to do</summary>

**Accepted risks:**

- **Zombie writers** until Workflow provides fencing.
- **The writer's flush window:** observers may act on a fact that never became durable after a process crash.
- **At most one repeated observer invocation** after a step retry.
- **External delivery.** No guarantee that an external effect succeeded, or happened only once.
- **Duplicated chunks** from HTTP write retries.
- **Self-hosted sessions** strand at the break unless their services drain.
- **Sign-in links are credentials.** Whoever completes one binds their account to the session, as today.

**Non-goals:**

- A generic `entity.updated` or patch event.
- A queue for task-limit refusals; the model retries, as today.
- Forwarding child events into the parent stream.
- Projection snapshots on the wire.
- Per-type versions.
- A declarative state-machine language.
- Publishing private records on the wire to make state reconstructible. A private log is a separate, later direction ([Toward a session log](#toward-a-session-log)).
- Unifying HITL execution or authorization rules just because their lifecycle is unified.

</details>
