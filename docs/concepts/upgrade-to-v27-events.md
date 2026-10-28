---
title: "Upgrade to v27 Session Events"
description: "Update agent definitions, integrations, clients, and evals for the new APIs and v27 session stream."
---

This guide covers breaking changes to agent definitions, approvals, channels, clients, and evals, including the move from v26 session events to v27 facts. Update custom integrations as well as application code.

## Before you upgrade

- Rebuild and republish installed extensions. Earlier epoch-based distributions cannot be loaded by this release; see [Extensions](../extensions).
- Keep the deployments that own existing sessions available. A session whose deployment runs eve 0.69 through 0.83 moves to this release the next time it receives a message while idle, or earlier when a channel prepares it for the next message. A session that has a background task, including an idle resumable one, stays on the deployment that owns it until the task finishes, and a session whose deployment runs an earlier release stays there. When a session moves, eve compacts its earlier conversation, so the model continues from a summary while the stored transcript stays intact. The session also starts over on remembered tool approvals and usage limits. On worlds without deployment routing, follow the [stranded-session recovery guidance](./execution-model-and-durability#stranded-sessions).
- Update event consumers, frontend persistence, and custom channel handlers using the mappings below. See [Sessions, runs & streaming](./sessions-runs-and-streaming) for the current stream contract.
- If your application saves session history, follows streams itself, or derives outcomes from events, plan that work with [Migrate application-owned state](#migrate-application-owned-state).

## Restore saved history

New sessions use v27. Sessions started on an earlier deployment keep the lines they already stored in the earlier format. When such a session moves to this release, it appends v27 facts to the same stream, and a current deployment serves the whole stream as v27 events.

Don't pass event arrays saved before the upgrade as `initialEvents`. When the session's stream is still available, read it again from position 0 and replace what you saved. Saved cursors still count the same stored lines.

When the saved array is the only copy, for example because the stream expired, convert it once and store the result:

```ts
import { convertLegacyEvents } from "eve/internal/legacy-events";

// One session's saved events, from its `session.started` on, as they were saved.
const events = convertLegacyEvents(saved);
```

Save the converted events with their metadata unchanged and pass them as `SessionStore`'s `initialEvents`. Their source positions and coverage metadata determine where reading resumes, including source lines that produced no facts. Do not calculate the resume position from the number of converted events or from another reader's cursor. See [Restore frontend state](../guides/frontend/overview#resumable-sessions) for hydration and replay behavior.

A session saved mid-turn stays unfinished. Convert each session separately: the function throws for an array that doesn't start at `session.started`, that holds a second session, or that holds current events. `convertLegacyEvents` is a migration aid with no compatibility promise and will be removed in a later release.

Saved records often hold more than one stream's worth of history. Before you hydrate or convert:

- **Select one session.** A chat record can hold several sessions, for example after a chat moves to a new session or a fork copies its parent's history. Pass only the current session's events, from its `session.started`, to `initialEvents` or `convertLegacyEvents`.
- **Split mixed prefixes.** A record written across the upgrade can hold v26 events followed by v27 events. If its stream has expired, convert only the v26 prefix and keep the later v27 events and their metadata unchanged.
- **Don't convert folded caches.** Message lists produced by v26 reducers aren't raw events. Re-read the stream, or render those caches as read-only records.
- **End computed cursors at a complete line.** An event with `meta.endOfLine: false` has more events in the same line. If you compute a cursor yourself, stop at the last complete line.
- **Treat missing data as unknown.** A partial read must not overwrite a fuller archive, and an expired stream must not replace saved history with an empty one. A child session you can no longer read hasn't necessarily completed.
- **Guard concurrent writes.** Browser saves, server catch-up reads, and background capture can race. Bind each write to its session, reject a cursor that moves backward, and track each child session's progress separately from its parent's.
- **Keep copied history inert.** Interactions in a fork, shared copy, or historical transcript belong to the original session. Render them read-only, not as live approval or sign-in controls.
- **Qualify IDs with the session.** Turn and message IDs aren't unique across sessions. When one record holds several sessions, include the session ID in keys for derived UI state.

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

| Before                                                                 | Now                                                                         |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `InputRequest`, `InputResponse`, `requestId`                           | `Interaction`, `Answer`, `interactionId`                                    |
| `send({ inputResponses })`, `respond(inputResponses)`                  | `send({ answers })`, `respond(answers)`                                     |
| `parseInputResponse(s)`, `isInputResponse`                             | `parseAnswer(s)`, `isAnswer`                                                |
| Response `inputRequests` and `authorizations`                          | `interactions` (including sign-ins)                                         |
| `ConversationState.inputs`, `openConversationInputs(state)`            | `interactions(view)`, `openInteractions(view)` from `eve/events`            |
| `conversationReducer`, `defaultMessageReducer`, `EveAgentReducer`      | Query opaque `view`; read `messages` and `agents`                           |
| `transcriptReducer(options)`                                           | `transcriptOf(events, options)`                                             |
| `onInputResponse` on Slack, Discord, Teams                             | `onAnswers`                                                                 |
| Telegram `renderTelegramInputRequest`, `resolveTelegramInputResponses` | `renderTelegramInteraction`, `resolveTelegramAnswers`                       |
| Workflow `ToolInputRequest`, `ToolInputResponse`                       | `ToolQuestion`, `ToolAnswer`                                                |
| Approval `request.requestId`                                           | `request.interactionId`                                                     |
| `MessageResponse`, `MessageResult`                                     | `Delivery`, `DeliveryResult` from `eve/sessions`                            |
| Creation result `{ session, response }`                                | `{ session, delivery }` when a message is supplied; `{ session }` otherwise |
| Built-in tool factories `askQuestion()`, `noReply()`, `sleep()`        | Export the definitions `askQuestion`, `noReply`, `sleep` directly           |
| `decide({ abortSignal })`                                              | `decide({ signal })`; results contain only `answers` and `usage`            |
| Client and frontend target `host`                                      | `baseUrl` (direct client required; frontend default `""`)                   |
| `EveAgentStore`                                                        | `SessionStore`                                                              |
| `StreamOptions`, `GetEventStreamOptions`                               | `SessionStreamOptions` from `eve/sessions`                                  |
| Evals `inputRequests`, `pendingInputRequests`, `requireInputRequest()` | `interactions`, `pendingInteractions`, `requireInteraction()`               |

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

**Clients** receive a `Delivery` immediately on acceptance. Use `delivery.result()` for its settlement or `delivery.stream()` for its events; each read is independent and can take a read signal. `result().status` describes the request (`completed`, `awaiting-input`, `failed`, `cancelled`), not session termination: check `sessionEnded` separately. Results no longer include an `events` array. Frontend hooks expose `view`, `messages`, `agents`, `events`, `session`, `status`, and `error` directly, not under `data`. `newSession()` clears local state; `end()` retires the server session (renamed from `reset()`). Persist events and cursor as they change so paused turns survive reloads. See [Client streaming](../guides/client/streaming) and [Frontend](../guides/frontend/overview).

**Evals** match v27 facts and use `view` queries. Rename `loadedSkill` to `calledSkill`, `calledSubagent` to `calledAgent`, `noFailedActions` to `noFailedCalls`, and `parked()` to `awaitingInput()`. Use `t.target.attach(id)` instead of `attachSession(id)` and `turn.waitForToolCall()` instead of the old action matcher. See [Evals](../evals/overview).

## Other migration points

- Frontend stores and hooks replace `followIdle` with `followWhile(view)`. Omit `followWhile` to keep following between turns, as `followIdle: true` did. For `followIdle: false`, import `activeTurn` and `idle` from `eve/events` and pass `followWhile: (view) => !idle(view) || activeTurn(view) !== undefined`, which also keeps following a turn waiting on a person. See [Frontend](../guides/frontend/overview).
- Channel CORS options use `allowHeaders`, `exposeHeaders`, and `preflight.statusCode` instead of `allowedHeaders`, `exposedHeaders`, and `preflightStatus`.
- Authored channel identity is `channel:<name>`, including route-only channels and the default `channel:eve` (formerly `http`). Check visibility and authorization rules. Move visibility classification from `metadata().audience` to `audience(input)`; without it, audience is `unknown`. Channel context factories take `context(state, channel)`, and continuation aliases live on `channel.continuation`. See [Custom channels](../channels/custom).
- Session readers have `id` and `stream()`; `sessions.attach(id)` returns a read-only `SessionReader`, not command authority. Use `SessionInfo` from `eve/context` for the metadata in `ctx.session`. A command that cannot reach an active session reports `SessionNotActiveError` (HTTP `409 session_not_active`). See [session handles](./sessions-runs-and-streaming#read-a-session-in-process).
- `approvalKey` and `ApprovalContext.approvedTools` are removed. Use an `approval` policy for input-dependent decisions. `once()` remembers the latest approval or denial per resolved tool for the session; custom policies must return its decision unchanged to reuse or record consent. See [Tool approvals](/docs/human-in-the-loop).
- Replace connection auth's `credentialOwner` with `principalType: "app" | "user"`. With `getToken` alone, omitted ownership defaults to `"app"`; set `"user"` for per-user tokens. See [connection credential ownership](/docs/connections#choose-app-vs-user-auth).
- Dynamic capabilities use `defineDynamic(ctx => value)`, not lifecycle event maps. Replace `defineDurableCallback` and `defineDurableSchema` wrappers with ordinary functions and schemas; put external JSON observations in `ctx.memo(key, fn)`. See [Dynamic capabilities](../guides/dynamic-capabilities).
- Recalled memory stays outside durable conversation history and is recalled before turns, not during compaction. Remove memory `visibility` options; a failed memory capture now prevents compaction. See [Memory providers](../memory/custom-provider).
- `grep` lists matching files by default. Set `outputMode: "content"` when the caller needs matching lines; see [Built-in tools](./built-in-tools#grep).
- Replace `eve remote invoke` with `eve remote connect --print <prompt>` for one-shot requests. Use `eve/client` for scripted multi-turn sessions and answers; see the [CLI reference](../reference/cli#eve-remote-connect).
- MCP's `input_required` now covers sign-ins as well as approvals and questions. Answer non-sign-in interactions using `responses: [{ interactionId, optionId?, text? }]`; complete sign-ins externally. Direct `invokeTool` calls return call-shaped outcomes, not conversational pauses. See [MCP](../channels/mcp).
- Remote agent protocol 3 supports relaying interactions. A protocol-3 caller relays a protocol-2 remote agent's approvals, questions, and sign-ins, but a protocol-3 remote agent can't relay them to a protocol-2 caller, so upgrade callers before the remote agents they call. Older peers can still exchange results. See [Upgrading callers and remote agents](../guides/remote-agents#upgrading-callers-and-remote-agents).

## Migrate application-owned state

The tables above cover renamed events and APIs. Applications that save history, follow streams, or track lifecycle state themselves also need to decide which of that state they still own.

### Decide what eve owns

Let eve own live execution and observation: turn lifecycle, streaming and reconnection, optimistic sends, and interaction state. Use `useEveAgent` or `SessionStore` to follow a session, `view` queries from `eve/events` for lifecycle questions, and `delivery.result()` for a request's outcome.

Keep the records eve doesn't hold: saved archives and their cursors, forks and shared copies, feedback, authorization and responder policy, budgets you authored, and ledgers of external effects such as uploads or published changes.

- Replace an application-owned lifecycle model as a whole. A second reducer layered on the store becomes another source of truth that can disagree with it.
- Adapt at the presentation boundary. Map `messages`, `view`, and interaction parts into your existing components instead of rebuilding a lifecycle to feed them.

### Find every consumer

A clean typecheck doesn't find every v26 consumer. Code that parses NDJSON or saved JSON with locally declared event types compiles against any `eve` version and ignores facts it doesn't recognize.

- Search for v26 event names such as `message.completed`, `action.result`, `actions.requested`, and `authorization.required`, not only for `eve` imports. Include scripts, test helpers, and server routes that proxy streams.
- Run a recorded v27 stream through each consumer and check its output. A reducer that returns nothing, or a filter that matches nothing, still compiles.
- Check server code that filters or redacts streamed content before it reaches a browser. A filter keyed on v26 event types passes v27 `content.delta` and `content.completed` events through unchanged.
- Check consumers in other deployments, such as remote agents and their callers, along with their protocol versions.

### Attribute results to their delivery

- Bind each outcome to the delivery that requested it. Use `delivery.result()` or that delivery's own turn, not the session's latest turn or every event after a polling cursor. Otherwise a queued or concurrent turn can claim another turn's output.
- For a child session that several calls reuse, follow the `child.sent` links from a call to the child delivery it sent, for example with `agentCallActivity(state, callId)` from `eve/client`. Don't count `delivery.consumed` on the child's stream: answers to the child's questions are deliveries too. See [Child agents](../guides/frontend/use-eve-agent#child-agents).
- Decide approvals from the interaction's `outcome`, not the call's state. Only `accepted` and `declined` record a decision. An approval that settled `withdrawn` or `interrupted`, for example because its turn was cancelled, wasn't approved. See [Interactions](../guides/frontend/use-eve-agent#interactions).
- Don't identify runs by the shape of their input. A steering message adds a run to the same turn, and a retry reuses its run ID. Use `turn.started` for once-per-turn work, and `runId` with `turnId` when you need a specific run.
- Treat acceptance as admission, not completion. When an outcome is unconfirmed, read it again instead of resending after a timeout. Use `operationId` for create requests that you retry; see [the eve channel](../channels/eve).
- Read payloads by their documented shape. `turn.settled.data.reply` lists the reply's part IDs, not its text; use `reply(ctx.view, turnId)` in hooks and channels, or `messages` in the frontend.

### Simplify code eve now owns

Application code that mirrors eve's state is usually removable. Measure the result by the state owners you remove, not only by deleted lines.

| Usually replaceable                                                      | Replacement                                                                                                  |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Custom stream followers, reconnect loops, and optimistic-send state      | `useEveAgent` or `SessionStore`                                                                              |
| Hook or session state that mirrors turns, calls, tasks, or models        | `ctx.view` and selectors from `eve/events`                                                                   |
| Folds over raw events for status, replies, timing, usage, or cursors     | The queries in [Use eve's answers](../guides/frontend/use-eve-agent#use-eves-answers)                        |
| Hand-written finite stream readers and history scanners                  | `session.stream({ follow: false })` or `session.snapshot()`                                                  |
| Conversions from `Interaction` to a custom request shape and back        | Native `Interaction` values and the channel's interaction rendering                                          |
| Retirement code for Slack approval cards and sign-in messages eve posted | Slack's native settlement. Check each channel's docs before removing code for other cards, such as questions |
| An explicit `turnPolicy: "steer"` on follow-ups                          | Omit it: messages steer an open turn by default                                                              |
| Event-keyed dynamic capability maps                                      | `defineDynamic(ctx => value)`                                                                                |
| Local v26-to-v27 event translators                                       | `convertLegacyEvents` during migration, or a fresh read from position 0                                      |
| Tests that only exercised removed machinery                              | Delete them with that machinery; keep tests for behavior that remains                                        |

Keep code that enforces your application's own contracts: archive storage and cursor guards, effect ledgers and deduplication receipts, authorization and responder checks, budgets you authored, `operationId` retries, and product UI such as composers, branches, and sharing.

### Verify the migration

- Build fixtures from real saved history. Record v26 data with the release you're upgrading from, and pass it through a JSON round trip so tests use the shape you actually store.
- Test history paths explicitly: expired streams, sessions saved mid-turn, forks, records holding several sessions, and caches written across the upgrade.
- Test interaction endings other than an answer: cancel a turn while an approval is pending, and send a message while a sign-in is pending.
