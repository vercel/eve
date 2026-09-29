---
title: "Tasks"
description: "Run agent and workflow tool calls as tasks that keep working while the conversation continues, and control how the model waits for, corrects, and cancels them."
url: /tools/tasks
---

A task is a tool call that returns a receipt right away and keeps working while the conversation
continues. Every call to an agent is a task, and so is every call to a
[workflow tool](/docs/tools/workflows) that defines `task(input, ctx)` or `serve(receive, ctx)`.
A task's result reaches the model later, in a `task.result` message, and a turn can't end while
tasks are still working.

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

| Call                                                                    | Runs as                   | Result                                            | A new message during the call     |
| ----------------------------------------------------------------------- | ------------------------- | ------------------------------------------------- | --------------------------------- |
| `execute` workflow tool, including `sleep` and `ask_question`           | Tool call; the turn waits | The tool result                                   | Aborts the call's `abortSignal`   |
| `task` workflow tool, including `agentRouter()` and the `workflow` tool | Task                      | A receipt, then a `task.result` message           | Nothing                           |
| `serve` workflow tool, including every agent tool                       | Resumable task            | A receipt, then a `task.result` message per reply | Nothing                           |
| `task_wait`                                                             | Wait inside the turn      | Which tasks settled                               | Ends the wait                     |
| Plain and MCP tools                                                     | Inside the model step     | The tool result                                   | Applied at the next step boundary |

Waiting alone doesn't need a task. A question, a `sleep`, or an approval inside an `execute` call
parks the turn durably and holds no compute, and a new message stops the wait. Use a task when the
model should keep talking while the work runs, such as a twenty-minute deploy or research the model
may not need right away, or when a question should stay open through new messages. A long
`execute` tool holds the conversation until it settles or a new message stops it.

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

- **`abortSignal`** aborts when the call's work should stop: by `task_cancel`, `session.cancel()`,
  a cancelled or failed turn, or the end of the session, and, for an `execute` call, by a steering
  message that arrives while the turn waits on it. `execute` and `task` bodies read it as
  `ctx.abortSignal`. In a `serve` body, each call from `receive()` carries its own `abortSignal`;
  every call in one stretch of work shares one signal, and the next stretch gets a new one. Pass it
  to the steps and `ctx.agent` sends that should stop.
- **`ctx.ask(request)`** withdraws the question when the call's `abortSignal` aborts, and
  `ctx.ask(request, { signal })` also when `signal` does. In a `serve` body, `ctx.reply()` also
  withdraws the questions still pending for the calls it settles. The answer resolves as
  `{ status: "cancelled" }`, and the stream reports `input.resolved` with `outcome: "cancelled"` so
  channels stop offering the question. A person's answer that reached the session first still wins:
  the ask resolves as `answered`, so branch on `status`, not on the signal.

A body doesn't need to tell a steering message from a cancel: in both cases, stop and return what
you have. After a steering message the call settles with what the body returns, or with
`{ interrupted: true }` if the body rejects, and the model reads the message next. After a cancel,
eve discards the result. So a question in an `execute` call lapses once the conversation moves on,
as the provided `ask_question` tool's does, while a question in a task stays open:

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

See [Stop early for a new message](/docs/tools/workflows#stop-early-for-a-new-message) for how the
provided `sleep` tool races its timer against the signal.

## What the model sees

eve adds `task_wait`, `task_cancel`, and a short system prompt block that explains tasks whenever
the agent has an agent tool or a `task` or `serve` workflow tool. The block tells the model to call
`task_wait` when it has nothing to say until a result arrives, and to reply when the person should
hear from it first, such as a confirmation that work is underway. In a child session or a
schedule's session, where only the final reply reaches the caller, it tells the model to call
`task_wait` instead of replying while tasks work.

**Receipts.** A call that starts a task returns a receipt as its tool result. Task ids are the tool
name and six characters. A resumable task's receipt tells the model how to reach it again, and a
call that reaches it by `taskId` returns a short receipt of its own:

```text
Started task deploy-4hd8sa. Its result will arrive in a <task_result> message.
Started task researcher-7k2m9q. Its result will arrive in a <task_result> message. To send it another message, call researcher again with taskId researcher-7k2m9q.
Sent to task researcher-7k2m9q. Its reply will arrive in a <task_result> message.
```

**Results.** Each result arrives once, as a `<task_result>` block in a `task.result` message that
eve appends at the next step boundary, right after `task_wait` returns, or when a held turn
resumes. The body is the tool's `toModelOutput` projection of the output, or the error message for
a failed call. All results in one message share a budget of 50 KB and 2,000 lines, after which the
text is cut and marked `[truncated]`.

```text
<task_result id="deploy-4hd8sa" tool="deploy" status="completed">{"url":"https://…"}</task_result>
```

**`task_wait({ timeoutSeconds? })`** parks the turn until any task has a result, a new message
arrives, or `timeoutSeconds` pass. `timeoutSeconds` is a whole number of at least 1, in seconds
like `sleep`. It returns at once when a result is already waiting. Waiting never stops a task. The
model reads which tasks settled and which are still working, for example:

```text
deploy-4hd8sa completed; its result follows. 1 task is still working: researcher-7k2m9q.
```

**`task_cancel({ taskId })`** stops a task's current work and says so. A resumable task's answer
also tells the model how to give it new work. When the task has no work to stop, because it already
finished or is an idle resumable task, `task_cancel` says that instead:

```text
Stopped deploy-4hd8sa; it won't report back.
Stopped researcher-7k2m9q's current work; it won't report back. To give it new work, call researcher again with taskId researcher-7k2m9q.
researcher-7k2m9q had no work to stop.
```

**`[Tasks]` note.** When the session's tasks change, eve adds a note at the next step boundary that
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

| Code             | When                                                                               |
| ---------------- | ---------------------------------------------------------------------------------- |
| `UNKNOWN_TASK`   | A call's `taskId` names no unfinished resumable task that the same tool started    |
| `UNKNOWN_TASK`   | `task_cancel`'s `taskId` names no task; a finished or idle one has no work to stop |
| `TOO_MANY_TASKS` | A call would start a task, or make an idle one work, while 32 tasks are working    |

A `final_output` call made while tasks are working returns an error that names them.

## Turns wait for their tasks

No turn ends while any task is working. When the model ends a turn early, eve waits as
`task_wait` does: it parks until one of the tasks settles or the turn's own caller steers it,
appends the results, and calls the model again in the same turn. No result ever starts a turn on
its own. An idle resumable task isn't working, so it doesn't hold the turn.

A held turn stays open. Each time it parks, when eve holds it or when `task_wait` has no result
yet, the stream emits `turn.waiting` with the turn's `turnId`. The next `step.started` for the
same `turnId` means the turn resumed, and `session.waiting` comes only after the turn ends. The
model's text before the wait depends on the session:

- **Root sessions:** the text completes as an ordinary message. The person can keep writing, and
  the turn resumes under the same id.
- **Child sessions and a schedule's sessions:** the held text step reports
  `finishReason: "tool-calls"` on `message.completed`, so channels post only the final reply.

A question or sign-in from a task, such as an agent's question, parks the turn the same way: the
stream emits `input.requested` or `authorization.required`, then `turn.waiting`, and the turn
continues once the person answers or signs in.

In every session, `turn.completed` comes only when the turn really ends. The TypeScript client's
`send(...).result()` and the MCP channel's `agent_get` read past `turn.waiting` and report the
final reply rather than the text written before the wait. `result()` stops at `turn.waiting` only
while a question is pending, and returns `status: "waiting"` with it; `respond()` then reads the
same turn to its end. See [Aggregate a turn](/docs/guides/client/streaming#aggregate-a-turn).
Channels such as [Slack](/docs/channels/slack) post a root session's text before the wait as an
ordinary reply, then post the reply after the results as another message.

A steering message from the turn's own caller, one sent with `turnPolicy: "steer"`, the default,
ends a `task_wait` and aborts the `abortSignal` of any `execute` call the turn waits on, but it
never interrupts a task. The model reads the message and decides whether to keep each task,
correct an agent by calling it again with its `taskId`, or stop a task with `task_cancel`. A
`"queue"` message, or a message from another caller, waits for the turn to end.

## Cancel a task

- **`task_cancel`** stops one task's current work.
- **`session.cancel()`** cancels the turn, the `execute` calls it waits on, and every working task
  in the session.
- **A failed turn** cancels every working task.
- **The end of the session** ends every task.

Cancelled work never reports back. A `task` tool's task is then finished; its run waits up to 30
seconds for the body to finish unwinding, then ends as cancelled. A `serve` tool's task stays
available instead: its waiting calls settle as `cancelled`, the stretch's `abortSignal` aborts, and
the task becomes idle, as long as the body catches that abort and returns to `receive()`. For an
agent, that cancels the agent's current turn and keeps its conversation, so a later call with the
same `taskId` continues where it left off. A `serve` body that doesn't return to `receive()` within
30 seconds of a cancel ends, and the task finishes.

## Stream events

| Event           | When                                                                     | Data                                                                             |
| --------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `task.started`  | A call starts a task, or reaches a resumable task by its `taskId`        | `taskId`, `callId`, `turnId`, the tool `name`, and `kind`                        |
| `task.settled`  | A reply, return, failure, or cancel settles one call                     | `taskId`, `callId`, `turnId`, `status`, and `output` or `error` unless cancelled |
| `agent.started` | A workflow run, including an agent tool's, opens a session with an agent | `callId`, `turnId`, `taskId`, `name`, `sessionId`, `streamPath`                  |
| `turn.waiting`  | An open turn parks on its tasks, a `task_wait`, a question, or a sign-in | `turnId` and `sequence`                                                          |

`task.started` and `task.settled` come once each per call, and `(taskId, callId)` identifies the
call. Both carry that call's `turnId`, which for a resumable task's later call can be a later turn
than the one that started the task. `kind` is `"agent"` for an agent tool's call and `"tool"`
otherwise. `status` is `"completed"`, `"failed"`, or `"cancelled"`. A completed call carries
`output`, a failed call carries `error`, and a cancelled call carries neither.
`agent.started` names the call and turn whose run opened the session, and its `taskId` is absent
when an `execute` call opened it. Results reach the model as a message in its history, not as a
stream event, so read outcomes from `task.settled`. An `input.requested`,
`authorization.required`, or `authorization.completed` event from a task's run carries its
`taskId`. Hooks subscribe to the same events. The stream also carries the model's `task_wait` and
`task_cancel` calls as ordinary `actions.requested` tool calls, so evals can assert on them. The
`eve dev` terminal UI and Slack typing indicators leave those calls out; the terminal UI shows each
task's start and end instead. See
[Sessions, runs, and streaming](/docs/concepts/sessions-runs-and-streaming#task-events) and
[Follow a subagent](/docs/guides/client/streaming#follow-a-subagent).

## Ownership and limits

- **Ownership.** Tasks belong to the session's open turn, not to the caller that started them. A
  session has at most one open turn, so `task_wait`, `task_cancel`, task results, and the `[Tasks]`
  note cover every task in the session. Any later turn can continue an idle resumable task by its
  `taskId`, and that call runs with its own caller's auth. Only the turn's own caller steers it;
  anonymous callers share one identity.
- **Callers share tasks.** eve doesn't check which caller started a task. In a session with several people,
  such as a shared Slack thread, the model working for one person can continue or `task_cancel` a
  task another person started. A continued `serve` task keeps the state its body built for earlier
  calls, so [key per-caller data on the current call's auth](/docs/tools/workflows#resumable-tasks-serve).
  Enforce per-person access inside the tool, as for any tool.
- **Working tasks.** A session runs at most 32 working tasks at once. An idle resumable task doesn't
  count, and a call that makes it work again does.
- **No time limits.** Tasks have no timeout of their own. The session lifetime,
  `limits.sessionTimeoutMs` (30 days by default), bounds all work in a session. A body that needs a
  deadline races `sleep` against its work.

## Upgrade from background tasks

Tasks replace background tasks, `execution: "background"`, and `agentId` continuation. See
[Upgrade to Tasks](/docs/tools/tasks-upgrade) for every breaking change.
