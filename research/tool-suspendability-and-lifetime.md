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

This document makes both axes explicit in the compiled tool shape, gives each
of the four resulting cells a distinct `execute` contract, and replaces the
task-side authoring API. `execution: "background"` stays as the way to declare
a task lifetime. The third `task` argument stays, but `task.delegated`,
`task.send`, and `task.binding` are removed from it; in their place, a
background body communicates with its task only through `yield`, in three
forms:

```ts
yield { progress: 0.4 }; // progress: transient, never stored
yield task.store({ devboxTaskId, taskUrl }); // store on the task, do not wake the parent
yield task.wake({ state: "attention-required" }); // store on the task and wake the parent
```

Author-supplied task data becomes durable, model-visible state on the task
view (`view.data`) rather than a one-shot tool result, and the first stored
value is the receipt the launching turn returns.

Motivating case: [vercel/internal-agents#2173](https://github.com/vercel/internal-agents/pull/2173)
runs Devbox as a background tool and had to build a relay workflow, a webhook
route, and a `session.completed` adapter because a background `execute()`
cannot park on an external webhook, and a background workflow tool cannot put
author data in its receipt.

## 2. The four cells

|                       | `lifetime: "step"`                                                                | `lifetime: "task"`                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `suspend: "none"`     | Ordinary tool. Runs inside the step; generator yields stream as `action.partial`. | Task tool. Task created; body runs inside the step and must return; `yield task.store()` annotates before returning. |
| `suspend: "workflow"` | Waiting durable tool. Turn parks on the run; return value is the tool result.     | Background durable tool. Model gets a receipt; run outlives the step; `yield` stores, wakes, or reports progress.    |

Every cell exists today. What changes is that the pair is data the compiler
writes once and consumers switch on, and that `yield` is the only channel from
a body to its task in both task cells, instead of `delegated()`/`send` in one
and nothing in the other.

```
                suspend: none                suspend: workflow
              ┌──────────────────────┐    ┌──────────────────────────┐
lifetime:step │ execute() in step    │    │ run; turn parks on it    │
              └──────────────────────┘    └──────────────────────────┘
              ┌──────────────────────┐    ┌──────────────────────────┐
lifetime:task │ execute() in step,   │    │ run; receipt to model;   │
              │ yield store → return │    │ yield store/wake/progress│
              └──────────────────────┘    └──────────────────────────┘
```

## 3. Authoring API

### 3.1 Declaring the axes

`execution: "background"` selects `lifetime: "task"`; its absence selects
`lifetime: "step"`. Suspendability is not declared: the compiler reads the
`"use workflow"` directive from the body, as it does today. The two never
collapse into one enum (`"background-workflow"` is rejected).

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

A background tool whose body is a workflow now receives the third `task`
argument too. Today it is silently absent there.

### 3.2 The `task` argument

`TaskExec` shrinks to identity plus two descriptor constructors. Both return
plain tagged JSON and perform no I/O, so they are replay-safe inside a workflow
body.

```ts
interface TaskExec {
  readonly taskId: string;
  readonly batch: readonly BackgroundToolCall[];
  store(data: JsonObject): TaskStore;
  wake(data?: JsonObject): TaskWake;
}
```

Removed: `delegated()`, `send()`, `binding`, `session`. `delegated` and the
executor binding survive as the internal seam subagent dispatch and the
tool-run return through; they are no longer exported.

### 3.3 The three `yield` forms

A background body may `yield` three kinds of value. They differ in whether the
value is stored on the task and whether the parent is woken.

| form                     | `view.data`          | parent                            | use                                         |
| ------------------------ | -------------------- | --------------------------------- | ------------------------------------------- |
| `yield value` (untagged) | untouched            | note, under pending-cohort policy | transient progress                          |
| `yield task.store(data)` | replaced with `data` | not woken                         | receipt, identifiers, state for later turns |
| `yield task.wake(data?)` | replaced if `data`   | woken with `view.data`            | a state change the parent should act on     |

- **Progress** is today's generator semantics, unchanged: `action.partial`
  for a waiting tool, the existing `Background task … update: <json>` note for
  a background one. It is never persisted.
- **Store** is the only way to write `view.data`. Replace, not merge.
- **Wake** is store followed by a wake. The wake carries the task's current
  `view.data`, not a free-text note, so the parent turn reads structured state.

The first `store` or `wake` observed by the launching turn is the receipt:
`{ status: "working", taskId, ...view.data }`. Progress yields before it are
buffered and delivered after the receipt.

### 3.4 Per-cell `execute` contract

- **`step` / `none`** — `execute(input, ctx)`. Unchanged.
- **`step` / `workflow`** — `execute(input, ctx)` with `"use workflow"`.
  Unchanged. `yield` remains `action.partial`; no `task` argument.
- **`task` / `workflow`** — `execute(input, ctx, task)` with
  `"use workflow"`. All three `yield` forms. `return` completes the task with
  the return value; `throw` fails it; `ctx.abortSignal` is the cancel path.
- **`task` / `none`** — `execute(input, ctx, task)`. `yield task.store()` and
  progress before `return`; `return` completes. `task.wake()` is a type error:
  the body cannot outlive the step, so there is no gap for the parent to be
  woken into. A body that must outlive the step is a workflow.

`defineTool` overloads keep the wrong capability unreachable: `task` is absent
on a `lifetime: "step"` call; `wake` is absent from the `TaskExec` a
non-workflow body receives.

### 3.5 Example: Devbox as a background durable tool

```ts
export default defineTool({
  execution: "background",
  inputSchema: devboxInputSchema,
  async *execute(input, ctx, task) {
    "use workflow";

    const done = createWebhook();
    const run = await startOrContinueDevbox({ input, callbackUrl: done.url, callId: ctx.callId });
    yield task.store({ devboxTaskId: run.taskId, taskUrl: run.taskUrl }); // receipt

    try {
      const event = await (await done).json();
      if (event.state === "attention-required") {
        yield task.wake({
          devboxTaskId: run.taskId,
          taskUrl: run.taskUrl,
          state: "attention-required",
        });
        return { devboxTaskId: run.taskId, state: "attention-required" };
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
adapter from the PR are deleted. A later v turn reads `devboxTaskId` from the
task's `view.data` in `[Task state]` to continue the same api-devbox task.

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
  data?: JsonObject;
  wake: boolean;
}
```

Semantics:

- Accepted only while the view is `working` or `input_required`; rejected
  (not failed) on a terminal view.
- When `data` is present it **replaces** `view.data`. Last-write-wins. No
  merge.
- `wake: true` delivers the parent a wake carrying `view.data` under the
  existing pending-cohort policy. `wake: false` stores only.
- Idempotency comes from the existing hook cursor plus the run's
  `(epoch, index, callId)` delivery id. Replayed reports are no-ops.

Progress yields do not use this command; they keep today's report path.

### 4.3 Wiring

- **Workflow run → task.** `runBody` already sends each yield as a
  `RunReport` through `resumeHookStep(owner.report)`. The owner
  (`runReportToTaskUpdate`) maps a `TaskStore` to
  `{ kind: "update", data, wake: false }`, a `TaskWake` to
  `{ kind: "update", data?, wake: true }`, and an untagged value to today's
  progress note.
- **Receipt.** `createWorkflowToolBackgroundExecute` waits on the owner's
  report channel for the first `store`/`wake`, raced against the run's outcome
  so a body that returns or throws first still settles the call. The receipt
  is `{ status: "working", taskId, ...view.data }`. A body that never stores
  keeps `{ status: "working", taskId }`.
- **Step-lifetime task tool.** The `"Background tools cannot return
AsyncIterable"` guard is removed; the executor iterates the body, sends each
  `store` as an `update`, and completes with the return value. All stores
  precede completion by construction.
- **Waiting workflow tool.** Unchanged: yields stream as `action.partial`.
  `TaskStore`/`TaskWake` cannot be constructed there because there is no
  `task` argument.
- **Subagents and the tool-run.** Continue to bind an executor through the
  internal `delegated` seam. Unchanged behaviour; no public surface.

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

## 6. Removed

From the public `TaskExec`:

- `delegated()` and `TaskExecutorBinding`. An authored tool no longer hands a
  task to an external executor by returning a sentinel; it parks on the
  external system from a workflow body. The seam remains internal for
  subagent dispatch and the tool-run.
- `send()`. Not restart-safe by its own contract; strictly dominated by
  `yield` in a workflow body and by `yield task.store()` before `return` in a
  step body.
- `binding`. The framework-owned callback wire (`session.completed` /
  `session.failed`) stops being reachable from authored code.
- `session`. Read session context through `ctx.session`, as every other tool
  does.

Pre-1.0: no compatibility shim. The only known external consumer of the
removed surface is the internal-agents Devbox bridge, whose replacement is
§3.5. The `agent-background-tools/export.ts` fixture is rewritten as a workflow
body.

## 7. Cancellation

Unchanged in mechanism, but two behaviours become load-bearing once there is
no executor binding for an authored tool to hang a cancel handler on:

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
- `yield` is the only channel from a body to its task. There is no
  post-return path.
- `view.data` is written only by `store`/`wake`; progress yields never touch
  it; it is never derived from the tool result or the executor binding.
- `wake` exists only on a workflow body's `TaskExec`.
- The task run remains the single writer of task lifecycle and `data`.
- A receipt is observed by the launching turn exactly once, from the first
  `store`/`wake`; later stores and wakes arrive as task state, never as a tool
  result.
- Subagent task behaviour is unchanged; it uses the internal seam.

## 9. Open decisions

- Whether `store`/`wake` should also be importable from `eve/tools` as
  standalone descriptor constructors (matches `ask` from `eve/workflow`), or
  stay on `task` for type gating only. Leaning `task` only.
- Whether `wake()` with no `data` is worth keeping, or every wake must carry
  the state it wants the parent to see. Leaning required `data`.
- Whether progress yields in a background body should keep waking the parent
  with a note (today's behaviour) or become store-free no-ops now that `wake`
  exists. Leaning keep, revisit with usage.
- Whether `view.data` should be size-bounded, given it is projected into model
  context on every task-triggered turn.

## 10. Testing

- Unit: `applyTaskTransition` for `update` with and without `data` on each
  status; descriptor construction and tagging; `defineTool` overload typing via
  `expectTypeOf` (no `wake` on a non-workflow `TaskExec`, no `delegated`/`send`
  anywhere).
- Integration: `store` → `update` → `view.data`, no parent delivery;
  `wake` → `update` → parent delivery carrying `view.data`; untagged yield →
  progress note, `view.data` untouched; receipt taken from the first
  `store`/`wake` and the race against early return/throw.
- Scenario: compile-time `shape` for each cell; `execution: "background"` step
  body with `store` before `return`.
- E2E: rewrite `agent-background-tools/export.ts` as a workflow body that
  stores a receipt, yields progress, parks on `createWebhook`, wakes on the
  callback, and completes; assert the receipt, the silent store, the wake, and
  the terminal result.
