---
title: "Tasks"
description: "How eve runs agent calls and workflow tool calls as tasks: detached and attached calls, task_wait, held turns, steering, resumable tasks, cancellation, time limits, and task stream events."
---

A task is one call to an agent or a workflow tool, plus any input later sent to it. eve runs every agent call as a task, whether the call goes to the built-in `agent` tool, a declared or dynamic [subagent](../subagents), a [remote agent](../guides/remote-agents), or `ctx.agent` in a workflow body. Every [workflow tool](../tools/workflows) call is also a task, including eve's `ask_question`, `sleep`, and `workflow` tools. Plain tools and MCP tools run inside the model step and are not tasks.

Most calls are detached: the call returns a receipt at once, and the task keeps working while the model continues. The model gets the result by waiting for it with `task_wait`, or later in the same turn, because no turn ends while tasks it started are working. Most agents and tools configure nothing.

Tasks are unrelated to task mode, the run mode of a session that runs to completion or fails without parking to wait for a person, such as a markdown [schedule](../schedules) or an MCP `agent_start` call.

## Detached and attached calls

A detached call returns a receipt right away, and a new message never stops its task. An attached call holds its turn: the turn waits for it, its result is the tool result, and a new message ends it.

| Call                                                                                                 | Runs                                      | A steering message during the call                       |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------- |
| An agent tool: the built-in `agent`, or a declared, dynamic, or remote subagent                      | Detached                                  | Nothing; the task keeps working                          |
| A workflow tool by default or with `resumable: true`, including eve's `workflow` and `agentRouter()` | Detached                                  | Nothing                                                  |
| A send: a resumable tool called with a `taskId`                                                      | Returns a receipt at once                 | Nothing                                                  |
| A workflow tool with `attached: true`, and eve's `sleep` and `ask_question`                          | Attached                                  | Cancels the call, or dismisses a dismissible question    |
| `task_wait`                                                                                          | Attached                                  | Ends the wait with `interrupted`; the task keeps working |
| `ctx.agent` in a workflow body                                                                       | The body awaits it                        | Not applicable                                           |
| Plain tools and MCP tools                                                                            | Inside the model step; they are not tasks | Applied at the next step boundary                        |

Calls that the model makes in one step run in parallel. A detached call's tool result is a receipt. Clients read it on `action.result` as `output: { status: "working", taskId }`, typed as `TaskReceipt` from `eve/client`, and the model reads:

```text
Started task researcher-7k2m9q. Call researcher again with taskId researcher-7k2m9q to send it more input; use task_wait for its result.
```

A task that takes no more input, such as a call to a workflow tool without `resumable: true`, gets the receipt without the middle clause: `Started task run_tests-3fq8wd. Use task_wait for its result.`

Each task has an ID such as `researcher-7k2m9q`: the name of the tool that started it and six characters that eve assigns before the task starts. The ID appears in receipts, in the [`[Tasks]` note](#the-tasks-note), and on every [task stream event](#task-stream-events), and it is what `task_wait`, `task_cancel`, and [sends](#resumable-tasks-and-sends) take.

eve offers [`task_wait`](./built-in-tools#task_wait), [`task_cancel`](./built-in-tools#task_cancel), and a short system prompt block about tasks in every session whose agent can start a detached task: an agent with an agent tool or a workflow tool without `attached: true`. The set is fixed when the session starts, so the tools and system prompt do not change between turns.

Workflow tool authors choose attachment with [`attached: true`](../tools/workflows#hold-the-turn-with-attached). Agents have no option; the model decides per call whether to wait.

## Wait for results

`task_wait` holds the turn until a task's next result, and returns that result as its tool result:

```ts
task_wait({ taskId: string; timeout?: number }); // timeout in milliseconds
```

- A result the model has not seen returns at once, if one is waiting. A result that `task_wait` returns counts as delivered and never arrives again.
- On an idle [resumable task](#resumable-tasks-and-sends) with nothing new, the wait returns at once and says so.
- `timeout` bounds the wait, from `0` to 2,147,483,647 milliseconds (about 24.8 days). Without it, the wait lasts until the result or a new message arrives. `0` returns at once with the task's current state. Ending a wait never stops the task.
- A [steering message](#steering-during-a-turn) ends the wait with `interrupted`, and the model reads the message in the same step.
- A task that waits on a person keeps the wait going. The person's answer is not a steering message, so it does not end the wait.
- If the task is cancelled while a wait covers it, the wait returns the result as `cancelled`.

To wait on several tasks, the model calls `task_wait` once for each in the same step. The step ends when every wait has returned, and a new message interrupts all of them. If two waits in one step name the same task, the earlier call gets the result and the later one fails with `TASK_ALREADY_WAITED`. A wait covers only the caller's own tasks: a task another principal started fails with `TASK_OTHER_PRINCIPAL`.

Clients read the wait's outcome on `action.result`, typed as `TaskWaitOutput` from `eve/client`: `{ status: "settled", taskId, name, outcome }`, where `outcome` is `{ status: "completed", output }`, `{ status: "failed", error: { code, message } }`, or `{ status: "cancelled" }`, or `{ status: "timed_out" | "interrupted" | "idle", taskId }`. The model reads one of these forms:

```text
<task_result id="d0-2b0c1a" tool="d0" status="completed">
Q3 revenue fell 4% in EMEA.
</task_result>

Stopped waiting after 5 min; researcher-7k2m9q is still working. Its result arrives in a later message before your turn ends; wait again only if you need it now.

A new message arrived, so the wait ended after 40 s; d0-2b0c1a is still working. Read the message and decide whether it changes this work: keep the task, call d0 again with its taskId to correct it, or stop it with task_cancel.

release_notes-4hd8sa is idle and has no new result. Call release_notes with its taskId to give it more work.
```

A task waiting on a person reads `is waiting on a person` instead of `is still working`.

## How results arrive

A result that no wait received reaches the model as typed session input, never as a channel message. The model reads one user-role message of kind `task.result`, with one `<task_result>` block per result:

```text
<task_result id="remind-q4x1ze" tool="remind" status="completed">
Reminder: stand-up at 10
</task_result>
<task_result id="auditor-2b0c1a" tool="auditor" status="failed" code="TIMED_OUT">
The agent did not finish within 2 h and was stopped.
</task_result>
```

`tool` names the tool that started the task, which is the tool a send calls. A workflow tool's block body is the definition's `toModelOutput(output)` when it has one. Otherwise the body is the output, or the error message for a failed result. `task_wait` returns the same block.

The model reads every task result under one truncation limit, whether an attached call, a wait, or a `task.result` message delivers it: the body is cut at 50 KB or 2,000 lines, with a final `[truncated]` line where the cut falls, and a line longer than 2,000 characters is cut with ` [truncated]`. An attached call's structured output that fits stays structured; one past the limit reaches the model as its truncated JSON text. `action.result`, `task.settled`, and `ctx.agent` still carry the full output, with one exception: a remote agent's result that eve [recovers at the call's deadline](#time-limits) after its callback was lost. The remote session keeps each result for that read with any output larger than 50 KB already cut to the same limit, so such an output arrives everywhere as its truncated text, including structured output.

Each result belongs to the principal whose call started the task. Two principals match when their authenticator, principal type, and principal ID match. Every result arrives in the turn that started its work:

- **At a tool step.** A result that settles while the turn works is added at the turn's next tool step, where the model is called again.
- **In a wait.** A `task_wait` call on the task returns the result as its tool result.
- **In a held turn.** When the model tries to end the turn while tasks it started are working, eve [holds the turn](#held-turns) and calls the model again with the result.
- **Turn waiting on a person.** While a turn waits on its own approval or question, results wait until the request is answered and the turn continues.

Results that settle together share one message. No result starts a turn of its own, so an idle session never wakes for one, and a result never appears in another principal's turn. A task that eve or the model [cancels](#cancel-tasks) delivers no result, except to a wait on it.

On the session stream, a delivery appears as `message.received` with `data.kind: "task.result"` and `data.taskIds`. It is not a user message. The default client reducer, the dev TUI, and the built-in channels do not render it as one, and custom renderers should skip it too.

## Held turns

No turn ends while tasks it started are working, including work started by its sends. When the model ends such a turn, eve holds it and calls the model again as soon as any of those tasks settles, with every result that settled with it. One task that waits on a person never delays the others' results. The check repeats until no task the turn started is working. When a turn requested an output schema, a `final_output` call made while tasks work returns an error that names them, so the model waits for them or cancels them first.

Only `session.cancel()`, the session's expiry or reset, or a turn failure ends a held turn early, and each one cancels the turn's working tasks first. Task [time limits](#time-limits) and the session's lifetime bound every hold. Work meant for much later, such as a reminder next week, belongs in a [schedule](../schedules), not a task.

What the model says before the hold streams as an ordinary `message.completed`, and the built-in channels post it, so a person sees that work started. The turn ends once, with `turn.completed`, after the model replies to the results. How the wait looks depends on the session:

- **Interactive root session.** A root session in conversation mode that no caller created, such as one a channel or `client.sessions.create()` starts. After the model's message, the stream carries `session.waiting` without `turn.completed`: the session is open to input while the turn keeps running. A person can keep writing, and a message from the turn's own principal joins the held turn. Its later events carry the same `turnId` with no new `turn.started`. Cancelling a held turn ends it with `turn.cancelled` for that ID.
- **Every other session.** A subagent's turn, a turn that a schedule started, and a task-mode run hold without `session.waiting`, since no one writes into them. A subagent answers its caller once, with its final reply, after its tasks settle.

See [Held turns](./sessions-runs-and-streaming#held-turns) for how clients read a held turn.

The hold covers every working task that the turn's principal started, not only tasks with the current `turnId`, because a turn that parks on an approval or a sign-in resumes under a new turn ID and still holds on the work it started.

## Steering during a turn

Only a turn's own principal can steer it. A message from anyone else, whatever its `turnPolicy`, waits until the turn ends and then starts that principal's own turn, because a turn runs with its principal's credentials. Every unauthenticated caller is the same anonymous principal, so anonymous callers can steer each other's turns.

When a steering message (`turnPolicy: "steer"`, the default) from the turn's principal arrives, eve applies it in this order, in every session. In a subagent's session, a send from the caller is such a message.

1. If the message answers a pending question, it answers the question and does not steer. See [Ask a human](../tools/workflows#ask-a-human-ctxask) for when plain text answers a question.
2. Otherwise, each pending question created with `dismissible: true` resolves as `dismissed`, and its call returns as usual. A call still working 10 seconds later is cancelled like the attached calls in step 3.
3. Every attached call still in flight ends, including a held turn's wait. A `task_wait` returns `interrupted`. An attached workflow tool, such as `sleep`, is cancelled through the normal [cancel path](#cancel-tasks), and its tool result reads `Stopped after 12 s because a new message arrived.`

Detached tasks keep working, and the model reads the message in the same step. It then decides whether the message changes the work: keep the tasks, [correct one with its `taskId`](#resumable-tasks-and-sends), or stop one with `task_cancel`. Steering never ends the turn. A message with `turnPolicy: "queue"` waits until the turn ends.

An attached tool's approval is not dismissible, so a steering message cancels an attached call that waits on one. Keep tools that ask for approval detached, which is the default.

## Resumable tasks and sends

A resumable task takes more input after it starts. Every agent task is resumable, and so is every task of a workflow tool defined with [`resumable: true`](../tools/workflows#take-more-input-with-resumable). To send a task more input, the model calls the tool that started it again, with the task's `taskId`:

```ts
researcher({ message: "Only EMEA matters.", taskId: "researcher-7k2m9q" });
release_notes({ request: "Make it shorter.", taskId: "release_notes-4hd8sa" });
```

The tool's own input schema validates a send, so a send carries the same fields as a start. Without `taskId`, each call starts a new task. eve adds a sentence that says so to every resumable tool's description, agents included, and adds `taskId`, a string of at most 128 characters, to its input schema. A send whose other fields do not match the schema fails like any invalid call, and its error adds that a call with `taskId` uses the tool's input schema too.

Each piece of work on a task is a generation, from the input that starts it to its one result. A non-resumable task has one generation.

- **A send to an idle task** starts its next generation. The model reads `Sent to task release_notes-4hd8sa, which is now working on it. Use task_wait for its result.`
- **A send to a working task** reaches its current work if the task reads it: an agent receives it as a steering message in its current turn, and a workflow body receives it from `ctx.receive()`. Otherwise the current generation ends with its own result, and the next starts right away with the send. The model reads `Sent to task researcher-7k2m9q, which is still working. It uses your input in its current work or starts on it right after; use task_wait for its next result.`

Every send gets exactly one result: the result of the generation it joined or started. A send to a task that ends before reading it gets the generation it would have started, which fails at once with `EXECUTION_FAILED` and the message `The task ended before it read this input.`

eve delivers a send to an agent up to three times with the same operation ID when a request fails in a way that may clear, and the agent admits each operation once, so a retry never repeats a message. When a working agent cannot be reached at all, the result depends on whether it may have the message:

- An agent that answered every attempt with a refusal, such as a session not ready yet, does not have it. The send fails with `TASK_UNREACHABLE`, as described below.
- If an attempt got no answer, such as a timeout, or a server error, the agent may have the message. The send stays queued and the model reads `Sent to task researcher-7k2m9q, but eve could not confirm that it arrived. If it did, the task uses it in its current work or starts on it right after; if not, a result for this call says so. Use task_wait for its next result before you send it more input.` Further sends to that task fail with `TASK_BUSY` until the agent answers. If the answer shows the agent read the message, the send joined that work. Otherwise the send's generation fails at once with `TASK_UNREACHABLE`, and the model can send it again.

A send to an idle agent starts its next generation only once the agent takes it: a send it did not take changes nothing, and `task.started` is published only for a generation the agent works on.

A send fails, and changes nothing, in these cases:

| Code                   | When                                                                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNKNOWN_TASK`         | The session has no open task with that ID: it never existed, it ended, or it was retired.                                                                                                                                                         |
| `TASK_OTHER_PRINCIPAL` | Another principal started the task. Only the task's creator can send to it, because it acts with its creator's credentials.                                                                                                                       |
| `TASK_MISMATCH`        | The task belongs to another tool. The message names the tool to call.                                                                                                                                                                             |
| `TASK_BUSY`            | A workflow body is awaiting the task's current work with `ctx.agent`, the task already holds 20 sends it has not read, or eve could not confirm that the task's agent received the previous send.                                                 |
| `TASK_UNREACHABLE`     | The task's child cannot take input. The message says whether to try again, for example after a timeout, or to start a new task because the child is gone for good, such as an agent session that ended; a child gone for good also ends the task. |
| `TOO_MANY_TASKS`       | The send would start an idle task's next generation while 20 tasks are working.                                                                                                                                                                   |

An idle task stays available for as long as its session lives, unless the [idle limit](#task-limits) retires it first. An idle agent's session is parked, and an idle workflow tool run is parked on its command hook; neither holds compute. A send reaches an idle run on the deployment that started it.

## The `[Tasks]` note

The model learns which tasks are out and which it can continue from the `[Tasks]` note. It is a framework-authored user-role message of kind `context.state` that eve appends at a model-step boundary whenever its listing changes, and again after compaction or a context clear. The latest note is current, and the system prompt tells the model that eve writes it and that it never needs a reply:

```text
[Tasks]
<tasks>
<task id="researcher-7k2m9q" tool="researcher" status="working" started="2026-09-24T14:02Z"/>
<task id="refund_order-b81d0c" tool="refund_order" status="input_required" started="2026-09-24T14:03Z"/>
</tasks>
<idle>
<task id="d0-2b0c1a" tool="d0">Answered the Q3 revenue question.</task>
<task id="release_notes-4hd8sa" tool="release_notes">Second draft of the 0.67 notes.</task>
</idle>
```

A turn's note lists only tasks its principal started, the only ones the turn can wait on, cancel, or send to. `<tasks>` lists every such detached task whose result has not reached history, with its status: `working`, `input_required` while it waits on a person, or its outcome once it settles. Attached calls and cancelled work are not listed. `<idle>` lists the 10 most recently started idle tasks, agents and resumable workflow tools alike, each with the tool that takes its `taskId` and a summary of its latest result of at most 200 characters. A session that never had a detached or idle task gets no note. eve never appends the note while a tool call is unanswered, such as between a tool approval response and its tool call.

eve keeps a task's record only as long as it needs it: until the task has ended and its results have reached history. A report that arrives after its record is gone matches no record and is dropped, like a duplicate. Every report names the call it answers, so a late report can never settle another task.

## Answer questions and approvals from tasks

A question or approval from a task, such as an agent's tool approval or a workflow tool's `ctx.ask`, reaches the root session's stream as `input.requested` with the task's `taskId`, and you answer it on the root session with `inputResponses`, as for the root agent's own requests. Requests from the agents an agent starts, at any depth, reach the root the same way, and each one stays answerable on its own. Anyone who can send to the root session can answer. The answer is attributed to the principal that gave it, which is the `responder` an [approval response policy](../human-in-the-loop#authorizing-approval-responses) checks, while the task keeps acting as the principal that started it.

A plain message from a person also answers a task's question when it is the only pending question, the root session waits on no approval or session-limit prompt of its own, and the text matches one of its options or the question allows free text, the same rule as for a workflow tool's [`ctx.ask`](../tools/workflows#ask-a-human-ctxask). A plain message never answers an approval.

Once the answer to an agent's question reaches the agent that asked it, the root session's stream carries the question's `input.resolved`, and the question takes no other answer: a later message or response for it stays with the root session. An approval stays answerable until the agent resolves it, because the agent's [approval response policy](../human-in-the-loop#authorizing-approval-responses) may refuse the responder and keep the approval pending for another; the stream then carries the agent's `input.resolved`. Either event names each request by its `requestId`.

A request is withdrawn when its task stops waiting on it for any other reason: the task is cancelled, times out, or finishes first. The root session's stream then carries `input.resolved` with `outcome: "ignored"` for the request, and an answer that arrives later stays with the root session.

An answer that can never reach a remote agent fails its task: with `AGENT_SESSION_ENDED` when the agent's session is gone, and with `TASK_UNREACHABLE` when the agent's deployment now uses another task protocol version. An answer that fails for a reason that may clear, such as a timeout, stays answerable.

## Cancel tasks

The model stops one task with [`task_cancel`](./built-in-tools#task_cancel). It passes one `taskId` and gets back `{ status: "cancelled" }`, or `{ status: "already_finished" }` when the task had already settled (typed as `TaskCancelOutput` from `eve/client`), in which case its result is still delivered. `task_cancel` stops the task's current work and every send queued for it. A task another principal started fails with `TASK_OTHER_PRINCIPAL`, and an attached call the turn still holds fails with `UNKNOWN_TASK`.

Application code cancels through `session.cancel()` on a [client session](../guides/client/overview#sessions), a channel session handle, or `POST /eve/v1/session/:sessionId/cancel`. It cancels the active turn, its attached calls, and every working task, whichever turn started it, then ends the turn. Pass the observed `turnId` to keep a late request from cancelling a newer turn. With no active turn, it still cancels working tasks: every one, or, when the request passes a `turnId`, only those that turn started. `session.cancel()` takes no task options: the `taskId` and `tasks` options are removed, a channel session handle throws a `TypeError` for either, and the cancel route answers `400`. Any caller with access to a session can cancel it. See [Cancel the in-flight turn](./sessions-runs-and-streaming#cancel-the-in-flight-turn) for the route's statuses and race behavior.

Idle tasks are not working, so neither `task_cancel` nor `session.cancel()` ends them; they stay available for sends. Cancelling work does not end its task:

- A cancelled agent's session idles, and the agent takes new work through its `taskId`.
- A resumable workflow body decides: returning or throwing ends the task, and calling `ctx.receive()` leaves it idle.
- A non-resumable task ends with its only generation.

eve also cancels tasks on its own. When a workflow generation ends, by `ctx.reply` or by returning, eve first cancels every task it still owns, such as an agent call it never awaited. Aborting the `signal` passed to `ctx.agent` cancels that call's task. A session's expiry or reset, and a turn failure, cancel the turn's working tasks.

Ending a session ends every task, idle ones included, and eve delivers nothing afterward. Each agent the session started then ends its own session the way a reset session does: it cancels its turn and its own tasks, and ends the agents it started in turn. A remote agent ends through its session-reset route. The ending session does not wait for them. A local agent that was working is stopped outright if it is still running 30 seconds after the session ended, and so is a workflow run still running after 35 seconds. An idle local agent that the request to end did not reach gets the request again after 30 seconds, and is stopped outright only if that request also fails, so an agent that was only moving to another deployment still ends its own tasks and agents.

Every cancellation takes effect in the owner at once. eve records the work as cancelled, emits `task.settled` with `status: "cancelled"`, and asks the child to stop without waiting for it. A workflow run observes `ctx.abortSignal`; see [Cancel and clean up](../tools/workflows#cancel-and-clean-up-ctxabortsignal). If a local agent has not stopped 30 seconds after a cancel or a timeout, eve terminates its session and ends the task, so a later send with its ID fails with `UNKNOWN_TASK`. A workflow run that has not ended 35 seconds after a cancel is stopped outright, which also ends its task.

## Time limits

Two settings bound a task's work, and a third bounds only a wait:

| Setting                                           | Applies to                            | Default                                | When it expires                                                         |
| ------------------------------------------------- | ------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------- |
| `timeout` on `defineAgent` or `defineRemoteAgent` | Each generation of that agent's tasks | 2 hours of active time                 | The generation fails with `TIMED_OUT`, and eve cancels the child's turn |
| `timeout` on `defineWorkflowTool`                 | Each generation of the tool's tasks   | None; the session's lifetime bounds it | The generation fails with `TIMED_OUT`, and eve cancels the run          |
| `timeout` on a `task_wait` call                   | That wait                             | None                                   | The wait returns `timed_out`, and the task keeps working                |

Durations are milliseconds. `timeout: false` removes the limit, but the session's lifetime, `limits.sessionTimeoutMs`, still bounds every task. On the root agent, `timeout` applies to calls of the built-in `agent` tool. Each generation starts a fresh clock. The clock stops while the task is idle or waits on a question, approval, or sign-in that reached the root session's channel, and resumes once every such request is resolved.

A generation that times out settles `failed` with the `TIMED_OUT` error: an attached call gets it as its tool result, and a detached task delivers it like any result. Before a generation times out, eve checks its child once, so a child that finished but whose report was lost still settles the generation with its result. For a remote agent, eve reads the remote session's result for that call. For a workflow tool, eve reads the run's status and the outcome the run returned; a run that failed before it reported fails the generation with `EXECUTION_FAILED`. A local agent is not read, because it reports through the session's durable inbox, which eve does not hand off to another deployment while any task is working. A generation with no time limit gets no such check: if its child's report never arrives, it keeps working until the session ends. See [Limit a call with `timeout`](../tools/workflows#limit-a-call-with-timeout) and the subagent `timeout` in [What the parent sees](../subagents#what-the-parent-sees).

## Task limits

A session has three fixed limits, which are not configurable:

- **20 working tasks.** Every working detached generation counts. A start over the limit, including a send that would start an idle task's next generation, does not start. Its tool result is an error with code `TOO_MANY_TASKS`. Every principal's tasks count toward the limit, but the error lists only the IDs of the caller's own working tasks and tells the model to wait for one or stop one first. Such a call emits no `task.*` event.
- **50 idle tasks.** Each time the session starts tasks past that, eve ends the idle tasks that started least recently, the calling principal's own first, so in a shared session one person's new tasks retire another person's only when the first has none idle. A retired task emits `task.ended`, and a later send with its ID fails with `UNKNOWN_TASK`. If the request to end a retired local agent does not reach it, for example because the agent is moving to another deployment, eve sends it again 30 seconds later and stops the agent outright only if that request also fails.
- **20 unread sends per task.** A send past that fails with `TASK_BUSY` and tells the model to wait for the task's next result first. Sends that a cancel stopped do not count.

## Remote agents

A call to a [remote agent](../guides/remote-agents) is a task like a local call, with the same receipts, waits, sends, results, cancellation, and events. `task.started` carries the remote target in `child.remote.url`.

The child side of the task protocol runs in the remote deployment, so the calling deployment and every remote agent it calls must use the same task protocol version, currently `1`. Before it creates a remote session, the caller reads the remote's version from the `x-eve-task-protocol` header of its `GET /eve/v1/health` response. A remote on another version, or on an older eve that reports none, fails the call at once with `START_FAILED`, before its model or tools run. Create, message, and answer requests, result and input callbacks, and accepted create and message responses carry the version as `taskProtocol`, and a deployment refuses a mismatch with `409` and `"code": "TASK_PROTOCOL_MISMATCH"`. Cancel and reset requests carry no version, so a caller can always stop a remote child. See [Upgrading remote agents](../guides/remote-agents#upgrading-remote-agents).

The caller applies each result a remote child reports once. It acknowledges a repeated result callback with `202`, like the first, and one that arrives after the caller's session ended with `200` and `{"ok":true,"duplicate":true}`; the child treats any `2xx` as delivered. See [Retries and lost callbacks](../guides/remote-agents#retries-and-lost-callbacks).

## Task stream events

Three events on the session stream describe tasks, for attached and detached calls alike. Channel `events` handlers and [hooks](../guides/hooks) can subscribe to each of them. Every workflow tool call is a task, so filter by `kind` and `name` when you only follow delegation.

| Event          | `data` fields                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task.started` | `taskId`; `generation`, counting from 1; `callId` of the call that started this generation; `turnId`; `name`; `kind` (`"agent"` or `"workflow"`); `mode` (`"attached"` when the calling turn or workflow body awaits the result, `"detached"` when the call returned a receipt); `resumable`; and, for an agent, `child` with `sessionId`, `streamPath`, and `remote.url` for a remote child, absent when the generation settled before its child reported |
| `task.settled` | `taskId`, `generation`, `callId`, and `status`: `"completed"` with `output`, `"failed"` with `error: { code, message }`, or `"cancelled"`; `usage` with `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, and optional `costUsd` when the child reported it                                                                                                                                                                            |
| `task.ended`   | `taskId`                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Consumers can rely on these rules:

- Each generation emits exactly one `task.started` and then exactly one `task.settled`, with its first outcome. A generation settles before the next one starts.
- Every `task.settled` follows a `task.started` for the same generation, including a generation that fails at once: a call that fails to start, such as with `START_FAILED`, emits `task.started` without `child`, and a send the task never read gets the generation it would have started, which fails with `EXECUTION_FAILED`. A call rejected before any task exists, such as one over the working task limit, emits none of these events; its error appears only on `action.result`.
- Each task emits exactly one `task.ended`, after its last `task.settled`, when it stops taking input: right after the only generation of a task that is not resumable, and when a resumable task's body returns, it is retired, it is stopped for good, or its session ends. A task is finished once it ended; no `task.*` event for it follows.
- For a detached agent call, the receipt on `action.result` and `task.started` can arrive in either order.
- A send to an idle task starts its next generation, with the send's `callId`. A send that joins a working generation emits nothing new, unless the child had already answered: it then runs the send as its next generation.
- When the root session proxies a child's `input.requested`, `approval.candidate`, `approval.settled`, `authorization.required`, or `authorization.completed` event, the event carries the child's `taskId`. An `input.requested` event for a workflow tool call's own question or approval carries that call's `taskId`. The matching `input.resolved` carries no `taskId`; correlate it with the request through `requestId`.
- A request withdrawn because its task settled gets its `input.resolved`, with `outcome: "ignored"`, before the task's `task.settled`.

Follow an agent's own progress by passing its `task.started` event to [`session.streamSubagent()`](../guides/client/streaming#follow-a-subagent), which reads `child.streamPath`.

### Error codes

`task.settled` for a failed generation, an attached call's tool result, and a failed `<task_result>` block carry the same `error.code`. Handle unknown codes, because an agent's own failure and a workflow tool's thrown error with a `code` pass their code through. A cancelled generation has no code: `task.settled` reports `status: "cancelled"`, and an attached call that its child cancelled gets an error result that is only a message.

| Code                          | Meaning                                                                                                                                                                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `START_FAILED`                | The child could not start: a local agent's session, a workflow tool run, or a remote agent, including one on another task protocol version.                                                                                                           |
| `TIMED_OUT`                   | The generation was still working at its `timeout`. The message names the limit, such as `The agent did not finish within 2 h and was stopped.`                                                                                                        |
| `AGENT_SESSION_ENDED`         | The agent's session expired, reset, or closed before it replied.                                                                                                                                                                                      |
| `TASK_UNREACHABLE`            | A remote agent could not take an answer because its deployment now uses another task protocol version, or eve could not confirm that an agent received a send and the agent answered without reading it.                                              |
| `OUTPUT_SCHEMA_NOT_FULFILLED` | The agent could not produce a result matching the call's `outputSchema`.                                                                                                                                                                              |
| `EMPTY_RESULT`                | The agent finished without a reply. A call with an `outputSchema` never fails this way, because its result is structured.                                                                                                                             |
| `STATE_LOST`                  | eve could not read the task's saved state, such as a task that an earlier eve release left working. The session continues.                                                                                                                            |
| `EXECUTION_FAILED`            | The work failed without a code of its own, such as an agent's turn or session, a workflow tool run that failed before it reported, a send the task never read, or a workflow generation whose result never reached the session. The message says why. |

The model-facing task tools and sends fail with these codes on their tool result. Each message tells the model what to do next.

| Code                   | Returned by                        | Meaning                                                                                                                                        |
| ---------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNKNOWN_TASK`         | `task_wait`, `task_cancel`, a send | The session has no open task with that ID, or the ID names an attached call still in flight.                                                   |
| `TASK_OTHER_PRINCIPAL` | `task_wait`, `task_cancel`, a send | Another principal started the task.                                                                                                            |
| `TASK_MISMATCH`        | A send                             | The task belongs to another tool.                                                                                                              |
| `TASK_BUSY`            | A send                             | A workflow body awaits the task's current work, the task holds 20 unread sends, or eve could not confirm its agent received the previous send. |
| `TASK_UNREACHABLE`     | A send                             | The task's child cannot take input, for now or for good.                                                                                       |
| `TASK_ALREADY_WAITED`  | `task_wait`                        | Another `task_wait` in the same step already waits on the task.                                                                                |
| `TOO_MANY_TASKS`       | A start, or a send to an idle task | 20 tasks are already working.                                                                                                                  |
| `INVALID_INPUT`        | `task_wait`, `task_cancel`         | The input has no valid `taskId`, or `task_wait` has an invalid `timeout`.                                                                      |

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

- [Workflows as tools](../tools/workflows): define workflow tools, `attached`, `resumable`, and `timeout`.
- [Subagents](../subagents): agent tools, sends with `taskId`, and waiting on agents.
- [Sessions, runs, and streaming](./sessions-runs-and-streaming): the full event set and session controls.
