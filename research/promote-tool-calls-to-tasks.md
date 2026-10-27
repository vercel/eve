---
issue: "None (follows #4300, which keeps slow bash commands running as sandbox jobs)"
status: draft
last_updated: "2026-10-05"
---

# Promote tool calls to tasks

## Summary

A tool chooses today, at definition time, whether its calls are tool calls or tasks. Some work
can't know in advance: a shell command, a test run, or an API job is usually fast and sometimes
takes twenty minutes. #4300 handled this for `bash` alone. A command still running after 30
seconds returns `status: "running"` with a pid and file paths, and the model polls and kills it
with later commands. Nothing owns that job afterwards, so `session.cancel()` leaves it running,
compaction loses its pid, and no client sees it.

This plan lets any tool start as an ordinary tool call and continue as a task when it runs long:

1. **`execute` runs inline, as today.** A call that returns settles as a normal tool result.
2. **A tool that also defines `continueTask(handoff, ctx)` can promote a call.** The tool decides
   what is slow. It races its work against whatever it wants, and returns
   `ctx.continueAsTask(handoff)` to continue as a task. The model gets a task receipt, and the
   `continueTask` body continues the work durably from `handoff`.
3. **Once promoted, a call is an ordinary task.** `task_cancel`, `session.cancel()`, held turns,
   `task.result`, the `[Tasks]` note, and `task.started` / `task.settled` all apply unchanged.
4. **A handoff is never dropped.** If the turn is cancelled while `execute` runs, or before the
   step that promoted the call commits, the task still starts, already cancelled, so cleanup
   lives in one place.
5. **eve is built on eve.** The provided `bash` tool uses only this public API. Its custom
   `running` result, pid instructions, and polling advice go away.

## Authoring API

```ts
import { setTimeout as sleep } from "node:timers/promises";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { startExport, waitForExport } from "../lib/exports";

export default defineTool({
  description: "Export a report.",
  inputSchema: z.object({ reportId: z.string() }),
  async execute({ reportId }, ctx) {
    const job = await startExport(reportId, { signal: ctx.abortSignal });
    const result = await Promise.race([job.result(), sleep(10_000)]);
    if (result !== undefined) return result;
    return ctx.continueAsTask({ jobId: job.id }, { progress: `Exported ${job.percent}% so far.` });
  },
  async continueTask({ jobId }, ctx) {
    "use workflow";
    return await waitForExport(jobId, ctx.abortSignal);
  },
});
```

- **`continueTask(handoff, ctx)`** is optional on `defineTool`. It is a workflow body, so it starts
  with `"use workflow"`, receives `WorkflowToolContext`, and follows every rule of a `task()` body
  on `defineWorkflowTool`. It isn't named `task` because `task` on `defineWorkflowTool` means every
  call is a task. Its return value is the call's result. It must match the tool's `outputSchema` and
  is projected by the same `toModelOutput`, so the model sees one output shape whether or not the
  call was promoted.
- **`ctx.continueAsTask(handoff, options?)`** returns the value `execute` must return to promote
  the call. `handoff` must be serializable; it is the `continueTask` body's first argument. Optional
  `progress` is model-visible text included in the receipt, such as why the call moved and its
  output so far. eve has no deadline of its own: when and why to promote is the tool's decision.
  Calling it in a tool without `continueTask` throws:

  ```text
  ctx.continueAsTask() requires a continueTask(handoff, ctx) body on tool "{toolName}".
  ```

- **Cancellation is handed off too.** When `ctx.abortSignal` aborts while `execute` holds work the
  `continueTask` body could stop, `execute` returns `ctx.continueAsTask(handoff)` instead of
  cleaning up itself. eve starts the task with its `abortSignal` already aborted, and the body's
  cleanup runs in steps after the cancel, the same path as a later `task_cancel`.
- **Steps in a `continueTask` body can reach the session sandbox.** `getSandbox()` on
  `WorkflowStepToolContext` attaches to the sandbox the session already uses, by reference, as a
  child session's sandbox does today. It never creates or replaces a sandbox, and throws when the
  session has none. `bash` needs this, and so does any workflow tool that works with files.

Dynamic tools from `defineDynamic` can't define `continueTask`, as they can't define workflow bodies
today. Workflow `execute` tools and MCP tools are out of scope (see [Follow-ups](#follow-ups)).

## Observable semantics

**Inline calls don't change.** A call whose `execute` returns a result produces the same events
and result as today, and nothing marks it as a possible task.

**Promotion.** The tool call settles with a receipt that eve renders. The receipt reuses the task
receipt wording and appends the tool's `progress`:

```text
Continues as task bash-4hd8sa. Its result will arrive in a <task_result> message.
Still running after 30 seconds. Output so far:
…
```

From then on the call is a `task()` task: one result, `task_wait`, `task_cancel`, the 32-task
limit, and a turn that can't end while it works. The task id is `<tool>-<6 characters>`. See
[Events](#events) for what the stream shows.

**Steering doesn't change.** A plain tool's `abortSignal` aborts only for cancellation: once a
tool starts, steering can't interrupt the model step, and the message reaches the model at the
next step boundary. A promotable call holds a steering message until `execute` returns a result
or a handoff, so the tool's own race bounds that delay.

**After promotion, task rules apply.** Steering never aborts a task. The model reads the steering
message with the task still working, and decides whether to keep it or stop it with
`task_cancel`. Only `task_cancel`, `session.cancel()`, a failed turn, and the end of the session
abort the `continueTask` body's `abortSignal`.

**Cancellation.**

| When the turn is cancelled                          | What happens to the work                                  |
| --------------------------------------------------- | --------------------------------------------------------- |
| `execute` is still running                          | `execute` hands off; the run starts aborted and cleans up |
| After promotion, in the same uncommitted model step | The run started already; eve cancels it as orphaned       |
| After the promoting step committed                  | An ordinary working task; `session.cancel()` cancels it   |

In the first two cases the session never adopts the run, so the call never becomes a task and
gets no task events. It ends with the cancelled turn, as any call does. Only the third case ends
in `task.settled`.

## Events

A promoted call emits exactly the events a `task()` tool's call emits today, in the same order.
The only addition is that `execute` can report progress before the handoff:

1. `actions.requested`, from the model step.
2. Any `action.partial` that `execute` yields before the handoff.
3. `task.started`, with `kind: "tool"` and the call's own `callId` and `turnId`.
4. The receipt, as the call's `action.result`.
5. The run's own events, such as `input.requested` from `ctx.ask`, each with the `taskId`.
6. `task.settled`, once.

| Case                                          | How the call's events end                                                    |
| --------------------------------------------- | ---------------------------------------------------------------------------- |
| Not promoted                                  | Unchanged: `action.result` with the output, and no task events               |
| Promoted, then finishes                       | `task.settled` with `status: "completed"` and the `output`                   |
| Promoted, then `task_cancel`                  | `task.settled` with `status: "cancelled"`, `cancel.reason: "task_cancel"`    |
| Promoted, step committed, then turn cancelled | `task.settled` with `cancel.reason: "turn_cancelled"`, then `turn.cancelled` |
| Turn cancelled before the step commits        | No steps 3 to 6: `turn.cancelled`, then `session.waiting`                    |

- The result reaches the model as a `task.result` message in history, not as a stream event.
  Clients read the outcome from `task.settled`.
- When the model ends its text while the task works, the stream emits `turn.waiting` with
  `on: "tasks"`, and the turn resumes with the next `step.started` for the same `turnId`.
- A run's events, such as `input.requested` from `ctx.ask` or `agent.started` from `ctx.agent`,
  carry the `taskId` and never come before the call's `task.started`.

## Runtime boundary

`research/eve-tasks.md` starts a task after the model step commits its record. A promoted call
can't wait for that: its work already exists, and a cancel can discard the step. So the tool call
starts the task's run itself, and the session adopts or cancels it.

```text
model step (tool call)            session                         task run
execute returns continueAsTask(h)
  start run keyed (session, callId) ─────────────────────────────▶ continueTask(h, ctx)
                     inbox: run started(callId) ─▶ held on record
step commits ──────▶ call committed? ─ yes ─▶ task.started, receipt action.result
                                      └ no ──▶ cancel ───────────▶ abortSignal aborts
```

- **Start once.** The run is keyed on the session and `callId`, so a retried step can't start a
  second run. It tells the session it started through the session inbox, as runs report
  `agent.started` today, and the inbox outlives a discarded step.
- **Adopt or cancel.** At the step boundary the session adopts a started run whose call the step
  committed: it records the task, publishes `task.started`, and then publishes the receipt as the
  call's `action.result`. It cancels a run whose call was discarded and publishes nothing for it,
  as `execution/tasks/table.ts` already settles nothing for a task that never reported
  `task.started`. A run that reports after the boundary is matched the same way.
- **Event order.** A plain tool's `action.result` is emitted inside the model step today
  (`harness/tool-loop.ts`), which would put the receipt before `task.started`. So the tool loop
  doesn't emit `action.result` for a call that returns `continueAsTask`. The call joins the
  step's coordination batch like a `task()` call, and its receipt is emitted after
  `task.started`, as `harness/coordination.ts` does for task calls. The session holds the run's
  events until it publishes `task.started`.
- **Handoffs after abort.** A cancelled turn step gives the `execute` calls it aborted a bounded
  window to return. A handoff returned in that window starts the run with `cancelled: true` in
  its start input, and the body sees an aborted `abortSignal`. A call that returns nothing in
  time keeps today's behavior.
- **Sandbox by reference.** The run's start input already carries the session's sandbox reference.
  Step attachment can resume a stopped sandbox but never writes the session's sandbox record. If
  resuming would produce a different sandbox, `getSandbox()` throws.
- **Model text** lives in `execution/tasks/render.ts`, as for every task receipt.

## The provided `bash` tool

`bash` keeps its fast path, its launcher, and its 30-second race, and moves the job's lifetime
into a `continueTask` body:

```ts
export default defineTool({
  description: "Execute a shell command in the shared workspace environment.",
  inputSchema: BASH_INPUT_SCHEMA,
  outputSchema: BASH_OUTPUT_SCHEMA, // { exitCode, stdout, stderr, truncated }
  async execute(input, ctx) {
    const job = await launch(await ctx.getSandbox(), input.command);
    const result = await job.resultWithin(30_000, ctx.abortSignal); // undefined if still running or aborted
    if (result !== undefined) return result;
    return ctx.continueAsTask(job.handoff, { progress: await job.progress() });
  },
  async continueTask(job, ctx) {
    "use workflow";
    return await watchJob(job, ctx.abortSignal); // durable waits on the exit file; kills the process group on abort
  },
});
```

- The `status: "running"` output variant and its `pid`, `outputDirectory`, and `message` fields
  are removed. `BASH_OUTPUT_SCHEMA` and `BashToolOutput` describe only the completed result. This
  is a breaking change to `eve/tools/bash`, released as `minor`.
- `kill -- -<pid>` instructions are replaced by `task_cancel`, and polling advice by
  `task.result`.
- A command the model backgrounds itself, such as `npm run dev &`, finishes the call at once and
  stays outside eve, as today. Long-lived servers should be started that way, because a promoted
  task holds the turn until it ends. The tool description says so.

## Tests

- **Integration:** a plain tool that returns `ctx.continueAsTask()` emits `task.started` before
  its receipt `action.result`, then `task.settled`, and the model gets a `task.result`. Inline
  calls emit nothing new. A cancel while the promoted call's parallel sibling still runs cancels
  the orphaned run, and a cancel during `execute` starts the run aborted; neither emits task
  events.
- **Scenario:** `bash` with a real shell promotes, reports the exit code as a task result, and
  `task_cancel` and `session.cancel()` each stop the whole process group.
- **E2E:** the sandbox fixture's `bash-background-job` eval asserts `task.started`, the task
  result, and that a cancelled turn leaves no process running.

## Open questions

- **Steering plain tools.** Steering aborts a workflow `execute` call's `abortSignal` but not a
  plain tool's, which surprises authors. Changing that is a separate decision for all plain
  tools. It would affect only the time before a handoff: a promoted call is a task either way.
- **Waiting in `bash`'s `continueTask` body.** The session never polls, but `watchJob` must wait on
  a file in the sandbox. The options are durable sleeps with backoff, which add steps over a long
  run, or one long step blocked on `sandbox.run`, which holds compute.

## Follow-ups

- **Workflow `execute` tools** can promote without a handoff: the run already exists, and the
  session only stops waiting on it.
- **MCP tools** have no durable handle to hand off. MCP's own task support could map onto this
  later.
- **Inline-first agent calls**, which wait briefly for a reply before returning a receipt, are the
  same idea in reverse.
