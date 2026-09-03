---
issue: TBD
status: draft
last_updated: 2026-09-03
---

# Tools: suspendability and lifetime as two explicit axes

## 1. Summary

An authored tool has two independent properties that eve currently encodes as
two unrelated flags and re-derives with `if` chains at every consumer:

- **Suspendability** — can the body park without holding compute? Today this
  is implied by the `"use workflow"` directive and surfaces as
  `handling.kind === "workflow-tool"` on `CompiledToolBehavior`.
- **Lifetime** — does the call end with the harness step, or does it outlive
  it as a durable task? Today this is `execution: "background"`.

This document makes both axes explicit in the compiled tool shape and gives
each of the four resulting cells a distinct `execute` contract, without
changing the authoring surface: `execution: "background"` and the third `task`
argument stay as they are and lower onto the new model. One addition,
`task.update(data, { wake })`, is a pure descriptor a body can `yield`; the
existing `task.delegated` and `task.send` are re-implemented on top of the same
task command. Author-supplied task data becomes durable, model-visible state on
the task view rather than a one-shot tool result.

Motivating case: [vercel/internal-agents#2173](https://github.com/vercel/internal-agents/pull/2173)
runs Devbox as a background tool and had to build a relay workflow, a webhook
route, and a `session.completed` adapter because a background `execute()`
cannot park on an external webhook, and a background workflow tool cannot put
author data in its receipt.

## 2. The four cells

|                       | `lifetime: "step"`                                                                | `lifetime: "task"`                                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `suspend: "none"`     | Ordinary tool. Runs inside the step; generator yields stream as `action.partial`. | Task tool. Task created; body runs inside the step and must return or `delegated()`; `task.update()` annotates the task before completion. |
| `suspend: "workflow"` | Waiting durable tool. Turn parks on the run; return value is the tool result.     | Background durable tool. Model gets a receipt; run outlives the step; `yield` updates the task and may wake the parent.                    |

Every cell exists today. What changes is that the pair is data the compiler
writes once and consumers switch on, and that the same `task` capability means
the same thing in both task cells, instead of `delegated()`/`send` in one and
nothing in the other.

```
                suspend: none                suspend: workflow
              ┌──────────────────────┐    ┌──────────────────────────┐
lifetime:step │ execute() in step    │    │ run; turn parks on it    │
              └──────────────────────┘    └──────────────────────────┘
              ┌──────────────────────┐    ┌──────────────────────────┐
lifetime:task │ execute() in step,   │    │ run; receipt to model;   │
              │ return completes     │    │ yield → task.update      │
              └──────────────────────┘    └──────────────────────────┘
```

## 3. Authoring API

### 3.1 Declaring the axes

The authoring surface is unchanged. `execution: "background"` selects
`lifetime: "task"`; its absence selects `lifetime: "step"`. Suspendability is
not declared: the compiler reads the `"use workflow"` directive from the body,
as it does today. The two never collapse into one enum
(`"background-workflow"` is rejected).

```ts
export default defineTool({
  execution: "background",
  inputSchema,
  async *execute(input, ctx, task) {
    "use workflow";
    // …
  },
});
```

The only new thing is that a background tool whose body is a workflow now
receives the third `task` argument too. Today it is silently absent there.

### 3.2 `task.update`

`TaskExec` gains one method. It returns a pure descriptor and performs no I/O,
so it is replay-safe inside a workflow body.

```ts
interface TaskExec {
  // existing: batch, binding, session, task, delegated(), send()
  update(data: JsonObject, options?: { wake?: boolean }): TaskUpdate;
}
```

`TaskUpdate` is a tagged JSON object. Yielding an untagged value in a
background body is sugar for `task.update(value)`.

The existing members lower onto the same primitive (§4.2):

- `task.delegated({ executor, receipt })` — unchanged signature. The
  `receipt` is written as the task's first `update` (so it lands on
  `view.data`, not only in the tool result) and the `executor` is written as
  the `bind` it is today.
- `task.send({ kind: "update", message })` — becomes
  `update({ message }, { wake: true })`. Its restart-safety caveat stands; the
  durable path is `yield` from a workflow body.
- `task.send({ kind: "complete" | "fail" | "cancel" })` — unchanged.

### 3.3 Per-cell `execute` contract

- **`step` / `none`** — `execute(input, ctx)`. Unchanged.
- **`step` / `workflow`** — `execute(input, ctx)` with `"use workflow"`.
  Unchanged. `yield` remains `action.partial`; no `task` argument.
- **`task` / `workflow`** — `execute(input, ctx, task)` with
  `"use workflow"`. Each `yield` is a task update (§4). The first update
  observed by the launching turn is merged into the receipt. `return`
  completes the task; `throw` fails it; `ctx.abortSignal` is the cancel path.
  `task.delegated()` and `task.send()` are not callable here: a workflow body
  is its own executor, and the run already owns the durable report path.
- **`task` / `none`** — `execute(input, ctx, task)`. Unchanged contract; the
  body may additionally `yield task.update(...)` before returning. `return`
  completes; `task.delegated()` hands off to an external executor as today.

`defineTool` overloads keep the wrong capability unreachable: `task` is absent
on a `lifetime: "step"` call, and `delegated`/`send` are absent from the
`TaskExec` a workflow body receives.

### 3.4 Example: Devbox as a background durable tool

```ts
export default defineTool({
  execution: "background",
  inputSchema: devboxInputSchema,
  async *execute(input, ctx, task) {
    "use workflow";

    const done = createWebhook();
    const run = await startOrContinueDevbox({ input, callbackUrl: done.url, callId: ctx.callId });
    yield task.update({ devboxTaskId: run.taskId, taskUrl: run.taskUrl }); // receipt

    try {
      const event = await (await done).json();
      if (event.state === "attention-required") {
        return { state: "attention-required", devboxTaskId: run.taskId, taskUrl: run.taskUrl };
      }
      if (event.state === "errored") throw new FatalError(`Devbox task ${run.taskId} failed`);
      return await readDevboxResult(run.taskId);
    } finally {
      if (ctx.abortSignal.aborted) await stopDevbox(run.taskId);
    }
  },
});
```

`startOrContinueDevbox`, `readDevboxResult`, and `stopDevbox` are
`"use step"` functions. The relay workflow, relay route, and subagent-protocol
adapter from the PR are deleted.

## 4. Task data and the `update` command

### 4.1 Task view

`TaskView` gains an author-owned, model-visible field:

```ts
readonly data?: JsonObject;
```

It is present on `working` and `input_required` views and retained unchanged
on terminal views. It is included in model-visible task JSON, in the
`[Task state]` cohort projection, and in `task_status`/TUI rendering. It never
carries routing credentials; those stay on the private `executor` binding.

### 4.2 Command

The task run accepts one new command through its existing single-writer inbox:

```ts
{
  kind: "update";
  data: JsonObject;
  wake: boolean;
}
```

Semantics:

- Accepted only while the view is `working` or `input_required`; rejected
  (not failed) on a terminal view.
- `data` **replaces** `view.data`. Last-write-wins, the same rule the docs
  already state for generator snapshots. No merge.
- `wake: true` delivers the parent the existing
  `Background task <id> (<name>) update: <json>` message under the existing
  pending-cohort policy. `wake: false` stores only.
- Idempotency comes from the existing hook cursor plus the run's
  `(epoch, index, callId)` delivery id. Replayed reports are no-ops.

### 4.3 Wiring

- **Workflow run → task.** `runBody` already sends each yield as a
  `RunReport` through `resumeHookStep(owner.report)`. The owner
  (`runReportToTaskUpdate`) maps a `TaskUpdate` descriptor to the `update`
  command; an untagged value maps to `{ data: value, wake: true }`.
- **Receipt.** `createWorkflowToolBackgroundExecute` waits on the owner's
  report channel for the first report, raced against the run's outcome so a
  body that returns or throws before yielding still settles the call. The
  receipt is `{ status: "working", taskId, ...data }`. A body that never
  yields keeps `{ status: "working", taskId }`.
- **Step-lifetime task tool.** The `"Background tools cannot return
AsyncIterable"` guard is removed; the executor iterates the body, sends each
  update, and completes with the return value (or binds the executor when the
  return is `delegated()`). All updates precede completion by construction.
- **`delegated()` receipt.** `BackgroundToolExecutionScope` sends
  `{ kind: "update", data: receipt, wake: false }` before `bind`, so the
  receipt data the model already sees is also on `view.data` for later turns.
- **Waiting workflow tool.** Unchanged: yields stream as `action.partial`. A
  `TaskUpdate` descriptor cannot be constructed there because there is no
  `task` argument.

## 5. Compiled shape

`CompiledToolBehavior` carries the pair as data:

```ts
readonly shape: {
  readonly lifetime: "step" | "task";
  readonly suspend: "none" | "workflow";
};
```

`handling.kind === "workflow-tool"` collapses into `suspend: "workflow"` plus
its `workflowId`. Consumers that currently re-derive the combination switch on
`shape` instead:

- `prepareToolBehavior` (`runtime/tools/registry.ts`)
- the background-call filter in `harness/tool-loop.ts`
- `dispatchTaskStep`'s `entry.kind === "workflow-tool"` branch
- `createWorkflowToolBackgroundExecute` / `BackgroundToolExecutionScope`

## 6. What is kept, what is narrowed

Nothing is removed from `defineTool` or `TaskExec`. Two members are narrowed
by cell:

- `task.delegated()` and `task.send()` are absent from the `TaskExec` passed to
  a workflow body (`task` / `workflow`). A workflow body is its own durable
  executor; `return`/`throw`/`yield` are the complete surface.
- `task.send({ kind: "update" })` in a step body keeps its documented
  restart-safety caveat and now lowers onto the same `update` command as
  `yield`. It is not deprecated; it is the escape hatch for in-process
  executors that are not workflows.

The internal-agents Devbox bridge keeps working unchanged on this design; §3.4
is the version that no longer needs the relay, not a forced migration.

## 7. Cancellation

Unchanged in mechanism, but two behaviours become load-bearing for a workflow
body, which has no executor binding of its own to hang a cancel handler on:

- `task_cancel` on a background workflow tool aborts `ctx.abortSignal` in the
  run and waits the existing grace period.
- A body parked on a hook or webhook does not observe the signal today and is
  abandoned after the grace period without running `finally`. The tool-run
  should race the parked await against its control inbox so `finally` runs
  before the run ends. Without this, external cleanup (`stopDevbox` above) has
  no home and authors reach for a second tool. This is the one `execution/`
  change beyond wiring and is required for the migration to be complete.

## 8. Invariants

- A tool's cell is fixed at compile time and visible in the manifest.
- The `task` argument exists iff `execution === "background"`.
- `wake` is only meaningful when the body is a workflow; a step body's
  `update` before `return` never wakes anyone (there is no gap to wake into).
- `view.data` is written only by `update` commands — from `yield`,
  `task.update`, `task.send({ kind: "update" })`, or a `delegated()` receipt —
  never derived from the tool result or the executor binding.
- The task run remains the single writer of task lifecycle and `data`.
- A receipt is observed by the launching turn exactly once; later updates
  arrive as session input, never as a tool result.
- Existing `delegated()`/`send` callers observe identical model-visible
  behaviour; the only new observable is `view.data`.

## 9. Open decisions

- Whether `task.update` should also be importable from `eve/tools` as a
  standalone descriptor constructor (matches `ask` from `eve/workflow`), or
  stay on `task` for type gating only. Leaning `task` only.
- Whether `wake` defaults to `true` (matches today's generator-in-background
  behaviour) or `false` (cheaper; no silent turn). Leaning `true` for
  continuity, revisit with usage.
- Whether `task.send({ kind: "update" })` should be deprecated once `yield`
  covers every in-tree use (`agent-background-tools/export.ts` is the only
  one). Not in scope here.
- Whether `view.data` should be size-bounded, given it is projected into model
  context on every task-triggered turn.

## 10. Testing

- Unit: `applyTaskTransition` for `update` on each status; descriptor
  construction and tagging; `defineTool` overload typing via `expectTypeOf`
  (no `delegated`/`send` on the workflow-body `TaskExec`).
- Integration: report → `update` command → `view.data`; receipt merge and
  the race against early return/throw; `wake: false` producing no parent
  delivery; `delegated()` receipt appearing on `view.data`; `send({ kind:
"update" })` and `yield` producing the same task command.
- Scenario: compile-time `shape` for each cell; `execution: "background"` step
  body with yields.
- E2E: extend `agent-background-tools` with a workflow body that yields a
  receipt, parks on `createWebhook`, and completes; keep the `send`-based
  `export.ts` fixture as the regression for the lowered path.
