---
title: "Upgrade to v27 Session Events"
description: "Move hooks, channels, clients, and evals from the v26 event stream to v27 facts."
---

Session stream version 27 replaces the v26 event vocabulary with explicit lifecycles. Every
entity a session works with, such as a turn, a model run, a call, or a person's approval, is
introduced once and settled once with an outcome, and every state change commits as one line.
See [Sessions, runs & streaming](./sessions-runs-and-streaming) for the full contract.

This page covers what to change. Work through the sections that apply to your agent.

## What changes for whom

| You author…                               | What changes                                                                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Hooks (`agent/hooks/`)                    | Event keys and payloads. Handlers keep `(event, ctx)`; `ctx` adds `position` and `view`.                                                   |
| Channel `events` handlers                 | Event keys and payloads, and the handler signature: `(event, ctx)`, with your context on `ctx.channel`.                                    |
| Slack renderers                           | Event keys and payloads; handlers take `(event, ctx, next)`.                                                                               |
| Clients, frontends, and evals             | Event types, cursors (line positions), event identity (`meta.position`), and interaction names.                                            |
| Channel config, workflow tools, policies  | Names: `onAnswers`, `ToolQuestion`, `request.interactionId`. See [Renamed APIs](#renamed-apis).                                            |
| MCP clients and `eve invoke` scripts      | Pending questions and sign-ins are `interactions`, keyed by `interactionId`.                                                               |
| `defineDynamic` resolvers                 | Nothing in this release. The keys stay; the event argument is now the matching v27 fact.                                                   |
| Memory providers                          | Nothing in this release.                                                                                                                   |
| Instrumentation (`defineInstrumentation`) | Session, turn, call and input events take the stream's names; see [Instrumentation](/docs/observability/instrumentation#lifecycle-events). |

A hook or channel keyed on a removed v26 event fails as eve loads it, with the key to use instead,
rather than silently never firing. Hook, channel, and schedule extensions built for earlier
epochs must be rebuilt.

## Event mapping

| v26 event                 | v27                                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `message.received`        | `delivery.consumed`                                                                                                         |
| `message.appended`        | `content.delta` (progress) for a `kind: "text"` part                                                                        |
| `message.completed`       | `content.completed`; `phase: "reply"` marks the reply, instead of `finishReason`                                            |
| `reasoning.appended`      | `content.delta` for a `kind: "reasoning"` part                                                                              |
| `reasoning.completed`     | `content.completed` with `kind: "reasoning"`                                                                                |
| `result.completed`        | `content.completed` with `kind: "result"`                                                                                   |
| `step.started`            | `model.started`, once per attempt, or `model.requested` before the model is chosen                                          |
| `step.completed`          | `model.settled`                                                                                                             |
| `step.failed`             | `model.settled` with `outcome: "failed"`                                                                                    |
| `action.input.appended`   | `call.input` (progress)                                                                                                     |
| `actions.requested`       | `call.requested`, one per call                                                                                              |
| `action.partial`          | `call.progress` (progress)                                                                                                  |
| `action.result`           | `call.settled`, the only place a call's output appears                                                                      |
| `task.started`            | `task.started` once per task, and `call.started` with `taskId` for each call it serves                                      |
| `task.settled`            | `call.settled` for each call the task served; `task.ended` when the task's run ends                                         |
| `agent.started`           | `child.opened`                                                                                                              |
| `input.requested`         | `interaction.opened`, one per request                                                                                       |
| `input.resolved`          | `interaction.settled`, one per request                                                                                      |
| `approval.candidate`      | `response.submitted` and `response.settled` (`refused`, `failed`, `expired`, `withdrawn`)                                   |
| `approval.settled`        | `interaction.settled` with `outcome: "accepted"` or `"declined"`; `cause.responseId` names the deciding answer              |
| `authorization.required`  | `interaction.opened` with `request.kind: "sign-in"`                                                                         |
| `authorization.completed` | `interaction.settled` for the sign-in                                                                                       |
| `compaction.requested`    | `context.started` with `kind: "compaction"`                                                                                 |
| `compaction.completed`    | `context.settled` with `kind: "compaction"`                                                                                 |
| `context.cleared`         | `context.settled` with `kind: "clear"`                                                                                      |
| `turn.waiting`            | `turn.paused`, when the turn waits on people; `awaiting` names the interactions it waits on                                 |
| `turn.completed`          | `turn.settled` with `outcome: "completed"`                                                                                  |
| `turn.failed`             | `turn.settled` with `outcome: "failed"`                                                                                     |
| `turn.cancelled`          | `turn.settled` with `outcome: "cancelled"`                                                                                  |
| `session.waiting`         | `delivery.settled` (a message's response is done) or `turn.settled`; `idle(view)` from `eve/events` says nothing is running |
| `session.completed`       | `session.ended` with `outcome: "completed"`                                                                                 |
| `session.failed`          | `session.ended` with `outcome: "failed"`; a turn it held settles `cancelled`, not failed                                    |

New facts with no v26 counterpart: `delivery.admitted` and `delivery.settled` (every message,
answer, control, and callback), `model.requested`, `model.retried`, `call.started`,
`response.admitted`, and `usage.recorded`.

A turn that waits on its own work, such as a task it started, doesn't pause: it stays running
until the work reports back. Only a turn waiting on a person (an approval, a question, a sign-in,
or the budget prompt) pauses, and nothing announces that it resumed: the next fact under the turn
says so.

## Payloads

- **Facts carry `scope`.** Turn, run, task, and context-change coordinates move from `data` into
  `scope` (`{ turnId, runId, taskId, changeId }`). `sequence` and `stepIndex` are gone; order by
  position instead.
- **Replies and narration.** A text part's `phase` is `"reply"` or `"narration"`. Text written
  before more work is narration; `turn.settled.data.reply` lists the reply's part ids.
- **Calls.** `call.requested` names its `capability` (`{ kind, name, label? }`) and carries its
  `input`. `call.settled` carries `outcome` (`completed`, `failed`, `rejected`, `interrupted`,
  `abandoned`) and `output` or `error`, but not the tool's name: match it to its
  `call.requested` by `callId`, or read `ctx.view.calls[callId]`. A call fails only when its
  result sets `isError`.
- **Model attempts.** `model.started` repeats once per attempt at the provider call, with
  `attempt` (0 for the first). `model.retried` records an attempt that failed and is tried again
  in the same run, with its `error`, before the backoff. A run given up after it published output
  settles `abandoned`, and the run replacing it continues the count.
- **Interactions.** `interaction.opened` carries the `request` (`kind` is `approval`, `question`,
  `sign-in`, or `budget`) and what it's about (`subject`: a call, a task, or a turn); a sign-in's
  challenge is in `request.signIn`. `interaction.settled` carries its `outcome` (`accepted`,
  `declined`, `invalid`, `failed`, `withdrawn`, `interrupted`, `abandoned`, `expired`). Outcomes,
  kinds, displays, and option styles are closed sets in TypeScript, and a later minor release can
  add to them: keep a default branch when you switch on one. See
  [what a later release can add](./sessions-runs-and-streaming#what-a-later-release-can-add).
- **Usage.** Usage is recorded on `usage.recorded` per model run, delegated call, or compaction,
  rather than copied onto turn and session terminals. Sum the records, or read `view.usage.total`.
- **Errors.** Failures carry `error: { code, message, id?, hint? }`.

## Renamed APIs

The interaction vocabulary replaces input requests and responses everywhere:

| v26                                                                     | v27                                                                                                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `InputRequest`, `InputResponse` (`requestId`)                           | `Interaction`, `Answer` (`interactionId`)                                                                                |
| `send({ inputResponses })`, `respond(inputResponses)`                   | `send({ answers })`, `respond(answers)`                                                                                  |
| `parseInputResponse`, `parseInputResponses`, `isInputResponse`          | `parseAnswer`, `parseAnswers`, `isAnswer`                                                                                |
| A response's `inputRequests` and `authorizations`                       | `interactions`, sign-ins included                                                                                        |
| `ConversationState.inputs`, `ConversationInput`                         | `view.interactions`, `Interaction`                                                                                       |
| `openConversationInputs(state)`                                         | `openInteractions(view)` from `eve/events`                                                                               |
| `EveAuthorizationPart`, `EveMessageInputRequest`                        | `EveInteractionPart` (`type: "interaction"`)                                                                             |
| `dynamic-tool` part, `toolMetadata.eve.inputRequest` / `inputResponse`  | `tool` part (`EveToolPart`), `part.interaction` with its `answer`                                                        |
| `conversationReducer`, `defaultMessageReducer`, `EveAgentReducer`       | Removed: read `view`, `previews`, `messages`, and `agents` directly                                                      |
| `transcriptReducer(options)`                                            | `transcriptOf(events, options)`                                                                                          |
| `toolCallState(conversation, callId)`                                   | The call's `tool` part                                                                                                   |
| Evals: `inputRequests`, `pendingInputRequests`, `requireInputRequest()` | `interactions`, `pendingInteractions`, `requireInteraction()`                                                            |
| `slackChannel`, `discordChannel`, `teamsChannel`: `onInputResponse`     | `onAnswers`, with `SlackAnswerContext`, `SlackAnswerSubmission`, `SlackAnswerResult`, and the same for Discord and Teams |
| Telegram `renderTelegramInputRequest`, `resolveTelegramInputResponses`  | `renderTelegramInteraction`, `resolveTelegramAnswers`; `telegramCallbackAnswer`, `telegramReplyAnswer`                   |
| Workflow `ctx.ask()`: `ToolInputRequest`, `ToolInputResponse`           | `ToolQuestion`, `ToolAskOptions`, `ToolAnswer`; its `responder` is a `Principal`                                         |
| Approval policies: `request.requestId`                                  | `request.interactionId`                                                                                                  |
| Instrumentation `input.*`: `requestId`, `action`, `response`            | `interactionId`, `call` (absent for a request about no call), `answer`                                                   |

Posted Slack, Discord, Teams, and Telegram controls keep their routing encodings, so buttons posted
before the upgrade still reach their owning deployment. New approval and budget prompts use
`APPROVE_OPTION_ID` (`"approve"`) and `DENY_OPTION_ID` (`"deny"`) from `eve/events`; change custom
buttons and `ApprovalResponse.decision` checks from `"cancel"` to `"deny"`. Pre-v27 sessions
continue to decode their own earlier options.

Readers use `interaction(view, interactionId)` from `eve/events`. Its `interactionId`, `call`,
`status`, `answer`, and location are top-level; the prompt fields stay under `request`, matching
`InteractionRow`. A submitted answer leaves `status: "open"` until the interaction settles. CLI
and MCP JSON results use the same nesting and omit `request.signIn.callbackUrl`.

Call labels use `capability.label`, `call.progress.data.label`, `call.settled.data.label`, and
`CallRow.label`. A prompt's heading still uses `request.title`. Stream parts use `kind`, because
`type` names their event; authoring and UI parts keep their `type` discriminant. Task cancellation
reasons use kebab case: `task-cancel`, `turn-cancelled`, and `turn-ended`.

## Hooks

Change keys and payloads. A hook's context gains `ctx.position`, the event's place on the stream,
and `ctx.view`, the session's tables as of the event's commit:

```diff title="agent/hooks/audit.ts"
 import { defineHook } from "eve/hooks";
 import { toolResultFrom } from "eve/tools";
 import getWeather from "../tools/get-weather";

 export default defineHook({
   events: {
-   "message.completed"(event) {
-     if (event.data.finishReason === "tool-calls") return;
-     log(event.data.message);
-   },
-   "action.result"(event) {
-     const weather = toolResultFrom(event.data.result, getWeather);
-   },
+   "content.completed"(event) {
+     if (event.data.phase !== "reply") return;
+     log(event.data.value);
+   },
+   "call.settled"(event, ctx) {
+     const weather = toolResultFrom(ctx.view.calls[event.data.callId], getWeather);
+   },
   },
 });
```

Progress records (`content.delta`, `call.input`, `call.progress`) reach only handlers keyed on
their type; `*` no longer receives them. Key stored rows on `(session, line, index)` from
`ctx.position` instead of `meta.id`. See [Hooks](../guides/hooks).

## Channels

Channel `events` handlers take `(event, ctx)`: the whole fact with its `type`, `data`, and
`scope`, and a context whose `ctx.channel` is your channel's context, including
`ctx.channel.continuation`. Handlers run after the line is written, so they observe facts and
cannot change them.

```diff
 events: {
- "message.completed"(eventData, channel, ctx) {
-   if (eventData.finishReason !== "tool-calls") channel.thread.post(eventData.message);
- },
+ "content.completed"(event, ctx) {
+   if (event.data.phase === "reply") ctx.channel.thread.post(String(event.data.value));
+ },
 },
```

Slack renderers take `(event, ctx, next)`, with Slack's handles on `ctx.channel.thread` and
`ctx.channel.slack`. Pass a changed fact to `next(event)` to hand it on. A sign-in's
`interaction.opened` receives only the private delivery surface as `ctx.channel`. See
[Slack: Customize rendering](../channels/slack#customize-rendering).

A Slack renderer's `taskCard(card, next)` receives a `TaskCard` instead of a `TaskCardView`:
the card's calls as table rows, with `view` to read them by, in place of `tasks` and `actions`.
Read a row's `taskId` for a task, `callState(card.view, callId)` for its status,
`callLabel(row)` for its title, and `waiting(card.view, { callId })` for what it's blocked on.
`TaskCardTask`, `TaskCardAction`, `TaskCardBlocker` and `TaskCardStatus` are gone.

A channel that keeps something in step with the session can handle `committed`, once per
committed line with the line's facts and `ctx.view`, instead of several facts.

### Delivery hooks and channel identity

A `deliver(payload, channel)` hook receives `ChannelDelivery<TState>` from `eve/channels`:
`message`, `answers`, `context`, `outputSchema`, and typed per-delivery `state`. Return the same
shape to replace the payload, or return nothing to keep it unchanged. To ignore a delivery,
return `{}` instead of `undefined`. Stop importing harness input types or building a default
harness projection in the hook.

Authored channels use `channel:<name>` in hooks, instrumentation, and a delivery's
`source.channel`, including channels that only declare routes. `isChannel` now matches those
channels in hooks. The internal adapter key used to restore durable sessions is unchanged.
Remove `kindHint` from channel definitions; the file path determines the public identity.

Move a visibility classifier from `metadata().audience` to `audience(input)`. Metadata no longer
classifies visibility, and a channel without an audience hook is `unknown`.
See [Custom channels](../channels/custom) for payload and audience examples.

## Approval policies

Existing policy return values still work, including booleans and the string and object statuses.
`call.started` records whether a policy or a remembered approval cleared the call. Response
policies keep `{ status: "allowed" | "rejected" }`.

Replace `approvalKey` with [`once({ key })`](../human-in-the-loop#remember-approval-for-a-scope)
and remove uses of `ApprovalContext.approvedTools`. `once()` without options still remembers
approval by tool name; only prompts asked by `once()` create its grants. Replace `ToolApproval`
and `ToolApprovalConfiguration` imports with `Approval` and `ApprovalConfiguration`, which
support the optional `prompt`. Rebuild tool, dynamic-tool, and connection extensions against
the new capability epochs.

## Instrumentation

Instrumentation events about what a session's stream records take the stream's names, and an
operation's endings become one event with the fact's `outcome`: `session.ended`,
`turn.settled`, `call.requested` and `call.settled`, `interaction.opened` and
`interaction.settled`. `session.waiting` is gone; a turn's end is `turn.settled`. See the table
in [Instrumentation](/docs/observability/instrumentation#lifecycle-events).

- Replace `channel.delivery.*` with `delivery.consumed` and `delivery.settled`. A pause settles
  the delivery `awaiting-input`; an answer owns the resumed work's delivery.
- Replace `step.attempt.*` with `model.started`, `model.retried`, and `model.settled`. Provider
  metadata moves to `model.call.settled`, not the run's terminal.
- Provider calls and memory operations each use one `.settled` event with `outcome`.
- Scopes use `runId` and `attempt`, not step indices or an encoded attempt id. `turnId` is
  optional for compaction and direct tool calls.
- Type handlers with `InstrumentationEvent<"call.settled">`; per-event type exports are gone.
  Model input content is `unknown`, not AI SDK message types.
- Read `capability` instead of `kind` or `isWorkflowTool` on `call.requested`. Keep `frameworkTool`.
  Import channel metadata types and `isChannel` from `eve/channels`.
- A runtime-context resolver receives `run: { id, attempt }` in place of `step.index`.
  Its input type is `InstrumentationModelStartedInput`.

The OpenTelemetry trace schema remains version 4, with the same span names and attributes.

## Commands and session handles

Sends, answers, and session controls return a `Delivery` directly. Its own `sessionId` and
`deliveryId` are serializable without reading the stream. Iterate it or call `result()` to follow
that exact command's settlement. Replace `MessageResponse` and `MessageResult` imports with
`Delivery` and `DeliveryResult`. `ChannelSource.send()` returns a delivery too; use its `sessionId`
to attach a session handle when you need one.

A refused inactive-session command throws `SessionNotActiveError`; its `retryable` flag distinguishes
an inbox still starting from a session that cannot accept more work. There are no separate
`no_active_turn` or `no_active_session` control results. A cancellation delivery settles when
applied; a reset delivery settles after retirement and address release.

Session readers expose `id` and `stream()`. `sessions.attach(id)` from `eve/server` returns a
`SessionReader` without I/O, not a `ServerSession`. Channel handles carry the existing commands
through `SessionOperations`; a reader does not acquire command authority. The data type previously
exported as `Session` from `eve/context` is now `SessionInfo`, exactly the metadata in `ctx.session`:
`id`, `auth`, `turn`, optional `parent`, `schedule`, and `predecessor`.

Every reader takes `SessionStreamOptions` from `eve/client`, replacing `StreamOptions` and
`GetEventStreamOptions`. `startIndex` addresses durable lines, matching `meta.position.line`,
not individual events. The shared options include `follow` and `signal`; only the client uses
`streamReconnectPolicy`. Client handles (`ClientSession`, `ClientAgentSession`, `ClientSessions`)
are type-only exports. Obtain them from `new Client()` and its methods instead of constructing them.

## Decision models

`decide` from `eve/ai` now accepts eve-owned `DecisionOptions` and returns `DecisionResult`:
`answers` and `usage` only. Replace the `abortSignal` request option with `signal`; SDK telemetry,
callbacks, `_internal`, headers, provider options, and response metadata are not public options or
results. Import question, state, answer, and model types from `eve/ai`, not AI SDK's experimental
aliases. Both `auto()` helpers and eval judges use the same `DecisionModel` contract; installed
provider instances still use the SDK's runtime model-version checks and authentication.
Eval diagnostic metadata continues to include provider response details internally.

## Owned platform types

Slack card builders now return eve-owned plain-data types. The upstream-only
`AdapterPostableMessage` and `Attachment` exports are removed; use Slack message options
and `SlackAttachment` instead. Chat SDK adapters still use the app's own `chat` classes
through `eve/channels/chat-sdk`.

`eve/sandbox/vercel` no longer re-exports `Drive`. Apps that create drives import it from
`@vercel/sandbox` and pass `{ drive: drive.driveId, mode: "read-write" }` or
`drive.snapshot()` as a mount. Sandbox creation and firewall settings use eve-owned types.

Next.js apps import `NextConfig` from `next`, not the removed `EveNext*` aliases.
Reusable eve config callbacks can use `WithEveConfigFunction` and `WithEveConfigInput`.
`eve/workflow-modules` now declares only the authored workflow helpers documented by eve,
not the entire vendored Workflow SDK.

## Retired aliases and internal helpers

Mount `eve/extensions/git` with `github` settings instead of `code({ github })`, and import
computer-use tools from their own extension. `eve/models/openai` exports `chatgpt`, not
`experimental_chatgpt`. `defineExtension` takes only its options, not a namespace argument.

Audience callbacks take `AudienceContext` and its privacy-limited `caller`; `auth`,
`AudienceInput`, and `AudiencePrincipal` are removed. Event framing records and loader-only
guards are not public authoring APIs. `JsonValue`, `JsonObject`, `JsonArray`, and `JsonPrimitive`
have one public home, `eve/events`.

`grep` and `code__grep` now share the code extension's modes, bounded output, and workspace
containment. The default output lists matching files; pass `outputMode: "content"` to retain
line output. `limit` bounds returned rows (50 by default, maximum 200), not matches per file.

## Clients and frontends

- **Frontend commands resolve on acceptance.** `EveAgentStore.send()` and the frontend hooks'
  `send()`/`respond()` return a `Delivery` without waiting for a reply or question. Observe `view`
  and callbacks, or await `delivery.result()`, which reads the store's existing stream rather than
  opening a second one. `resume()` resolves after bounded catch-up, without waiting for a turn to end.
- **Read the native tables.** Frontend snapshots expose `view` and `previews`. Replace `data.activeTurnId` with `activeTurn(view)?.turnId`,
  `data.turns[turnId].waiting` with `waiting(view, turnId)`, and `data.tasks[taskId].calls`
  with calls in `view.calls` whose `taskId` matches. Turns have `status: "running" | "settled"`
  and a separate `outcome`, just like the event fold. The reduced `ConversationTurn`,
  `ConversationTask`, and `ConversationTaskCall` types are removed.
- **Read v27 lines.** The client accepts stream version 27 only. Each stored line is a commit
  (`{at, facts}`) or a progress record (`{progress}`); the client materializes each as an event.
- **Cursors are line positions.** `streamIndex` and `startIndex` count stored lines, not events.
  Saved cursors from v26 sessions don't apply to v27 sessions.
- **Identity is `meta.position`.** `meta.id` is gone. Deduplicate on `(line, index)`.
- **Responses end on their delivery.** A message's response ends when its `delivery.settled`
  arrives, finishing that line. `result().status` now uses `RequestStatus`: `working`,
  `awaiting-input`, `completed`, `failed`, or `cancelled`. **`completed` has changed meaning:**
  it means the request completed, not that the session ended. Replace old `completed` checks for
  session termination with `sessionEnded`; old `waiting` comparisons no longer typecheck. Read text
  from `reply`, not `message`. `requestStatus(view, deliveryId)` from `eve/events` applies the same rule.
- **Interactions.** Every interaction a person is asked, sign-ins included, is in one list:
  `view.interactions`, a response's `interactions`, `openInteractions(view)`. Filter
  by `request.kind`. An approval or a question about a call shows on its call's tool part
  (`part.interaction`); every other interaction, such as a sign-in or the budget prompt, is an
  `EveInteractionPart` of its own.
- **Tool parts share call state.** `EveToolPart.state` is `"streaming"` with partial `inputText`,
  then the shared `CallState`: `requested`, `approval`, `running`, `blocked`, `completed`, `failed`,
  `rejected`, or `cancelled`. `kind` and `stepIndex` are required. Read raw outcomes, reasons,
  and task identities from `view.calls[part.callId]`; duplicated part fields are removed.
- **Flat snapshots.** The hook and store expose `view`, `previews`, `messages`, `agents`,
  `events`, `session`, `status`, and `error`, without a `data` wrapper. Status is `idle`, `busy`,
  or `resuming`; errors are separate. All callbacks stay. Save `events` and `session` as they
  change, not only in `onFinish`, so pauses survive reloads.
- **No local interaction lifecycle.** Optimistic answers last only through the POST round trip;
  response rows then own them. An interaction remains `open` until settlement, not `responded`.
- **Use the shared fold.** `eve/events` exports the catalog, the fold that turns facts into tables,
  and selectors such as `activeTurn`, `reply`, `openInteractions`, `waiting`, and `idle`, so a
  client doesn't need its own reducer for session state. `callState(view, callId)` says where a
  call stands for a display, `callLabel(row)` how to name it, and `waiting(view, { taskId })` or
  `waiting(view, { callId })` who a task's or call's work waits on.
- **Distinguish local and server resets.** Call `newSession()` to clear local frontend state and
  its cursor. `reset()` now retires the server-side session and returns its delivery.
- **Follow children with `child.opened`.** `session.agent(opened)` takes a `child.opened` event.

## Evals

- Rename `loadedSkill` to `calledSkill`, `calledSubagent` to `calledAgent`, `noFailedActions` to
  `noFailedCalls`, and `parked()` to `awaitingInput()`. `calledTool` and call-count/order assertions stay.
- Replace `await t.target.attachSession(id)` with `const session = t.target.attach(id)` followed by
  `await session.nextTurn()`. Attachment is I/O-free. Replace `t.target.watchTurn(id, options)` with
  `t.target.attach(id, { startIndex }).watch({ until })`, passing only the options you need. Reads
  advance the handle's cursor. Eval session handles use `id`; accepted turns still expose `sessionId`.
- Turn results expose `view`, `reply`, `data`, `sessionEnded`, and the shared request status.
- Match v27 facts in `t.event(...)`, `eventOrder(...)`, and `waitForEvent(...)`. Event matchers can
  match a fact's `scope`.
- `turn.waitForToolCall(name, options)` waits for a settled call to a tool. Replace `toolCallsOf`
  with `Object.values(turn.view.calls)`; names are `call.capability.name`, and settled results use
  `call.outcome`. Use `callOutputSource(turn.view, call.callId)` from `eve/events` when a call shares
  another call's output. Eval tool calls still carry their `callId`.
- The subagent matcher's `remoteUrl` is removed, and a subagent call's `status` is `pending` until
  it settles, then its outcome (`completed`, `failed`, `rejected`, `interrupted`, `abandoned`).
- Interactions are `interactions`, `pendingInteractions`, and `requireInteraction(filter)`, sign-ins
  included; match on `kind`.

## Public imports and authoring types

- Import fact and view types from `eve/events`, `SessionContext` and `HistoryMessage` from
  `eve/context`, and assertion types and `ToolStub` from `eve/evals`. The client no longer
  re-exports the event catalog's types. Named judge, mock-model, approval, and disabled-marker
  types remain available.
- Connection authorization uses `principalType: "app" | "user"`; omitted getToken-only
  ownership defaults to `"app"`. Replace `credentialOwner` and use `AuthorizationDefinition`
  instead of `ConnectionAuthProvider`.
- All channels use `ChannelCors`. Use `allowHeaders`, `exposeHeaders`, and
  `preflight: { statusCode }`; `origin` accepts a single string or an exact-origin list.
- History and sandbox types are eve-owned. Replace `RuntimeSandboxSessionFor<S>` with
  `RuntimeSandboxSession<S>`; the eight sandbox method option types remain exported.
- Session handles read with `stream()`. `getEventStream`, `getLineStream`, and `getChildBinding`
  are no longer public handle methods. Callback routing and forwarded initiator auth are
  framework plumbing, not authored send options.
- Platform entries keep channel factories, default auth, continuation-token helpers, and authoring
  types. Raw platform calls, verification, rendering, and wire constants are internal, except for
  the documented Slack, Linear, and Chat SDK helpers. Built-in tool schemas remain on the tool
  definitions; separate schema constants are no longer exported.
- `eve/setup` is no longer public. Scaffold integrations move to `eve/internal/scaffold`.
  `eve/internal/*` and `eve/experimental/*` have no compatibility promise.
- Mount `eve/self-modification/local` or `/remote` explicitly. The bare entry and `/config` are
  removed. Preserve authored changes before removing the retired
  `agent/subagents/self-modification/` layout; setup reports the replacement mount rather than
  deleting those files.

## MCP and `eve invoke`

- **MCP channel.** `input_required` remains the wire spelling for `awaiting-input`; sign-ins now
  use it too, instead of `authorization_required`. Questions, approvals, and sign-ins share
  `interactions`, keyed by `interactionId`. Answer all non-sign-in entries in one `agent_update`
  call with `responses: [{ interactionId, optionId?, text? }]`. Complete sign-ins externally and
  poll again. An id names one interaction for the session's life, so an earlier batch's ids never
  answer a later one. `sessionEnded` separately reports session termination.
- **`eve remote invoke`.** JSON results use the shared request statuses, `reply`, `data`, and
  `sessionEnded`, without a nested `outcome`. Resume coordinates include the original `deliveryId`.
  Deployment authentication failures are CLI errors, not session statuses. An `awaiting-input`
  sign-in resumes without a prompt once completed.
- **Direct tools.** `invokeTool` returns a call-shaped `outcome`: `completed` with `output` and
  `modelOutput`, `failed` with `error: ErrorInfo`, or `rejected` with a `reason`, optional
  `connections`, and optional policy `cause`. Invalid input is a failure with `error.code`;
  approval and sign-in requirements are rejections, never conversational pauses.

## Sessions and remote agents

- **Handoff.** A session started on an earlier build continues on the deployment that owns it,
  because its stream uses the earlier event shape, for as long as that deployment exists. New
  sessions use v27. Channels keep working with such a session: its own deployment posts its
  replies and prompts, and an answer a person gives on a v27 deployment, a pressed button
  included, still reaches it. A v27 frontend can't show it: the session's stream holds earlier
  events, which v27 clients skip, so it reads as empty. On the server, `stream()` and
  `transcriptOf` read its messages and replies, without its calls or prompts.
- **Remote agents.** The remote agent protocol moves to 3. A remote agent still serves callers on
  protocols 1 and 2 their results and failures, but relays no approvals, questions, or sign-ins to
  them; a turn that needs one fails and names the upgrade. A parent follows only a protocol-3
  child's live stream; an earlier child's result still arrives.
