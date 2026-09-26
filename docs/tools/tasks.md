---
title: "Tasks"
description: "Run agent and workflow tool calls as tasks that keep working while the conversation continues, and control how the model waits for, corrects, and cancels them."
url: /tools/tasks
---

A task is a tool call that returns a receipt right away and keeps working while the conversation
continues. Every call to an agent is a task, and so is every call to a
[workflow tool](/docs/tools/workflows) that defines `task(input, ctx)` or `serve(receive, ctx)`.
A task's result reaches the model later, in a `task.result` message, and a turn can't end while
tasks it started are still working.

This page covers when to use a task, how to order work that depends on a result, the signals a
workflow tool body receives, and what the model and the stream see.

## Choose how a call runs

A workflow tool defines exactly one entry point, and the entry point answers one question: should
the conversation continue while the call works?

```ts
defineWorkflowTool({ /* … */ async execute(input, ctx) {} }); // the turn waits until the call settles
defineWorkflowTool({ /* … */ async task(input, ctx) {} }); // a task: a receipt now, the result later
defineWorkflowTool({ /* … */ async serve(receive, ctx) {} }); // a task that accepts more calls
```

Defining none of the three, or more than one, throws when the tool is defined.

| Call                                                                    | Runs as                   | Result                                            | A new message during the call      |
| ----------------------------------------------------------------------- | ------------------------- | ------------------------------------------------- | ---------------------------------- |
| `execute` workflow tool, including `sleep` and `ask_question`           | Tool call; the turn waits | The tool result                                   | Fires the call's `interruptSignal` |
| `task` workflow tool, including `agentRouter()` and the `workflow` tool | Task                      | A receipt, then a `task.result` message           | Nothing                            |
| `serve` workflow tool, including every agent tool                       | Resumable task            | A receipt, then a `task.result` message per reply | Nothing                            |
| `task_wait`                                                             | Wait inside the turn      | Which tasks settled                               | Ends the wait                      |
| Plain and MCP tools                                                     | Inside the model step     | The tool result                                   | Applied at the next step boundary  |

Waiting alone doesn't need a task. A question, a `sleep`, or an approval inside an `execute` call
parks the turn durably and holds no compute. Use a task when the model should keep talking while
the work runs, such as a twenty-minute deploy or research the model may not need right away. A
long `execute` tool holds the conversation until it settles.

Agents have no choice to make: every agent tool is a `serve` tool, so every agent call is a
resumable task, because only the model can tell from the conversation whether it needs an agent's
answer now. The [turn rule](#turns-wait-for-their-tasks) guarantees the answer reaches the model
before the turn ends.

See [Run calls as tasks](/docs/tools/workflows#run-calls-as-tasks-task) for writing a `task` body
and [Resumable tasks](/docs/tools/workflows#resumable-tasks-serve) for `serve` bodies,
`receive()`, and `ctx.reply()`.

## Order work that depends on a result

Because agent calls are tasks, the model decides when to wait for them. An instruction such as
"publish only after the review approves" holds only as long as the model follows it. When an order
must always hold, write a workflow tool that runs the first step through
[`ctx.agent`](/docs/tools/workflows#delegate-work-ctxagent) and then acts, and don't expose the
side effect as a separate tool:

```ts title="agent/tools/publish_reviewed_notes.ts"
import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import { publishNotes } from "../lib/release";

const Review = z.object({ approved: z.boolean(), reason: z.string() });

export default defineWorkflowTool({
  description: "Have the reviewer check the release notes, then publish them if approved.",
  inputSchema: z.object({ notes: z.string() }),
  async execute({ notes }, ctx) {
    "use workflow";
    const response = await ctx.agent("reviewer").send(`Review these release notes:\n\n${notes}`, {
      outputSchema: Review,
      signal: ctx.abortSignal,
    });
    const { data, status } = await response.result();
    if (status === "failed" || data === undefined) {
      throw new Error("The review did not finish.");
    }
    if (!data.approved) return { published: false, reason: data.reason };
    return { published: true, url: await publish(notes) };
  },
});

async function publish(notes: string) {
  "use step";
  return await publishNotes(notes);
}
```

The publish step can only run after the review returns. Set `tool: false` on the `reviewer`
subagent if the model shouldn't call it directly, and define `task` in place of `execute` if the
conversation should continue while the review runs.

## Pass signals to the work

A workflow tool body receives its signals from its context or, in a `serve` body, from each call
`receive()` resolves:

- **`abortSignal`** aborts when the call's work is cancelled: by `task_cancel`, `session.cancel()`,
  a cancelled or failed turn, or the end of the session. `execute` and `task` bodies read it as
  `ctx.abortSignal`. In a `serve` body, each call from `receive()` carries its own `abortSignal`;
  every call in one stretch of work shares one signal, and the next stretch gets a new one. Pass it
  to the steps and `ctx.agent` sends that should stop.
- **`ctx.interruptSignal`** aborts once, on the first steering message that arrives while the turn
  waits on the call. Only `execute` calls have it, because the conversation never waits on a task.
  What it means is the tool's choice: a body that ignores it keeps going, and one that should stop
  early races or passes it.
- **`ctx.ask(request, { signal })`** withdraws the question when `signal` aborts. The answer
  resolves as `{ status: "cancelled" }`, and the stream reports `input.resolved` with
  `outcome: "cancelled"` so channels stop offering the question. The call's `abortSignal` withdraws
  a pending question the same way.

Pass `ctx.interruptSignal` when a question should lapse once the conversation moves on. The
provided `ask_question` tool does, so a steering message that doesn't answer its question
withdraws it. Omit the signal, as an approval usually should, to keep the question open through
unrelated messages:

```ts
async execute({ service }, ctx) {
  "use workflow";
  const answer = await ctx.ask(
    { prompt: `Deploy ${service} now?`, display: "confirmation", options: DEPLOY_OR_WAIT },
    { signal: ctx.interruptSignal }, // omit to keep asking through unrelated messages
  );
  if (answer.status === "cancelled") return { deployed: false, reason: "the conversation moved on" };
  // …
}
```

See [Stop early for a new message](/docs/tools/workflows#stop-early-for-a-new-message-ctxinterruptsignal)
for how the provided `sleep` tool races its timer against the signal.

## What the model sees

eve adds `task_wait`, `task_cancel`, and a short system prompt block that explains tasks whenever
the agent has an agent tool or a `task` or `serve` workflow tool.

**Receipts.** A call that starts a task returns a receipt as its tool result. Task ids are the tool
name and six characters. A resumable task's receipt tells the model how to reach it again, and a
call that reaches it by `taskId` returns a short receipt of its own:

```text
Started task deploy-4hd8sa.
Started task researcher-7k2m9q. Call researcher again with taskId researcher-7k2m9q to send it another message.
Sent to task researcher-7k2m9q.
```

**Results.** Each result arrives once, as a `<task_result>` block in a `task.result` message that
eve appends at the next step boundary, right after `task_wait` returns, or when a held turn
resumes. The body is the tool's `toModelOutput` projection of the output, or the error message for
a failed call. All results in one message share a budget of 50 KB and 2,000 lines, after which the
text is cut and marked `[truncated]`.

```text
<task_result id="deploy-4hd8sa" tool="deploy" status="completed">{"url":"https://…"}</task_result>
```

**`task_wait({ timeout? })`** parks the turn until one of the caller's tasks has a result, a new
message arrives, or `timeout` milliseconds pass. It returns at once when a result is already
waiting, and a `timeout` of `0` returns at once with any results that are ready. Waiting never
stops a task. The model reads which tasks settled and which are still working, for example:

```text
deploy-4hd8sa completed; its result follows. 1 task is still working: researcher-7k2m9q.
```

**`task_cancel({ taskId })`** stops a task's current work and returns `{ status: "cancelled" }`.
When the task has no work to stop, because it already finished or is an idle resumable task, it
returns `{ status: "already_finished" }`.

**`[Tasks]` note.** When the caller's tasks change, eve adds a note at the next step boundary that
lists the working tasks and the 10 most recently used idle resumable tasks. The note returns after
[compaction](/docs/concepts/default-harness#compaction), so the model can always find a task id:

```text
[Tasks]
<tasks>
<task id="deploy-4hd8sa" tool="deploy" status="working"/>
</tasks>
<idle>
<task id="researcher-7k2m9q" tool="researcher"/>
</idle>
```

**Errors.** Two error codes are specific to tasks:

| Code             | When                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| `UNKNOWN_TASK`   | A call's `taskId` names no unfinished resumable task that the same tool started for the caller               |
| `UNKNOWN_TASK`   | `task_cancel`'s `taskId` names no task the caller started; a finished or idle one returns `already_finished` |
| `TOO_MANY_TASKS` | A call would start a task, or make an idle one work, while 32 tasks are working                              |

A `final_output` call made while tasks are working returns an error that names them.

## Turns wait for their tasks

No turn ends while tasks it started are working. When the model ends a turn early, eve waits as
`task_wait` does: it parks until one of the tasks settles or the same caller steers the turn,
appends the results, and calls the model again in the same turn. No result ever starts a turn on
its own. An idle resumable task isn't working, so it doesn't hold the turn.

How a held turn looks depends on the session:

- **Root sessions** show a waiting boundary. The model's text before the wait completes as an
  ordinary message, and the stream emits `session.waiting` with the held `turnId`. The person can
  keep writing, and the turn resumes under the same id.
- **Child sessions and a schedule's sessions** show no boundary. The held text step reports
  `finishReason: "tool-calls"` on `message.completed`, so channels post only the final reply.

In every session, `turn.completed` comes only when the turn really ends, so the TypeScript
client's `send(...).result()` and the MCP channel's `agent_get` report the final reply rather than
the text written before the wait. The [Slack channel](/docs/channels/slack) also posts the text of
a step whose only tool call is `task_wait`, so people see what the agent is waiting on.

A steering message from the turn's own caller, one sent with `turnPolicy: "steer"`, the default,
ends a `task_wait` and fires the `interruptSignal` of any `execute` call the turn waits on, but it
never interrupts a task. The model reads the message and decides whether to keep each task,
correct an agent by calling it again with its `taskId`, or stop a task with `task_cancel`. A
`"queue"` message, or a message from another caller, waits for the turn to end.

## Cancel a task

- **`task_cancel`** stops one task's current work.
- **`session.cancel()`** cancels the turn, the `execute` calls it waits on, and every working task
  in the session.
- **A failed turn** cancels the tasks it started.
- **The end of the session** ends every task.

Cancelled work never reports back. A `task` tool's task is then finished; if its run is still
going 30 seconds after the cancel, eve stops it. A `serve` tool's task stays available instead:
its waiting calls settle as `cancelled`, the stretch's `abortSignal` aborts, and the task becomes
idle, as long as the body catches that abort and returns to `receive()`. For an agent, that
cancels the agent's current turn and keeps its conversation, so a later call with the same
`taskId` continues where it left off.

## Stream events

| Event           | When                                                                     | Data                                                  |
| --------------- | ------------------------------------------------------------------------ | ----------------------------------------------------- |
| `task.started`  | A call starts a task, or reaches a resumable task by its `taskId`        | `taskId`, `callId`, `turnId`, and the tool `name`     |
| `task.settled`  | A reply, return, failure, or cancel settles one call                     | `taskId`, `callId`, `status`, and `output` or `error` |
| `agent.started` | A workflow run, including an agent tool's, opens a session with an agent | `callId`, `name`, `sessionId`, and `streamPath`       |

`task.started` and `task.settled` come once each per call, and `(taskId, callId)` identifies the
call. `status` is `"completed"`, `"failed"`, or `"cancelled"`. A result reaching the model appears
as `message.received` with `data.kind: "task.result"`, and an `input.requested`,
`authorization.required`, or `authorization.completed` event from a task's run carries its
`taskId`. Hooks subscribe to the same events. See
[Sessions, runs, and streaming](/docs/concepts/sessions-runs-and-streaming#task-events) and
[Follow a subagent](/docs/guides/client/streaming#follow-a-subagent).

## Callers and limits

- **Callers.** Only the caller that started a task can continue it by `taskId` or cancel it, and
  `task_wait` and the `[Tasks]` note cover only the current caller's tasks. Anonymous callers share
  one identity.
- **Working tasks.** A session runs at most 32 working tasks at once. An idle resumable task doesn't
  count, and a call that makes it work again does.
- **No time limits.** Tasks have no timeout of their own. The session lifetime,
  `limits.sessionTimeoutMs` (30 days by default), bounds all work in a session. A body that needs a
  deadline races `sleep` against its work.

## Upgrade from background tasks

Tasks replace background tasks, `execution: "background"`, and `agentId` continuation. See
[Upgrade to Tasks](/docs/tools/tasks-upgrade) for every breaking change.
