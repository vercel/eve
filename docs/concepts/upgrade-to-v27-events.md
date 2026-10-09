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
| Clients, frontends, and evals             | Event types, cursors (line positions), and event identity (`meta.position`).                            |
| `defineDynamic` resolvers                 | Nothing in this release. The keys stay; the event argument is now the matching v27 fact.                |
| Memory providers                          | Nothing in this release.                                                                                |
| Instrumentation (`defineInstrumentation`) | Nothing: its lifecycle events are a separate vocabulary.                                                |

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
| `step.started`            | `model.started`, or `model.requested` before the model is chosen                                                            |
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
| `turn.waiting`            | `turn.paused`, whose `awaiting` names the interactions or calls it waits on                                                 |
| `turn.completed`          | `turn.settled` with `outcome: "completed"`                                                                                  |
| `turn.failed`             | `turn.settled` with `outcome: "failed"`                                                                                     |
| `turn.cancelled`          | `turn.settled` with `outcome: "cancelled"`                                                                                  |
| `session.waiting`         | `delivery.settled` (a message's response is done) or `turn.settled`; `idle(view)` from `eve/events` says nothing is running |
| `session.completed`       | `session.ended` with `outcome: "completed"`                                                                                 |
| `session.failed`          | `session.ended` with `outcome: "failed"`                                                                                    |

New facts with no v26 counterpart: `delivery.admitted` and `delivery.settled` (every message,
answer, control, and callback), `turn.resumed`, `model.requested`, `call.started`,
`response.admitted`, and `usage.recorded`.

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
- **Usage.** Usage is recorded on `usage.recorded` per model run, delegated call, or compaction,
  rather than copied onto turn and session terminals. Sum the records, or call `usage(view)`.
- **Errors.** Failures carry `error: { code, message, id?, hint? }`.

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
- **Use the shared fold.** `eve/events` exports the catalog, the fold that turns facts into tables,
  and selectors such as `activeTurn`, `reply`, `openInteractions`, `usage`, and `idle`, so a
  client doesn't need its own reducer for session state.
- **Follow children with `child.opened`.** `session.agent(opened)` takes a `child.opened` event.

## Evals

- Match v27 facts in `t.event(...)`, `eventOrder(...)`, and `waitForEvent(...)`. Event matchers can
  match a fact's `scope`.
- `turn.waitForToolCall(name, options)` waits for a settled call to a tool, and `toolCallsOf(events)`
  derives tool calls from events. Eval tool calls always carry their `callId`.
- The subagent matcher's `remoteUrl` is removed.

## Sessions and remote agents

- **Handoff.** A session started on an earlier build continues on the deployment that owns it,
  because its stream uses the earlier event shape. New sessions use v27.
- **Remote agents.** The remote agent protocol moves to 3. A remote agent still serves callers on
  protocols 1 and 2 their results and failures, but relays no approvals, questions, or sign-ins to
  them; a turn that needs one fails and names the upgrade. A parent follows only a protocol-3
  child's live stream; an earlier child's result still arrives.
