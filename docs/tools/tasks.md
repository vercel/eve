---
title: "Tasks"
description: "Run agent and workflow tool calls as tasks that keep working while the conversation continues, and control how the model waits for, corrects, and cancels them."
url: /tools/tasks
---

A task is a tool call that returns a receipt right away and keeps working while the conversation
continues. Every call to an agent is a task, and so is every call to a
[workflow tool](/docs/tools/workflows) that defines `task(input, ctx)` or `serve(receive, ctx)`.
The result reaches the model later, in a `task.result` message. A turn can't end while tasks are
still working.

## Choose how a call runs

A workflow tool defines exactly one entry point, which decides whether the conversation continues
while the call works:

```ts
defineWorkflowTool({ /* … */ async execute(input, ctx) {} }); // the turn waits until the call finishes
defineWorkflowTool({ /* … */ async task(input, ctx) {} }); // a task: a receipt now, the result later
defineWorkflowTool({ /* … */ async serve(receive, ctx) {} }); // a task that accepts more calls
```

Defining none of the three, or more than one, throws when the tool is defined.

| Call                                                                    | Runs as                   | Result                                            | A new message during the call     |
| ----------------------------------------------------------------------- | ------------------------- | ------------------------------------------------- | --------------------------------- |
| `execute` workflow tool, including `sleep` and `ask_question`           | Tool call; the turn waits | The tool result                                   | Aborts the call's `abortSignal`   |
| `task` workflow tool, including `agentRouter()` and the `workflow` tool | Task                      | A receipt, then a `task.result` message           | Nothing                           |
| `serve` workflow tool, including every agent tool                       | Resumable task            | A receipt, then a `task.result` message per reply | Nothing                           |
| `eve__task_wait`                                                        | Wait inside the turn      | Which tasks finished                              | Ends the wait                     |
| Plain and MCP tools                                                     | Inside the model step     | The tool result                                   | Applied at the next step boundary |

Waiting alone doesn't need a task. A question, a `sleep`, or an approval inside an `execute` call
pauses the turn without holding compute, even across restarts. A new message stops the wait.
Use a task when the model should keep talking while the work runs, such as during a twenty-minute
deploy. A task also suits research the model may not need right away, or a question that should
stay open through new messages.

Every agent tool is a `serve` tool, so every agent call is a resumable task. The model decides from
the conversation whether it needs an agent's answer now. The
[turn rule](#turns-wait-for-their-tasks) guarantees the answer reaches the model before the turn
ends.

See [Run calls as tasks](/docs/tools/workflows#run-calls-as-tasks-task) for writing a `task` body
and [Resumable tasks](/docs/tools/workflows#resumable-tasks-serve) for `serve` bodies,
`receive()`, and `ctx.reply()`.

## Order work that depends on a result

Because agent calls are tasks, the model decides when to wait for them. An instruction such as
"publish only after the review approves" holds only as long as the model follows it. When an order
must always hold, write a workflow tool that runs the first step through
[`ctx.agent`](/docs/tools/workflows#delegate-work-ctxagent) and then acts. Don't expose the side
effect as a separate tool:

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
subagent if the model shouldn't call it directly. Define `task` in place of `execute` if the
conversation should continue while the review runs.

## Pass signals to the work

A workflow tool body receives its signals from its context or, in a `serve` body, from each call
`receive()` resolves:

- **`abortSignal`** aborts when the call's work should stop. `eve__task_cancel`, `session.cancel()`,
  `session.clear()`, a cancelled or failed turn, and the end of the session abort it. For an `execute` call, so does a
  steering message that arrives while the turn waits on it. `execute` and `task` bodies read it as
  `ctx.abortSignal`. In a `serve` body, each call from `receive()` carries its own `abortSignal`.
  Calls in one stretch of work share one signal, and the next stretch gets a new one. Pass the
  signal to the steps and `ctx.agent` sends that should stop.
- **`ctx.ask(request)`** withdraws the question when the call's `abortSignal` aborts.
  `ctx.ask(request, { signal })` also withdraws it when `signal` aborts. In a `serve` body,
  `ctx.reply()` withdraws the open questions of the calls it answers. A withdrawn question resolves
  as `{ status: "cancelled" }`, and the stream reports `interaction.settled` with
  `outcome: "withdrawn"` so channels stop offering it. A person's answer that reached the session
  first still wins, so branch on `status`, not on the signal.

After a steering message, the call ends with what the body returns. See
[Stop early for a new message](/docs/tools/workflows#stop-early-for-a-new-message). A
question in an `execute` call lapses once the conversation moves on, as `ask_question`'s does. A
question in a task stays open:

```ts
async execute({ service }, ctx) {
  "use workflow";
  const answer = await ctx.ask({
    prompt: `Deploy ${service} now?`,
    display: "confirmation",
    options: DEPLOY_OR_WAIT,
  });
  if (answer.status === "cancelled") return { deployed: false, reason: "the conversation moved on" };
  // …
}
```

The provided `sleep` tool races its timer against the signal; see the example in
[Stop early for a new message](/docs/tools/workflows#stop-early-for-a-new-message).

## What the model sees

When the agent has an agent tool or a `task` or `serve` workflow tool, eve adds `eve__task_wait`
and `eve__task_cancel`. It also adds a short system prompt block about tasks, which depends on who
reads the session:

- **Root sessions:** a person reads each reply. The block tells the model to call `eve__task_wait`
  when it has nothing to say until a result arrives. It tells the model to reply now when the person
  should hear from it, such as to confirm that work is underway.
- **Child sessions and a schedule's sessions:** only the turn's final reply reaches the caller. The
  block tells the model to call `eve__task_wait` instead of replying while tasks work. Text the
  model writes while its turn holds for tasks is narration (`content.completed` with
  `phase: "narration"`). Clients that render the stream show it, and channels don't post it.

**Receipts.** A task call returns a receipt with a `taskId`; call a resumable task again with that ID.

**Results.** Each result arrives once, as a `<task_result>` block in a `task.result` message. eve
adds the message before the model's next step, right after `eve__task_wait` returns, or when a held
turn resumes. The body is the output as shaped by the tool's `toModelOutput`, or the error message
for a failed call. All results in one message share a budget of 50 KB and 2,000 lines. Text past
the budget is cut and marked `[truncated]`.

```text
<task_result id="deploy-4hd8sa" tool="deploy" status="completed">{"url":"https://…"}</task_result>
```

**`eve__task_wait({ timeoutSeconds? })`** controls when the model replies. The model calls it only
to withhold a message from the user while waiting for a result. Tasks keep running, and their
results reach the model without it.

The call pauses the turn until any task has a result, a new message arrives, or `timeoutSeconds`
(a whole number of at least 1) pass. It returns at once when a result is already waiting, and it
never stops a task. The model reads which tasks finished and which are still working:

```text
deploy-4hd8sa completed; its result follows. 1 task is still working: researcher-7k2m9q.
```

**`eve__task_cancel({ taskId })`** stops a task's current work and says so. The task stops
reporting immediately. A cancelled agent task ends, so start a new one to delegate again. Ending a
local child is best effort: a failure is logged, and the child may keep running. Other resumable
tasks stay available, and the answer tells the model how to give them new work. When a task already finished or is idle, `eve__task_cancel` says it had no work to stop:

```text
Stopped deploy-4hd8sa; it won't report back.
Stopped researcher-7k2m9q; it won't report back.
researcher-7k2m9q had no work to stop.
```

**`[Tasks]` note.** Before the model's next step, eve tells the model which tasks are working. The
note then lists the 10 most recently used idle resumable tasks, so the model can find them again.
The note returns after [compaction](/docs/concepts/default-harness#compaction).

**Errors.** Two error codes are specific to tasks:

| Code             | When                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------- |
| `UNKNOWN_TASK`   | A call's `taskId` names no unfinished resumable task that the same tool started         |
| `UNKNOWN_TASK`   | `eve__task_cancel`'s `taskId` names no task; a finished or idle one has no work to stop |
| `TOO_MANY_TASKS` | A call would start a task, or make an idle one work, while 32 tasks are working         |

An `eve__reply` call made while tasks are working returns an error that names them.

## Turns wait for their tasks

No turn ends while any task is working. When the model ends a turn early, eve waits as
`eve__task_wait` does. The turn waits until a task finishes or the turn's own caller steers it. eve
then adds the results and calls the model again in the same turn. No result ever starts a turn on
its own. An idle resumable task doesn't hold the turn.

A held turn keeps running while it waits on its tasks, and pauses only for questions and sign-ins. The next
`model.requested` for the same `turnId` means the turn took its results, and `turn.settled` comes
only when the turn ends. The model's text before the wait depends on the session:

- **Root sessions:** the text completes as an ordinary reply part (`phase: "reply"`), including text
  written before `eve__task_wait` in the same step. The person can keep writing, and the turn resumes
  under the same id.
- **Child sessions and a schedule's sessions:** the held text completes as `phase: "narration"`, so
  channels post only the final reply.

A question or sign-in from a task, such as an agent's question, pauses the turn on that request.
The stream emits `interaction.opened`, then `turn.paused` awaiting it. The turn continues once the
question is answered or sign-in completes.

`send(...).result()` waits through task work for the final reply, but stops at a question or sign-in
with `status: "awaiting-input"`. Answer through `respond()`; see
[Aggregate a turn](/docs/guides/client/streaming#aggregate-a-turn).
[Slack](/docs/channels/slack#task-card) also shows task activity.

A steering message from the turn's own caller, sent with `turnPolicy: "steer"` (the default),
ends an `eve__task_wait`. It also aborts the `abortSignal` of any `execute` call the turn waits on,
but it never interrupts a task. The model reads the message and decides what to do with each task.
It can keep the task, correct an agent by calling it again with its `taskId`, or stop the task with
`eve__task_cancel`. A `"queue"` message, or a message from another caller, waits for the turn to
end.

## Cancel a task

- **`eve__task_cancel`** stops one task's current work.
- **`session.cancel()`** cancels the turn, the `execute` calls it waits on, and every working task
  in the session.
- **`session.clear()`** cancels the running turn and every working task in the session, then clears
  history.
- **A failed turn** cancels every working task.
- **The end of the session** ends every task.

Cancelled agent and one-shot tasks end immediately. A `serve` task stays available if its body
catches the abort and returns to `receive()` within 30 seconds; otherwise it ends. Usage from
cancelled work still counts toward session limits.

## Stream events

| Event          | When                                                                     | Data                                                      |
| -------------- | ------------------------------------------------------------------------ | --------------------------------------------------------- |
| `task.started` | A call starts a task                                                     | `taskId`, `name`, `kind`, and `startedBy: { callId }`     |
| `call.started` | A call reaches its task, including a later call to a resumable task      | `callId` and `taskId`                                     |
| `call.settled` | A reply, return, failure, or cancel ends one call                        | `callId`, `outcome`, and `output`, `outputOf`, or `error` |
| `task.ended`   | The task ends; agent and one-shot tasks end immediately on cancellation  | `taskId`, `outcome`, and `reason` or `error`              |
| `child.opened` | A workflow run, including an agent tool's, opens a session with an agent | `sessionId`, `name`, `stream`, and `owner`                |

`task.started` and `task.ended` come once per task. Each call the task serves has its own
`call.started` and `call.settled`. Both belong to that call's turn, which can be a later turn for a
resumable task's later call. `kind` is `"agent"` for an agent tool's task and `"tool"`
otherwise.

A call's `outcome` is `"completed"`, `"failed"`, or `"interrupted"` when the call was cancelled. A
completed call carries `output`, or `outputOf` naming the earlier call whose output it shares; a
failed call carries `error`. A task ends `"cancelled"` with a `reason`, or `"failed"` with an
`error` when its run failed.

A `child.opened` event's `owner` is the call when an agent tool's call opened the session. It is the
task when a task's run opened the session with `ctx.agent`. An `interaction.opened` from a task's
run names the task in its `scope`. Results reach the model as a message in its history, not as a
stream event, so read outcomes from `call.settled`. Hooks subscribe to the same events.

The stream carries the model's `eve__task_wait` and `eve__task_cancel` calls as ordinary
`call.requested` tool calls, so evals can assert on them. The `eve dev` terminal UI, channel
activity such as Slack's status line, and ACP clients leave those calls out. The terminal UI shows
each task's start and end instead. See
[Sessions, runs, and streaming](/docs/concepts/sessions-runs-and-streaming#task-facts) and
[Follow a subagent](/docs/guides/client/streaming#follow-a-subagent).

## Ownership and limits

- **Ownership.** Tasks belong to the session's open turn, not to the caller that started them. A
  session has at most one open turn, so `eve__task_wait`, `eve__task_cancel`, task results, and the
  `[Tasks]` note cover every task in the session. Any later turn can continue an idle resumable task
  by its `taskId`, and that call runs with its own caller's auth. Only the turn's own caller steers
  it; anonymous callers share one identity. eve doesn't check which caller started a task. In a session with several people, such as a
  shared Slack thread, the model working for one person can continue or `eve__task_cancel` another
  person's task. A continued `serve` task keeps the state its body built for earlier calls.
  [Key per-caller data on the caller's identity](/docs/tools/workflows#resumable-tasks-serve) and enforce
  per-person access inside the tool.
- **Working tasks.** A session runs at most 32 working tasks at once. An idle resumable task doesn't
  count, and a call that makes it work again does.
- **No time limits.** Tasks have no timeout of their own, and the session timeout does not bound
  them. A turn held open while its tasks work keeps the session open, and
  `limits.sessionTimeoutMs` (30 idle days by default) counts from when that turn ends. A body
  that needs a deadline races `sleep` against its work.
