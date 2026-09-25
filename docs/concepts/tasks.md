---
title: "Tasks"
description: "How eve runs agent calls and workflow tool calls as tasks: which calls wait, background calls, detach, result delivery, cancellation, time limits, and task stream events."
---

A task is one call to an agent or a workflow tool, from the moment it starts until it has a result. eve runs every agent call as a task, whether the call goes to the built-in `agent` tool, a declared or dynamic [subagent](../subagents), a [remote agent](../guides/remote-agents), or `ctx.agent` in a workflow body. Every [workflow tool](../tools/workflows) call is also a task, including eve's `ask_question` and `sleep` tools.

Most tasks are waited on: the turn pauses until the task has a result, and the result becomes the tool result. A background task returns a receipt at once, and its result reaches the model later in its own message. eve decides which calls wait from the kind of call and the kind of session, so most agents and tools configure nothing.

Tasks are unrelated to task mode, the run mode of a session that runs to completion or fails without parking to wait for a person, such as a markdown [schedule](../schedules) or an MCP `agent_start` call.

## Waited and background calls

A waited call holds its turn. Calls that the model makes in one step run in parallel, and the turn waits for all of them. Each call's result is its tool result, and the model continues once every call has returned.

A background call does not hold its turn. It starts the same way as a waited call, but its tool result is a receipt. Clients read the receipt on `action.result` as `output: { status: "working", taskId }`, and the model reads text such as:

```text
Task remind-q4x1ze is working in the background. Its result will arrive in a later message. Do not poll or repeat this work.
```

A call runs in the background in three cases:

- The model passes `background: true` to an agent tool in an interactive root session. See [Run a call in the background](../subagents#run-a-call-in-the-background).
- The workflow tool is defined with [`detach: true`](../tools/workflows#return-a-receipt-with-detach).
- A waited call [detaches](#detach-a-waited-call) because a steering message arrived or its `detach: { timeout }` timer fired.

Each task has an ID such as `researcher-7k2m9q`: the agent or tool name and six characters that eve assigns before the task starts. For an agent, the task ID is also the agent ID that `agentId` continues. The ID appears in receipts, in the [`[Tasks]` note](#the-tasks-note), and on every [task stream event](#task-stream-events).

## Which calls wait

| Call                                         | Model sees `background` | Default                                                                      | Steering message during the wait                                                                                    |
| -------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Agent tool in an interactive root session    | Yes                     | Waits                                                                        | Detaches the call; with `turnPolicy: "queue"`, the message waits                                                    |
| Agent tool in a turn that a schedule started | Yes, but it waits       | Waits                                                                        | Applied after the wait                                                                                              |
| Agent tool in a subagent's session           | No                      | Waits                                                                        | Applied after the wait                                                                                              |
| Agent tool in a task-mode run                | No                      | Waits; the run ends only after its background results are delivered          | Applied after the wait                                                                                              |
| `ctx.agent` in a workflow body               | No                      | The body awaits it                                                           | Never detaches                                                                                                      |
| Workflow tool (`detach: false`, the default) | No                      | Waits                                                                        | In an interactive root session, detaches after answering or dismissing questions; elsewhere, applied after the wait |
| Workflow tool with `detach: { timeout }`     | No                      | Waits; in an interactive root session, detaches after `timeout` milliseconds | Same as the default                                                                                                 |
| Workflow tool with `detach: true`            | No                      | Returns a receipt at once, in any session                                    | Not applicable                                                                                                      |
| eve's `sleep` tool                           | No                      | Waits                                                                        | Ends the sleep early, in any session                                                                                |

An interactive root session is a root session in conversation mode that no caller created, such as a session that a channel or `client.sessions.create()` starts. A subagent's session and a task-mode run are not interactive root sessions. eve decides this when the session is created, so the model's tools and instructions do not change between turns.

A turn that a schedule started waits for every call, so a scheduled run posts one final reply. A schedule starts the first turn of a session it creates, and the turn that a message sent by its handler starts in an existing session. In those turns, an agent call with `background: true` waits, and no waited call detaches.

## Detach a waited call

Detaching moves a waited call to the background without stopping it. The call's tool result becomes a receipt, the task keeps working, and its result arrives later like any [background result](#how-results-arrive). Only interactive root turns detach calls: turns of an interactive root session that a schedule did not start.

### On a steering message

When a steering message (`turnPolicy: "steer"`, the default) arrives while an interactive root turn waits on calls, eve applies it in this order:

1. If the message answers a pending question, it answers the question and does not steer. See [Ask a human](../tools/workflows#ask-a-human-ctxask) for when plain text answers a question.
2. Otherwise, each pending question created with `dismissible: true` resolves as `dismissed`. Its call has up to 10 seconds to return as usual. A call still working after that detaches with the calls in step 3.
3. Every other waited call detaches, including a call waiting on an approval or on a question that is not dismissible. eve emits `task.detached` with `reason: "steer"` for each call, and the turn continues in one model step with the receipts followed by the new message.

The model reads a receipt such as:

```text
A new message arrived, so this call moved to the background as agent researcher-7k2m9q. Its result will arrive in a later message. Do not poll or repeat this work.
```

The calls that one message detaches form a detach group. eve holds the group's results until no member is still working, then delivers them together in one `task.result` message. Each working member's time limit bounds that wait; a workflow tool without `timeout` is bounded by the session's lifetime. A member waiting on an approval or a question does not hold the group: its request stays pending, and once someone answers it, the member reports on its own. A result stays in its group even if the model gives that agent new work before the group is delivered.

eve's `sleep` tool is the exception, in every session: a steering message ends a waited `sleep` early instead of detaching it. The call's result reports the time it waited, such as `The sleep ended early after 12 s because a new message arrived.` Authored tools cannot opt into this behavior.

A message with `turnPolicy: "queue"` never detaches anything; it waits until the turn settles. In a subagent's session, a task-mode run, and a turn that a schedule started, a steering message is applied after the waited calls return, in the same turn.

### After a timeout

A workflow tool defined with `detach: { timeout }` also detaches a call that is still working `timeout` milliseconds after it started, in an interactive root turn. eve emits `task.detached` with `reason: "timeout"`, and the model reads `This call is taking a while, so it moved to the background as task run_tests-3fq8wd.`, followed by the same instructions as other receipts. A call that detaches on its timer joins no group and delivers its result on its own. A result that arrives before the timer fires wins, and a timer stops mattering once its turn stops waiting. See [Detach after a timeout](../tools/workflows#detach-after-a-timeout) for the authoring side.

## How results arrive

When a background task finishes, eve holds its outcome in durable session state and delivers it to the model as typed session input, never as a channel message. The model reads one user-role message of kind `task.result`, with one `<task_result>` block per result:

```text
<task_result id="remind-q4x1ze" name="remind" status="completed">
Reminder: stand-up at 10
</task_result>
<task_result id="auditor-2b0c1a" name="auditor" status="failed" code="TIMED_OUT">
The agent did not finish within 2 h and was stopped.
</task_result>
```

A workflow tool's block body is the definition's `toModelOutput(output)` when it has one. Otherwise the body is the output, or the error message for a failed result.

The model reads every task result under one truncation limit, whether its call waited or ran in the background: a `<task_result>` block body and a waited call's tool result are each cut at 50 KB or 2,000 lines, with a final `[truncated]` line where the cut falls, and a line longer than 2,000 characters is cut with ` [truncated]`. A waited call's structured output that fits stays structured; one past the limit reaches the model as its truncated JSON text. `action.result`, `task.settled`, and `ctx.agent` still carry the full output, with one exception: a remote agent's result that eve [recovers at the call's deadline](#time-limits) after its callback was lost. The remote session keeps each result for that read with any output larger than 50 KB already cut to the same limit, so such an output arrives everywhere as its truncated text, including structured output.

Each result belongs to the principal whose call started the task. Two principals match when their authenticator, principal type, and principal ID match. A turn cannot end while tasks it started are working, so every result arrives in the turn that started its task:

- **At a tool step.** A result that settles while the turn works is added at the turn's next tool step, where the model is called again.
- **In a wait.** A `task_wait` call on the task returns the result as its tool result.
- **When the model ends the turn.** If tasks the turn started are still working, eve holds the turn instead of ending it. As soon as any of them settles, eve calls the model again with the result, and the check repeats. A message from the same principal also resumes a held turn and is answered in it.
- **Turn waiting on a person.** While a turn waits on an approval or a question, results wait until the request is answered and the turn continues.
- **Several results.** Results that settle together share one message. Apart from [detach groups](#on-a-steering-message), eve never holds one result back for another.

No result starts a turn of its own, so an idle session never wakes for one, and a result never appears in another principal's turn.

In an interactive root session, a held turn shows a waiting boundary: the stream carries `turn.completed` with `held: true`, then `session.waiting`, but the turn stays open, and its later events, including the final `turn.completed` without `held`, carry the same `turnId` with no new `turn.started`. The model's message before the boundary is an ordinary reply. Cancelling a held turn ends it with `turn.cancelled` for that ID. A subagent's turn, a task-mode run, and a turn that a schedule started hold without a boundary, so each produces one reply: the model's text before the hold streams as `message.completed` with `interim: true`, which means it is not the turn's reply yet and eve will call the model again. The built-in channels do not post an `interim` message. See [Held turns](./sessions-runs-and-streaming#held-turns). When a turn requested an output schema, the model cannot give its structured result while tasks the turn started are working: it waits for them or cancels them first.

On the session stream, a delivery appears as `message.received` with `data.kind: "task.result"` and `data.taskIds`. It is not a user message. The default client reducer, the dev TUI, and the built-in channels do not render it as one, and custom renderers should skip it too.

A subagent answers its caller, and a task-mode run returns, only after the tasks its turn started have settled, with the reply it gives after seeing their results. A task that eve [cancels](#cancel-tasks) delivers no result.

### The `[Tasks]` note

The model learns which tasks are still out from the `[Tasks]` note. It is a framework-authored user-role message that eve appends to the conversation whenever its listing changes, and again after compaction or a context clear. The latest note is current, and the static system prompt tells the model that eve, not the user, writes it:

```text
[Tasks]
<tasks>
<task id="writer-7k2m9q" name="writer" status="working" started="2026-09-24T14:02Z"/>
<task id="remind-q4x1ze" name="remind" status="completed" started="2026-09-24T14:05Z"/>
</tasks>
<idle_agents>
<agent id="researcher-2b0c1a" name="researcher">Found three sources on the Orbit launch.</agent>
</idle_agents>
```

`<tasks>` lists every background task whose result has not reached history, with its status: `working`, `input_required` while it waits on a person, or its outcome once it finishes. A finished task stays listed while its result waits for its detach group or for its principal's turn. Waited calls are not listed, because the model is not called while it waits on them. `<idle_agents>` lists up to 10 idle agents, most recent first, each with a one-line summary of its last answer. eve adds the note only at a model-step boundary, and a session that never had a background task or an idle agent gets no note.

eve keeps a task's record only as long as it needs it: a workflow tool call's until its result reaches history, and an agent's until the agent's session ends. A report that arrives after its record is gone matches no record and is dropped, like a duplicate. Every report names the call it answers, so a late report can never settle another task. A session keeps at most 50 idle agents. Each time it starts an agent past that, eve retires the idle agents that started least recently, the calling principal's own first, so in a shared session one person's new agents retire another person's only when the first has none idle. eve ends a retired agent's session. If the request to end a local agent does not reach it, for example because the agent is moving to another deployment, eve sends the request again 30 seconds later and stops the agent outright only if that request also fails. Retiring emits no task event, because the agent's last call already settled, and a later call with a retired agent's ID fails with `UNKNOWN_AGENT`, as for an ID the session never had.

## Give a working agent more to do

Pass the `agentId` of an agent that is still working to send it a message, such as a correction. The message joins the agent's current call instead of starting a new one, and the call returns a receipt:

```text
Sent your message to agent researcher-7k2m9q, which is still working. Its result will arrive in a later message.
```

The agent still delivers exactly one result for its current call. Only the principal whose call started the agent's current work can message it or give it new work; a call from any other caller, such as another user, a schedule, or an app principal, fails with `AGENT_OTHER_PRINCIPAL`. Principals match by authenticator, principal type, and principal ID, and every unauthenticated caller is the same anonymous principal, so this check does not separate two anonymous callers. A model call that names an agent whose current work a workflow body started with `ctx.agent` fails with `AGENT_BUSY`. See [Agent messaging](../subagents#agent-messaging) for continuing idle agents and every `agentId` error.

## Answer an agent's questions and approvals

A question or approval from an agent, local or remote, reaches the root session's stream as `input.requested` with the agent's `taskId`, and you answer it on the root session with `inputResponses`, as for the root agent's own requests. Requests from the agents an agent starts, at any depth, reach the root the same way, and each one stays answerable on its own. Anyone who can send to the root session can answer. The answer is attributed to the principal that gave it, which is the `responder` an [approval response policy](../human-in-the-loop#authorizing-approval-responses) checks, while the agent keeps acting as the principal that started it.

A plain message from a person also answers an agent's question when it is the only pending question, the root session waits on no approval or session-limit prompt of its own, and the text matches one of its options or the question allows free text, the same rule as for a workflow tool's [`ctx.ask`](../tools/workflows#ask-a-human-ctxask). A plain message never answers an approval.

Once the answer to an agent's question reaches the agent that asked it, the root session's stream carries the question's `input.resolved`, and the question takes no other answer: a later message or response for it stays with the root session. An approval stays answerable until the agent resolves it, because the agent's [approval response policy](../human-in-the-loop#authorizing-approval-responses) may refuse the responder and keep the approval pending for another; the stream then carries the agent's `input.resolved`. Either event names each request by its `requestId`.

A request is withdrawn when its task stops waiting on it for any other reason: the task is cancelled, times out, or finishes first. The root session's stream then carries `input.resolved` with `outcome: "ignored"` for the request, and an answer that arrives later stays with the root session. Cancelling a turn withdraws the requests of the calls it waited on; a background task's requests stay answerable.

An answer that can never reach a remote agent fails its task: with `AGENT_SESSION_ENDED` when the agent's session is gone, and with `AGENT_UNREACHABLE` when the agent's deployment now uses another task protocol version. An answer that fails for a reason that may clear, such as a timeout, stays answerable.

## Cancel tasks

The model stops background tasks with [`task_cancel`](./built-in-tools#task_cancel). It passes 1 to 50 IDs and gets back `{ cancelled, alreadyFinished, unknown }`. A call the current turn is still waiting on is listed as `unknown`; cancel the turn to stop it. eve advertises `task_cancel` only in sessions that can have background tasks: an interactive root session whose agent has an agent or workflow tool, or any session whose agent has a `detach: true` tool.

Application code cancels through `session.cancel()` on a [client session](../guides/client/overview#sessions), a channel session handle, or the body of `POST /eve/v1/session/:sessionId/cancel`:

| Call                              | Cancels                                                                   |
| --------------------------------- | ------------------------------------------------------------------------- |
| `session.cancel()`                | The active turn and the calls it waits on. Background tasks keep working. |
| `session.cancel({ taskId })`      | One background task. The active turn keeps running.                       |
| `session.cancel({ tasks: true })` | The active turn and every working task, including background tasks.       |

`taskId` cannot be combined with `tasks` or `turnId`. Any caller with access to a session can cancel any of its tasks, and the model can stop any background task in any principal's turn. Cancelling is deliberately not limited to the principal that started the work, unlike [messaging a working agent](#give-a-working-agent-more-to-do), so anyone in a shared session can stop a task. See [Cancel the in-flight turn](./sessions-runs-and-streaming#cancel-the-in-flight-turn) for the route's statuses and race behavior.

eve also cancels tasks on its own. When a workflow tool run ends, eve cancels the agent tasks that the run still owns.

Ending a session cancels every working task, and eve delivers nothing afterward. Each agent the session started, working or idle, then ends its own session the way a reset session does: it cancels its turn and its own tasks, and ends the agents it started in turn. A remote agent ends through its session-reset route. The ending session does not wait for them. A local agent that was working is stopped outright if it is still running 30 seconds after the session ended, and so is a workflow run still running after 35 seconds. An idle local agent that the request to end did not reach gets the request again after 30 seconds, and is stopped outright only if that request also fails, so an agent that was only moving to another deployment still ends its own tasks and agents.

Every cancellation takes effect in the owner at once. eve records the task as cancelled, emits `task.settled` with `status: "cancelled"`, and asks the child to stop without waiting for it. A workflow run observes `ctx.abortSignal`; see [Cancel and clean up](../tools/workflows#cancel-and-clean-up-ctxabortsignal). If a local agent has not stopped 30 seconds after a cancel or a timeout, eve terminates its session. A workflow run that has not ended 35 seconds after a cancel is stopped outright. A cancelled agent that is still reachable stays available for new work through its `agentId`.

## Time limits

Two settings bound a task, and they do different things:

| Setting                                           | Applies to                             | Default                                | When it expires                                                   |
| ------------------------------------------------- | -------------------------------------- | -------------------------------------- | ----------------------------------------------------------------- |
| `timeout` on `defineAgent` or `defineRemoteAgent` | Each call of that agent                | 2 hours of active time                 | The call fails with `TIMED_OUT`, and eve cancels the child's turn |
| `timeout` on `defineWorkflowTool`                 | Each call of the tool                  | None; the session's lifetime bounds it | The call fails with `TIMED_OUT`, and eve cancels the run          |
| `detach: { timeout }` on `defineWorkflowTool`     | Waited calls in interactive root turns | None                                   | The call detaches and keeps working                               |

Durations are milliseconds. `timeout: false` removes the limit, but the session's lifetime, `limits.sessionTimeoutMs`, still bounds every task. On the root agent, `timeout` applies to calls of the built-in `agent` tool. The clock stops while the task waits on a question or approval that reached the root session's channel, and resumes once every such request is resolved. A sign-in prompt does not stop the clock.

A waited call that times out gets the `TIMED_OUT` error as its tool result, a background call delivers it as a failed task result, and `task.settled` reports `failed` with the same error. Before a call times out, eve checks its child once, so a child that finished but whose report was lost still settles the call with its result. For a remote agent, eve reads the remote session's result for that call. For a workflow tool, eve reads the run's status and the outcome the run returned; a run that failed before it reported fails the call with `EXECUTION_FAILED`. A local agent is not read, because it reports through the session's durable inbox, which eve does not hand off to another deployment while any task is working. A call with no time limit gets no such check: if its child's report never arrives, the call keeps waiting until the session ends. See [Limit a call with `timeout`](../tools/workflows#limit-a-call-with-timeout) and the subagent `timeout` in [What the parent sees](../subagents#what-the-parent-sees).

## Background task limit

A session holds at most 10 working background tasks. Detached calls count toward the limit, but eve never rejects a detach. An agent call with `background: true` or a `detach: true` workflow tool call over the limit does not start. Its tool result is an error with code `TOO_MANY_BACKGROUND_TASKS`, which lists the working task IDs and tells the model to wait for one, stop one with `task_cancel`, or, for an agent call, call without `background`. The limit is not configurable.

## Remote agents

A call to a [remote agent](../guides/remote-agents) is a task like a local call, with the same receipts, detach, results, cancellation, and events. `task.started` carries the remote target in `child.remote.url`.

The child side of the task protocol runs in the remote deployment, so the calling deployment and every remote agent it calls must use the same task protocol version, currently `1`. Before it creates a remote session, the caller reads the remote's version from the `x-eve-task-protocol` header of its `GET /eve/v1/health` response. A remote on another version, or on an older eve that reports none, fails the call at once with `START_FAILED`, before its model or tools run. Create, message, and answer requests, result and input callbacks, and accepted create and message responses carry the version as `taskProtocol`, and a deployment refuses a mismatch with `409` and `"code": "TASK_PROTOCOL_MISMATCH"`. Cancel and reset requests carry no version, so a caller can always stop a remote child. See [Upgrading remote agents](../guides/remote-agents#upgrading-remote-agents).

The caller applies each result a remote child reports once. It acknowledges a repeated result callback with `202`, like the first, and one that arrives after the caller's session ended with `200` and `{"ok":true,"duplicate":true}`; the child treats any `2xx` as delivered. See [Retries and lost callbacks](../guides/remote-agents#retries-and-lost-callbacks).

## Task stream events

Three events on the session stream describe tasks, for waited and background calls alike. Channel `events` handlers and [hooks](../guides/hooks) can subscribe to each of them. Every workflow tool call is a task, so filter by `kind` and `name` when you only follow delegation.

| Event           | `data` fields                                                                                                                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task.started`  | `taskId`; `callId` of the call that started this generation; `turnId`; `name`; `kind` (`"agent"` or `"workflow"`); `mode` (`"foreground"` when the calling turn waits, `"background"` when it does not); and, for an agent, `child` with `sessionId`, `streamPath`, and `remote.url` for a remote child |
| `task.detached` | `taskId`, `callId`, and `reason`: `"steer"` or `"timeout"`                                                                                                                                                                                                                                              |
| `task.settled`  | `taskId`, `callId`, and `status`: `"completed"` with `output`, `"failed"` with `error: { code, message }`, or `"cancelled"`; `usage` with `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, and optional `costUsd` when the child reported it                                       |

Consumers can rely on these rules:

- Every call that starts a task emits exactly one `task.settled` for each generation, with the task's first outcome.
- `task.started` precedes `task.settled` once the child exists. A call that fails before its child starts, such as with `START_FAILED`, emits only `task.settled`. A call rejected before any task exists, such as one naming an unknown `agentId` or one over the background task limit, emits neither; its error appears only on `action.result`.
- For a background agent call, the receipt on `action.result` and `task.started` can arrive in either order, and `task.started` can arrive after the turn that made the call has ended.
- A detached call keeps the `mode` of its `task.started`; `task.detached` marks the switch. `task.detached` belongs to the turn that made the call, so read it from the session stream, not from the steering message's `MessageResponse`.
- Continuing an idle agent emits another `task.started` and `task.settled` pair with the same `taskId` and a new `callId`. A message that joins a working agent's call emits nothing new, unless the agent had already answered: it then runs the message as its next turn, reported as another `task.started` with the same `taskId` and `mode: "background"`.
- A `sleep` that a steering message ends early settles with `status: "cancelled"`, while its `action.result` carries `{ waitedSeconds }`.
- When the root session proxies a child's `input.requested`, `approval.candidate`, `approval.settled`, `authorization.required`, or `authorization.completed` event, the event carries the child's `taskId`. An `input.requested` event for a workflow tool call's own question or approval carries that call's `taskId`. The matching `input.resolved` carries no `taskId`; correlate it with the request through `requestId`.
- A request withdrawn because its task settled gets its `input.resolved`, with `outcome: "ignored"`, before the task's `task.settled`.

Follow an agent's own progress by passing its `task.started` event to [`session.streamSubagent()`](../guides/client/streaming#follow-a-subagent), which reads `child.streamPath`.

### Error codes

`task.settled` for a failed task, the waited call's tool result, and a failed `<task_result>` block carry the same `error.code`. Handle unknown codes, because an agent's own failure and a workflow tool's thrown error with a `code` pass their code through. A cancelled task has no code: `task.settled` reports `status: "cancelled"`, and a waited call that its child cancelled gets an error result that is only a message.

| Code                          | Meaning                                                                                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `START_FAILED`                | The child could not start: a local agent's session, a workflow tool run, or a remote agent, including one on another task protocol version.                 |
| `TIMED_OUT`                   | The call was still working at its `timeout`. The message names the limit, such as `The agent did not finish within 2 h and was stopped.`                    |
| `AGENT_SESSION_ENDED`         | The agent's session expired, reset, or closed before it replied.                                                                                            |
| `AGENT_UNREACHABLE`           | An idle agent could not be given its next call, or a remote agent could not take an answer because its deployment now uses another task protocol version.   |
| `OUTPUT_SCHEMA_NOT_FULFILLED` | The agent could not produce a result matching the call's `outputSchema`.                                                                                    |
| `EMPTY_RESULT`                | The agent finished without a reply. A call with an `outputSchema` never fails this way, because its result is structured.                                   |
| `STATE_LOST`                  | eve could not read the task's saved state, such as a task that an earlier eve release left working. The session continues.                                  |
| `EXECUTION_FAILED`            | The work failed without a code of its own, such as an agent's turn or session, or a workflow tool run that failed before it reported. The message says why. |

### Test a consumer against recorded streams

Each eve release ships recorded task streams in the package, so you can replay real `task.*` traffic through your own stream consumers, such as channel handlers, in a contract test. The files live under `eve/conformance/task-streams/v1/`: a `manifest.json` and one NDJSON file per scenario. Each line is one event exactly as `session.stream()` yields it.

| File                                | Covers                                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `agent-call-wait.ndjson`            | An agent call that returns a receipt, then its result through `task_wait`                 |
| `agent-call-held-turn.ndjson`       | An agent call that returns a receipt, then its result in the same, held turn              |
| `task-cancel.ndjson`                | A workflow tool task stopped with `task_cancel`                                           |
| `agent-timed-out.ndjson`            | An agent call waited on with `task_wait` that fails with `TIMED_OUT`                      |
| `remote-agent-input-request.ndjson` | A remote agent call whose approval appears as `input.requested`, then as `input.resolved` |

`manifest.json` records the `streamVersion` to serve the files with as `x-eve-stream-version`, the `taskProtocolVersion`, and, for each fixture, its `file`, `sessionId`, and the task states a consumer should derive from it: `taskId`, `name`, `kind`, `mode`, `status`, `errorCode`, `generations`, `remote`, `inputRequests`, and `delivered`.

eve records the fixtures from real runs with mock models, and its test suite fails when a fresh recording no longer matches them, so they describe the release they ship in. Session, turn, task, request, and delivery IDs, timestamps, trace IDs, the eve version, and deployment origins are replaced with stable placeholders such as `session-root`, `turn-1`, `researcher-000001`, and `https://billing.example`. The replacements are consistent within a file, so references such as `child.streamPath` still match. Events keep their recorded order, except that where a detached child's `task.started` lands relative to its turn varies between runs, so a consumer must not depend on it. The `v1` directory changes only when the file layout changes; compare `streamVersion` and `taskProtocolVersion` with the versions your consumer supports.

```ts
import { readFile } from "node:fs/promises";
import type { MessageStreamEvent } from "eve/client";

const manifestUrl = new URL(import.meta.resolve("eve/conformance/task-streams/v1/manifest.json"));
const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));

for (const fixture of manifest.fixtures) {
  const text = await readFile(new URL(fixture.file, manifestUrl), "utf8");
  const events = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as MessageStreamEvent);
  // Feed `events` to your consumer, then compare what it derived with `fixture.tasks`.
}
```

## What to read next

- [Workflows as tools](../tools/workflows): define workflow tools, `detach`, and `timeout`.
- [Subagents](../subagents): agent tools, `background`, and agent messaging.
- [Sessions, runs, and streaming](./sessions-runs-and-streaming): the full event set and session controls.
