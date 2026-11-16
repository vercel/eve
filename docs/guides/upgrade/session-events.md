---
title: "Upgrade to v27 Session Events"
description: "Move hooks, channel handlers, instrumentation, and stream readers from v26 to v27 session events, and adopt the shared model for approvals, questions, and sign-ins."
navTitle: "Session Events"
---

Read this page if your project has code that reads session events: hooks, channel `events` handlers, instrumentation providers, or anything that parses the session stream. It also covers the renamed APIs for approvals, questions, and sign-ins. Code that matches events by name can build cleanly and still stop working, so [Find every consumer](#find-every-consumer) lists where to look.

This page is part of [Upgrade to 1.0](/docs/guides/upgrade).

## What changed in the stream

Session streams use stream version 27 (`x-eve-stream-version: 27`). The new deployment serves every stream in this format, including sessions that moved over from eve 0.69 through 0.83.

The stream is still newline-delimited JSON, but its structure changed:

- **A stored line holds a group of events.** One state change writes one line with all the events it produced, so a turn ending and the message it answered arrive together. Streamed text and tool-input deltas arrive separately, each as a progress record on its own line.
- **Positions replace event IDs.** Each event carries `meta.position`: the zero-based `line` it was stored in and its `index` within that line. `startIndex` and saved cursors count lines, not events. Store events keyed on `(sessionId, line, index)`, so reading a stream again doesn't create duplicates.
- **Each event names what it belongs to.** An event's `scope` holds the IDs of its turn, run, or task.
- **One event ends each item, with an `outcome`.** Instead of separate `turn.completed`, `turn.failed`, and `turn.cancelled` events, a turn ends with `turn.settled` and an `outcome` of `completed`, `failed`, or `cancelled`. Calls, tasks, deliveries, and requests for input follow the same pattern.
- **Errors share one shape:** `error: { code, message, id?, hint? }`.
- **Token usage has its own event.** Read it from `usage.recorded`, not from turn or session events.
- **Only a person pauses a turn.** A turn that waits on background tasks keeps running. A turn pauses, with `turn.paused`, only while it waits for an approval, a question, a sign-in, or a budget prompt.
- **New values can appear without a version change.** Keep a default branch when you switch on event types, kinds, or outcomes.

See [Sessions, runs & streaming](/docs/concepts/sessions-runs-and-streaming) for the full stream format.

## Event mapping

Use this table to rename handlers and filters. When a row says to check a field, one v27 event covers several v26 events, and that field tells them apart.

| v26 event                                                         | v27 event                                                                                                         |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `message.received`                                                | `delivery.consumed`                                                                                               |
| `message.appended`, `reasoning.appended`                          | `content.delta` (progress; check `kind`)                                                                          |
| `message.completed`, `reasoning.completed`, `result.completed`    | `content.completed` (check `kind`; text with `phase: "reply"` is the answer)                                      |
| `step.started`, `step.completed`, `step.failed`                   | `model.started`, `model.settled` (check `outcome`); `model.requested` comes before model selection                |
| `action.input.appended`, `action.partial`                         | `call.input`, `call.progress` (progress)                                                                          |
| `actions.requested`, `action.result`                              | `call.requested` (one per call), `call.settled`                                                                   |
| `task.started`, `task.settled`                                    | `task.started`, `task.ended`; the call behind the task also has `call.started` (with `taskId`) and `call.settled` |
| `agent.started`                                                   | `child.opened`                                                                                                    |
| `input.requested`, `authorization.required`                       | `interaction.opened` (check `request.kind`, including `"sign-in"`)                                                |
| `input.resolved`, `authorization.completed`, `approval.settled`   | `interaction.settled` (check `outcome`)                                                                           |
| `approval.candidate`                                              | `response.submitted`, `response.settled`                                                                          |
| `compaction.requested`, `compaction.completed`, `context.cleared` | `context.started`, `context.settled` (check `kind`)                                                               |
| `turn.waiting`, `turn.completed`, `turn.failed`, `turn.cancelled` | `turn.paused` (for approvals, questions, sign-ins, and budget prompts), `turn.settled` (check `outcome`)          |
| `session.waiting`, `session.completed`, `session.failed`          | `delivery.settled` for a request, `session.ended` for a finished session; `idle(view)` for current idleness       |

v27 also adds events with no v26 equivalent:

- `delivery.admitted` when the server accepts a message or control.
- `response.admitted` when the server accepts an answer.
- `model.retried` when a model attempt fails and runs again.
- `usage.recorded` for token usage.
- `child.sent` when a call sends a message to a child session.

## Hooks

Hooks keep the `(event, ctx)` signature. To update a hook:

- Rename its event keys using the [event mapping](#event-mapping).
- Read the session's recorded state from `ctx.view` instead of tracking it yourself, and identify the event with `ctx.position`.
- Subscribe to progress events (`content.delta`, `call.input`, and `call.progress`) by their exact type. A wildcard (`*`) handler doesn't receive them.
- Catch errors from optional work, such as metrics. An unhandled hook error fails the running turn.

See [Hooks](/docs/guides/hooks).

```ts
import { defineHook } from "eve/hooks";

export default defineHook({
  events: {
    "message.completed"(event) { // [!code --]
      console.log(event.data.message); // [!code --]
    "content.completed"(event) { // [!code ++]
      if (event.data.phase === "reply") console.log(event.data.value); // [!code ++]
    },
  },
});
```

## Approvals, questions, and sign-ins

Approvals, questions, sign-ins, and budget prompts are all requests for input, and one `Interaction` type represents each of them. A person answers an approval, question, or budget prompt with an `Answer`: `{ interactionId, optionId?, text? }`. A sign-in completes through its own callback and takes no `Answer`. Rename the input-request APIs as follows.

| Before                                                                 | After                                                                             |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `InputRequest`, `InputResponse`, `requestId`                           | `Interaction`, `Answer`, `interactionId`                                          |
| `send({ inputResponses })`, `respond(inputResponses)`                  | `send({ answers })`, `respond(answers)`                                           |
| `parseInputResponse(s)`, `isInputResponse`                             | `parseAnswer(s)`, `isAnswer`                                                      |
| Response `inputRequests` and `authorizations`                          | `interactions` (sign-ins included)                                                |
| `ConversationState.inputs`, `openConversationInputs(state)`            | `interactions(view)`, `openInteractions(view)` from `eve/events`                  |
| Approval `request.requestId`                                           | `request.interactionId`                                                           |
| `onInputResponse` on Slack, Discord, and Teams                         | `onAnswers`                                                                       |
| Telegram `renderTelegramInputRequest`, `resolveTelegramInputResponses` | Removed; the built-in Telegram channel renders and resolves these requests itself |
| Telegram `TelegramInputRequestMessage`                                 | `TelegramInteractionMessage`                                                      |
| Workflow `ToolInputRequest`, `ToolInputResponse`                       | `ToolQuestion`, `ToolAnswer`                                                      |

The approve and deny choices are `APPROVE_OPTION_ID` (`"approve"`) and `DENY_OPTION_ID` (`"deny"`) from `eve/events`, for approvals and budget prompts. Replace checks for a `"cancel"` decision with `"deny"`. Buttons that eve already posted to Slack or another platform keep working.

To learn whether a person approved a tool call, read the interaction's `outcome`, not the call's state:

| `outcome`                  | Meaning                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `accepted`, `declined`     | A person decided.                                                                     |
| `withdrawn`, `interrupted` | Nobody decided, for example because the turn was cancelled. Treat it as not approved. |

See [Interactions](/docs/guides/frontend/use-eve-agent#interactions).

## Channel `events` handlers

Channel `events` handlers take `(event, ctx)` instead of `(eventData, channel, ctx)`. Read the payload from `event.data`, the turn or call it belongs to from `event.scope`, and the channel from `ctx.channel`. To update a status or card once per stored line instead of once per event, use `committed(line, ctx)`.

Slack renderers take `(event, ctx, next)`. Call `next(event)` to hand the event to the default rendering. See [Custom channels](/docs/channels/custom) and [Slack rendering](/docs/channels/slack/reference#customize-rendering).

## Instrumentation

Type providers with `InstrumentationEvent<K>` and rename their handlers using this table. As in the stream, each item ends with one event whose `outcome` tells success from failure. See [Instrumentation](/docs/observability/instrumentation#lifecycle-events).

| Before                                                  | After                                                                  |
| ------------------------------------------------------- | ---------------------------------------------------------------------- |
| `session.completed`, `session.failed`                   | `session.ended`                                                        |
| `session.waiting`                                       | No direct equivalent; `delivery.settled` reports each finished message |
| `turn.completed`, `turn.cancelled`, `turn.failed`       | `turn.settled`                                                         |
| `channel.delivery.*`                                    | `delivery.consumed`, `delivery.settled`                                |
| `step.attempt.*`                                        | `model.started`, `model.retried`, `model.settled`                      |
| `model.call.completed`, `model.call.failed`             | `model.call.settled`                                                   |
| `tool.call.*`                                           | `call.requested`, `call.settled`                                       |
| `input.requested`, `input.resolved`                     | `interaction.opened`, `interaction.settled`                            |
| `memory.operation.completed`, `memory.operation.failed` | `memory.operation.settled`                                             |

## Find every consumer

A clean typecheck doesn't find every v26 consumer. Code that parses NDJSON or saved JSON with its own event types compiles against any eve version, and it ignores events it doesn't recognize without an error.

- Search for v26 event names such as `message.completed`, `action.result`, `actions.requested`, and `authorization.required`, not only for `eve` imports. Include scripts, test helpers, and server routes that proxy streams.
- Run a recorded v27 stream through each consumer and check its output. A reducer that returns nothing, or a filter that matches nothing, still compiles.
- Check server code that filters or redacts streamed content before it reaches a browser. A filter keyed on v26 event types passes `content.delta` and `content.completed` through unchanged.
- Check consumers in other deployments, such as remote agents and their callers.
