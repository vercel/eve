---
title: "Upgrade to v27 Session Events"
description: "Move hooks, channels, clients, and evals from the v26 event stream to v27 facts."
---

Stream version 27 changes event names, payloads, and client state. New sessions use v27; sessions started on an earlier deployment keep their earlier stream. Update event consumers and rebuild extensions before deploying. A v27 deployment serves an older session's stored history as v27 lines, so a v27 frontend renders it; its owning deployment can still serve its channels. See [Sessions, runs & streaming](./sessions-runs-and-streaming) for the current stream contract.

Don't pass event arrays saved before the upgrade as `initialEvents`. When the session's stream is still available, read it again from position 0 and replace what you saved. Saved cursors still count the same stored lines.

When the saved array is the only copy, for example because the stream expired, convert it once and store the result:

```ts
import { convertLegacyEvents } from "eve/internal/legacy-events";

// One session's saved events, from its `session.started` on, as they were saved.
const events = convertLegacyEvents(saved);
```

The result is what a reader of the session's stream gets today, at the same positions, so `conversationOf(events)` renders it and the next stored line is `saved.length`. A session saved mid-turn stays unfinished. Convert each session separately: the function throws for an array that doesn't start at `session.started`, that holds a second session, or that holds current events. `convertLegacyEvents` is a migration aid with no compatibility promise and will be removed in a later release.

## Event mapping

| v26                                                               | v27                                                                                                             |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `message.received`                                                | `delivery.consumed`                                                                                             |
| `message.appended`, `reasoning.appended`                          | `content.delta` (progress; check `kind`)                                                                        |
| `message.completed`, `reasoning.completed`, `result.completed`    | `content.completed` (check `kind`; text `phase: "reply"` identifies the answer)                                 |
| `step.started`, `step.completed`, `step.failed`                   | `model.started`, `model.settled` (check `outcome`); `model.requested` precedes model selection                  |
| `action.input.appended`, `action.partial`                         | `call.input`, `call.progress` (progress)                                                                        |
| `actions.requested`, `action.result`                              | `call.requested` (one per call), `call.settled`                                                                 |
| `task.started`, `task.settled`                                    | `task.started`, `task.ended`; each served call also has `call.started` and `call.settled`                       |
| `agent.started`                                                   | `child.opened`                                                                                                  |
| `input.requested`, `authorization.required`                       | `interaction.opened` (check `request.kind`, including `"sign-in"`)                                              |
| `input.resolved`, `authorization.completed`, `approval.settled`   | `interaction.settled` (check `outcome`)                                                                         |
| `approval.candidate`                                              | `response.submitted`, `response.settled`                                                                        |
| `compaction.requested`, `compaction.completed`, `context.cleared` | `context.started`, `context.settled` (check `kind`)                                                             |
| `turn.waiting`, `turn.completed`, `turn.failed`, `turn.cancelled` | `turn.paused` (for interactions), `turn.settled` (check `outcome`)                                              |
| `session.waiting`, `session.completed`, `session.failed`          | `delivery.settled` for a request, `session.ended` for a terminal session; use `idle(view)` for current idleness |

New facts include `delivery.admitted`, `response.admitted`, `model.retried`, and `usage.recorded`. A turn waiting on tasks remains running; only waiting for human input pauses it. Facts carry `scope` for turn/run/task coordinates. Replace event IDs and step sequence counters with `meta.position` (`line`, `index`); `startIndex` and saved cursors count durable **lines**, not facts. Key persisted events on `(sessionId, line, index)` to handle replay. Failures use `error: { code, message, id?, hint? }`. Usage belongs to `usage.recorded`, not terminal turn or session events.

## Renamed APIs

| Before                                                                 | Now                                                              |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `InputRequest`, `InputResponse`, `requestId`                           | `Interaction`, `Answer`, `interactionId`                         |
| `send({ inputResponses })`, `respond(inputResponses)`                  | `send({ answers })`, `respond(answers)`                          |
| `parseInputResponse(s)`, `isInputResponse`                             | `parseAnswer(s)`, `isAnswer`                                     |
| Response `inputRequests` and `authorizations`                          | `interactions` (including sign-ins)                              |
| `ConversationState.inputs`, `openConversationInputs(state)`            | `interactions(view)`, `openInteractions(view)` from `eve/events` |
| `conversationReducer`, `defaultMessageReducer`, `EveAgentReducer`      | Query opaque `view`; read `messages` and `agents`                |
| `transcriptReducer(options)`                                           | `transcriptOf(events, options)`                                  |
| `onInputResponse` on Slack, Discord, Teams                             | `onAnswers`                                                      |
| Telegram `renderTelegramInputRequest`, `resolveTelegramInputResponses` | `renderTelegramInteraction`, `resolveTelegramAnswers`            |
| Workflow `ToolInputRequest`, `ToolInputResponse`                       | `ToolQuestion`, `ToolAnswer`                                     |
| Approval `request.requestId`                                           | `request.interactionId`                                          |
| `MessageResponse`, `MessageResult`                                     | `Delivery`, `DeliveryResult` from `eve/sessions`                 |
| Creation result `{ session, response }`                                | `{ session, delivery }`                                          |
| Client and frontend target `host`                                      | `baseUrl` (direct client required; frontend default `""`)        |
| `EveAgentStore`                                                        | `SessionStore`                                                   |
| `StreamOptions`, `GetEventStreamOptions`                               | `SessionStreamOptions` from `eve/sessions`                       |
| Evals `inputRequests`, `pendingInputRequests`, `requireInputRequest()` | `interactions`, `pendingInteractions`, `requireInteraction()`    |

Use `APPROVE_OPTION_ID` (`"approve"`) and `DENY_OPTION_ID` (`"deny"`) from `eve/events` for new approval and budget controls; replace checks for the old `"cancel"` decision. Existing posted platform controls retain their routing encodings. Keep a default branch when switching on interaction kinds or outcomes: v27 can add values without changing its stream version.

## Import paths

| Before                                                            | Now                                                              |
| ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| `eve/tools/agent-router`                                          | `eve/tools/agent_router`                                         |
| `eve/computer-use` and its subpaths                               | `eve/extensions/computer-use` and the matching subpaths          |
| `eve/self-modification`, `eve/self-modification/local`            | `eve/extensions/self-modification/local`                         |
| `eve/self-modification/remote`                                    | `eve/extensions/self-modification/remote`                        |
| `eve/self-modification/config`, `eve/setup`, `eve/setup/scaffold` | No public replacement; these are private implementation modules. |
| `Datadog` from `eve/evals`                                        | `datadogReporter` from `eve/evals`                               |

## Update event consumers

**Hooks** keep `(event, ctx)`. Change their event keys and use `ctx.view` to query the committed state; `ctx.position` identifies the event. Wildcard (`*`) handlers no longer receive progress records. For example, replace a `message.completed` reply handler with:

```ts
import { defineHook } from "eve/hooks";

export default defineHook({
  events: {
    "content.completed"(event) {
      if (event.data.phase === "reply") console.log(event.data.value);
    },
  },
});
```

**Channel `events` handlers** now take `(event, ctx)` instead of `(eventData, channel, ctx)`. Read `event.data`, `event.scope`, and `ctx.channel`. Slack renderers take `(event, ctx, next)`; pass a fact to `next(event)` to continue rendering. A `committed` handler can observe the whole committed line. See [Custom channels](../channels/custom) and [Slack rendering](../channels/slack#customize-rendering).

**Instrumentation** uses `session.ended`, `turn.settled`, `call.requested`/`call.settled`, and `interaction.opened`/`interaction.settled`, with terminal `outcome` instead of separate success/failure event names. `channel.delivery.*` becomes `delivery.consumed`/`delivery.settled`; `step.attempt.*` becomes `model.started`/`model.retried`/`model.settled`. See [Instrumentation](/docs/observability/instrumentation#lifecycle-events).

**Clients** receive a `Delivery` immediately on acceptance. Use `delivery.result()` for its settlement or `delivery.stream()` for its events; each read is independent and can take a read signal. `result().status` describes the request (`completed`, `awaiting-input`, `failed`, `cancelled`), not session termination: check `sessionEnded` separately. Results no longer include an `events` array. Frontend hooks expose `view`, `messages`, `agents`, `events`, `session`, `status`, and `error` directly, not under `data`. `newSession()` clears local state; `reset()` retires the server session. Persist events and cursor as they change so paused turns survive reloads. See [Client streaming](../guides/client/streaming) and [Frontend](../guides/frontend/overview).

**Evals** match v27 facts and use `view` queries. Rename `loadedSkill` to `calledSkill`, `calledSubagent` to `calledAgent`, `noFailedActions` to `noFailedCalls`, and `parked()` to `awaitingInput()`. Use `t.target.attach(id)` instead of `attachSession(id)` and `turn.waitForToolCall()` instead of the old action matcher. See [Evals](../evals/overview).

## Other migration points

- Frontend stores and hooks replace `followIdle` with `followWhile(view)`. Omit `followWhile` to keep following between turns, as `followIdle: true` did. For `followIdle: false`, import `activeTurn` and `idle` from `eve/events` and pass `followWhile: (view) => !idle(view) || activeTurn(view) !== undefined`, which also keeps following a turn waiting on a person. See [Frontend](../guides/frontend/overview).
- Channel CORS options use `allowHeaders`, `exposeHeaders`, and `preflight.statusCode` instead of `allowedHeaders`, `exposedHeaders`, and `preflightStatus`.
- Authored channel identity is `channel:<name>`, including route-only channels and the default `channel:eve` (formerly `http`). Check visibility and authorization rules. Move visibility classification from `metadata().audience` to `audience(input)`; without it, audience is `unknown`. Channel context factories take `context(state, channel)`, and continuation aliases live on `channel.continuation`. See [Custom channels](../channels/custom).
- Session readers have `id` and `stream()`; `sessions.attach(id)` returns a read-only `SessionReader`, not command authority. Use `SessionInfo` from `eve/context` for the metadata in `ctx.session`. A command that cannot reach an active session reports `SessionNotActiveError` (HTTP `409 session_not_active`). See [session handles](./sessions-runs-and-streaming#read-a-session-in-process).
- `approvalKey` and `ApprovalContext.approvedTools` are removed. Use an `approval` policy for input-dependent decisions. `once()` remembers approval per tool for the session, not per input.
- Replace connection auth's `credentialOwner` with `principalType: "app" | "user"`. With `getToken` alone, omitted ownership defaults to `"app"`; set `"user"` for per-user tokens. See [connection credential ownership](/docs/connections#choose-app-vs-user-auth).
- Dynamic capabilities use `defineDynamic(ctx => value)`, not lifecycle event maps. Replace `defineDurableCallback` and `defineDurableSchema` wrappers with ordinary functions and schemas; put external JSON observations in `ctx.memo(key, fn)`. See [Dynamic capabilities](../guides/dynamic-capabilities).
- MCP's `input_required` now covers sign-ins as well as approvals and questions. Answer non-sign-in interactions using `responses: [{ interactionId, optionId?, text? }]`; complete sign-ins externally. Direct `invokeTool` calls return call-shaped outcomes, not conversational pauses. See [MCP](../channels/mcp).
- Remote agent protocol 3 supports relaying interactions. Older peers can still exchange results, but cannot relay approvals, questions, or sign-ins; upgrade them before relying on those flows. See [Remote agents](../guides/remote-agents).
