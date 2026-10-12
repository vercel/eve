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

| You author…                               | What changes                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Hooks (`agent/hooks/`)                    | Event keys and payloads. Handlers keep `(event, ctx)`; `ctx` adds `position` and `view`.                |
| Channel `events` handlers                 | Event keys and payloads, and the handler signature: `(event, ctx)`, with your context on `ctx.channel`. |
| Slack renderers                           | Event keys and payloads; handlers take `(event, ctx, next)`.                                            |
| Clients, frontends, and evals             | Event types, cursors (line positions), event identity (`meta.position`), and interaction names.         |
| Channel config, workflow tools, policies  | Names: `onAnswers`, `ToolQuestion`, `request.interactionId`. See [Renamed APIs](#renamed-apis).         |
| MCP clients and `eve invoke` scripts      | Pending questions and sign-ins are `interactions`, keyed by `interactionId`.                            |
| `defineDynamic` resolvers                 | Nothing in this release. The keys stay; the event argument is now the matching v27 fact.                |
| Memory providers                          | Nothing in this release.                                                                                |
| Instrumentation (`defineInstrumentation`) | Input events name their interaction (`interactionId`, `call`, `answer`); the event types stay.          |

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
| `session.failed`          | `session.ended` with `outcome: "failed"`                                                                                    |

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
- **Calls.** `call.requested` names its `capability` (`{ kind, name, title? }`) and carries its
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
| `InputRequest`, `InputResponse` (`requestId`)                           | `AskedInteraction`, `Answer` (`interactionId`)                                                                           |
| `send({ inputResponses })`, `respond(inputResponses)`                   | `send({ answers })`, `respond(answers)`                                                                                  |
| `parseInputResponse`, `parseInputResponses`, `isInputResponse`          | `parseAnswer`, `parseAnswers`, `isAnswer`                                                                                |
| A response's `inputRequests` and `authorizations`                       | `interactions`, sign-ins included                                                                                        |
| `ConversationState.inputs`, `ConversationInput`                         | `ConversationState.interactions`, `ConversationInteraction`                                                              |
| `openConversationInputs(state)`                                         | `openConversationInteractions(state)`                                                                                    |
| `EveAuthorizationPart`, `EveMessageInputRequest`                        | `EveInteractionPart` (`type: "interaction"`)                                                                             |
| `dynamic-tool` part, `toolMetadata.eve.inputRequest` / `inputResponse`  | `tool` part (`EveToolPart`), `part.interaction` with its `answer`                                                        |
| `conversationReducer`, `defaultMessageReducer`, `EveAgentReducer`       | Removed: `data` is the conversation; derive other state from `events`, or `conversationOf(events)`                       |
| `transcriptReducer(options)`                                            | `transcriptOf(events, options)`                                                                                          |
| `toolCallState(conversation, callId)`                                   | The call's `tool` part                                                                                                   |
| Evals: `inputRequests`, `pendingInputRequests`, `requireInputRequest()` | `interactions`, `pendingInteractions`, `requireInteraction()`                                                            |
| `slackChannel`, `discordChannel`, `teamsChannel`: `onInputResponse`     | `onAnswers`, with `SlackAnswerContext`, `SlackAnswerSubmission`, `SlackAnswerResult`, and the same for Discord and Teams |
| Telegram `renderTelegramInputRequest`, `resolveTelegramInputResponses`  | `renderTelegramInteraction`, `resolveTelegramAnswers`; `telegramCallbackAnswer`, `telegramReplyAnswer`                   |
| Workflow `ctx.ask()`: `ToolInputRequest`, `ToolInputResponse`           | `ToolQuestion`, `ToolAskOptions`, `ToolAnswer`, `ToolResponder`                                                          |
| Approval policies: `request.requestId`                                  | `request.interactionId`                                                                                                  |
| Instrumentation `input.*`: `requestId`, `action`, `response`            | `interactionId`, `call` (absent for a request about no call), `answer`                                                   |

Posted Slack, Discord, Teams, and Telegram controls keep their encodings, so buttons posted
before the upgrade still answer.

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

## Clients and frontends

- **Read v27 lines.** The client accepts stream version 27 only. Each stored line is a commit
  (`{at, facts}`) or a progress record (`{progress}`); the client materializes each as an event.
- **Cursors are line positions.** `streamIndex` and `startIndex` count stored lines, not events.
  Saved cursors from v26 sessions don't apply to v27 sessions.
- **Identity is `meta.position`.** `meta.id` is gone. Deduplicate on `(line, index)`.
- **Responses end on their delivery.** A message's response ends when its `delivery.settled`
  arrives, finishing that line. `result().status` keeps its meaning: `"waiting"` while the session
  stays open, `"completed"` once it ended, `"failed"` on failure.
- **Interactions.** Every interaction a person is asked, sign-ins included, is in one list:
  `ConversationState.interactions`, a response's `interactions`, `openInteractions(view)`. Filter
  by `kind`. An approval or a question about a call shows on its call's tool part
  (`part.interaction`); every other interaction, such as a sign-in or the budget prompt, is an
  `EveInteractionPart` of its own.
- **Tool parts are call rows.** A message's `dynamic-tool` part, with its seven AI SDK states, is
  now a `tool` part (`EveToolPart`) that reads its call's row: `callId`, `name`, `kind` (`tool`,
  `agent`, `skill`), `label`, `status` (`streaming` while the model writes the input, then
  `requested`, `running`, `settled`), `outcome` once settled (`completed`, `failed`, `rejected`,
  `interrupted`), `input` (`inputText` while it streams), `output`, `error`, `taskId`, and the
  latest approval or question about it as `interaction`. Replace `part.state` checks:
  `approval-requested` is `part.interaction?.status === "open"`, `output-available` is
  `outcome === "completed"`, `output-error` is `"failed"` or `"interrupted"`, and `output-denied`
  is `"rejected"`. `toolName`, `toolCallId`, and `toolMetadata` are `name`, `callId`, and the
  part's own fields. Messages have no `step-start` parts; each part carries `stepIndex`. When your
  stream stopped, decide yourself what an open call shows. `toolResultFrom` takes a settled call
  row, such as `ctx.view.calls[callId]`.
- **No custom reducers.** `useEveAgent({ reducer })`, `EveAgentReducer`, and the client reducer
  events are gone, and with them the snapshot's separate `conversation`: `data` is the
  conversation. Derive other state from `events`, for example with `useMemo`, or fold them
  with `foldReceivedEvent` from `eve/events`; `conversationOf(events)` reads saved events as a
  conversation. `transcriptReducer(options)` is `transcriptOf(events, options)`.
- **Use the shared fold.** `eve/events` exports the catalog, the fold that turns facts into tables,
  and selectors such as `activeTurn`, `reply`, `openInteractions`, `waiting`, and `idle`, so a
  client doesn't need its own reducer for session state.
- **Follow children with `child.opened`.** `session.agent(opened)` takes a `child.opened` event.

## Evals

- Match v27 facts in `t.event(...)`, `eventOrder(...)`, and `waitForEvent(...)`. Event matchers can
  match a fact's `scope`.
- `turn.waitForToolCall(name, options)` waits for a settled call to a tool, and `toolCallsOf(events)`
  derives tool calls from events. Eval tool calls always carry their `callId`.
- The subagent matcher's `remoteUrl` is removed, and a subagent call's `status` is `pending` until
  it settles, then its outcome (`completed`, `failed`, `rejected`, `interrupted`, `abandoned`).
- Interactions are `interactions`, `pendingInteractions`, and `requireInteraction(filter)`, sign-ins
  included; match on `kind`.

## MCP and `eve invoke`

- **MCP channel.** An `input_required` invocation lists its questions and approvals in
  `interactions`, keyed by `interactionId`; answer every entry in one `agent_update` call with
  `responses: [{ interactionId, optionId?, text? }]`. An `authorization_required` invocation lists
  its sign-ins in the same `interactions` shape, each with its `signIn` challenge. An id names one
  interaction for the session's life, so the ids of an earlier batch never answer a later one.
- **`eve invoke`.** A run that needs a person ends with one `input-required` status whose
  `interactions` include sign-ins; `authorization-required` is gone. A sign-in resumes once it
  completes, without a prompt.

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
