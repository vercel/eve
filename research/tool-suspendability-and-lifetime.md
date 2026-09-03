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
yield { progress: 0.4 }; // progress: transient, never persisted
yield task.setState({ devboxTaskId, taskUrl }); // durable state; silent
yield task.postMessage("Devbox needs input"); // one message; wakes the parent with it
```

Author-supplied task data becomes durable, model-visible state on the task
view (`view.state`) rather than a one-shot tool result, and the first set
value is the receipt the launching turn returns.

`yield` is one-way. Anything that needs a reply is a separate primitive that
already exists for waiting workflow tools and is made to work for background
bodies: `ask` from `eve/workflow` for human input, and `ctx.getToken` /
`ctx.requireAuth` inside a `"use step"` for provider authorization under the
requester's identity. The latter is a blocker today and is in scope.

Motivating case: [vercel/internal-agents#2173](https://github.com/vercel/internal-agents/pull/2173)
runs Devbox as a background tool and had to build a relay workflow, a webhook
route, and a `session.completed` adapter because a background `execute()`
cannot park on an external webhook, and a background workflow tool cannot put
author data in its receipt.

## 2. The four cells

|                       | `lifetime: "step"`                                                                | `lifetime: "task"`                                                                                                              |
| --------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `suspend: "none"`     | Ordinary tool. Runs inside the step; generator yields stream as `action.partial`. | Task tool. Task created; body runs inside the step and must return; `yield task.setState()` annotates before returning.         |
| `suspend: "workflow"` | Waiting durable tool. Turn parks on the run; return value is the tool result.     | Background durable tool. Model gets a receipt; run outlives the step; `yield` sets state, posts a message, or reports progress. |

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
              │ setState then return │    │ setState / post / yield  │
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
  setState(state: JsonObject): TaskSetState;
  postMessage(message: string | JsonObject): TaskMessage;
}
```

`setState` writes a durable snapshot the parent can read on any later turn.
`postMessage` delivers one message to the parent as input for a new turn, like
`postMessage` between windows: it is not stored on the task, and it does not
change `view.state`. The two are independent; a body that wants both sets state
and then posts.

Removed: `delegated()`, `send()`, `binding`, `session`. `delegated` and the
executor binding survive as the internal seam subagent dispatch and the
tool-run return through; they are no longer exported.

### 3.3 Four directions of communication

A background body talks to four parties. Each has one primitive; none overlap.

| direction                   | primitive                                    | shape                                 | durable                                          |
| --------------------------- | -------------------------------------------- | ------------------------------------- | ------------------------------------------------ |
| body → parent, one-way      | `yield` (progress / setState / postMessage)  | JSON snapshot, or a message           | setState yes; postMessage and progress no        |
| body ↔ human, round trip    | `ask(ctx, request)` from `eve/workflow`      | structured request → structured reply | yes: run-owned, answerable after the turn ends   |
| body ↔ provider, round trip | `ctx.getToken` / `ctx.requireAuth` in a step | token, or an authorization park       | yes: same `authorization.required` wire as today |
| body → parent, terminal     | `return` / `throw`                           | tool output / error                   | yes                                              |

The parent reaches the body only through `ctx.abortSignal`.

`yield` is fire-and-forget state. It never carries a question. Anything that
needs a reply from a human is `ask`; anything that needs a reply from an
identity provider is `requireAuth`. Both are suspension points with typed
replies and already exist for waiting workflow tools; §3.5 and §3.6 make them
available to background bodies.

### 3.4 The three `yield` forms

A background body may `yield` three kinds of value. They differ in whether the
value is persisted as task state and whether the parent is woken.

| form                          | `view.state`          | parent                               | use                                         |
| ----------------------------- | --------------------- | ------------------------------------ | ------------------------------------------- |
| `yield value` (untagged)      | untouched             | note, under pending-cohort policy    | transient progress                          |
| `yield task.setState(state)`  | replaced with `state` | not woken                            | receipt, identifiers, state for later turns |
| `yield task.postMessage(msg)` | untouched             | woken with `msg` as the turn's input | something the parent should act on now      |

- **Progress** is today's generator semantics, unchanged: `action.partial`
  for a waiting tool, the existing `Background task … update: <json>` note for
  a background one. It is never persisted.
- **setState** is the only way to write `view.state`. Replace, not merge.
  Silent: no parent turn is started.
- **postMessage** wakes the parent with the message as input, attributed to
  the task. The message is not stored; if the parent needs to recall it later
  it reads `view.state`, which the body sets separately. Runs under the
  pending-cohort delivery policy like any other task-triggered turn.

The first `setState` observed by the launching turn is the receipt:
`{ status: "working", taskId, ...view.state }`. Progress and messages yielded
before it are buffered and delivered after the receipt.

### 3.5 Human input: `ask`

Unchanged from the waiting-tool contract in `docs/tools/workflows.mdx`. The
request travels over the run's `request` channel; the owning task moves to
`input_required`; the channel renders it the way it renders `ask_question`;
the answer resumes the hook and the task returns to `working`. The reply is the
existing static shape `{ optionId?, text? }`. Richer response schemas are out
of scope here.

What this document adds is only the statement that `ask` is the HITL channel
for background bodies too, and that it is disjoint from `yield`: a
`postMessage` tells the parent agent something; an `ask` asks the human
something. A body that needs the user's input does not post a message to the
parent and have it relay a question.

### 3.6 Provider authorization in a workflow body

Today `ctx.getToken` and `ctx.requireAuth` throw inside a workflow body
(`tool-run/workflow.ts`), and a `"use step"` only sees `process.env`. A tool
that must act under the requester's grant — every Connect-backed tool — cannot
be written as a workflow. This is the blocker for Devbox and has to be fixed
here, not deferred.

Contract:

- `ctx.getToken(provider)` and `ctx.requireAuth(provider)` are callable inside
  a `"use step"` function that received `ctx`. They resolve against the
  session identity carried in the run's serialized context, through the same
  scoped-authorization path a step tool uses (`execution/tool-auth.ts`).
- A resolved token is returned to the step and never enters the workflow
  body's replay log. Steps that hold a token are ordinary steps: retried on
  failure, not journaled.
- When the provider requires interactive authorization, the step does not
  return an `AuthorizationSignal` to the model. Instead the run parks the way
  `ask` parks: the challenge travels over the run's `request` channel, the
  owning task moves to `input_required` with an authorization request, the
  parent channel renders the sign-in the way it renders a subagent's
  `authorization.required` today (`tasks/child/steps.ts`), and the callback
  resumes the hook. The step then re-resolves and continues. To the body this
  is one `await`.
- The loop guard is unchanged: a token rejected immediately after
  authorization fails the run with `ConnectionAuthorizationFailedError`.
- In the body itself (outside a step) both methods keep throwing with the
  current message. Credentials never touch deterministic code.

This reuses two existing wires — the scoped-authorization resolver and the
task-owned authorization event — and adds one mapping: a step-raised
authorization requirement becomes a run request, alongside `ask`.

### 3.7 Per-cell `execute` contract

- **`step` / `none`** — `execute(input, ctx)`. Unchanged.
- **`step` / `workflow`** — `execute(input, ctx)` with `"use workflow"`.
  Unchanged. `yield` remains `action.partial`; no `task` argument.
- **`task` / `workflow`** — `execute(input, ctx, task)` with
  `"use workflow"`. All three `yield` forms, `ask`, and step-scoped auth.
  `return` completes the task with the return value; `throw` fails it;
  `ctx.abortSignal` is the cancel path.
- **`task` / `none`** — `execute(input, ctx, task)`. `yield task.setState()` and
  progress before `return`; `return` completes. `task.postMessage()` and `ask`
  are unavailable: the body cannot outlive the step, so there is no later turn
  to message and no gap for anyone to answer into. Auth is today's step-tool
  path (an `AuthorizationSignal` parks the turn). A body that must outlive the
  step is a workflow.

`defineTool` overloads keep the wrong capability unreachable: `task` is absent
on a `lifetime: "step"` call; `postMessage` is absent from the `TaskExec` a
non-workflow body receives.

### 3.8 Example: Devbox as a background durable tool

One invocation owns the whole api-devbox task, including every
attention-required round trip. There is no continuation argument and no
"one active binding per api-devbox task" constraint: the run is the binding.

```ts
export default defineTool({
  execution: "background",
  inputSchema: devboxInputSchema,
  async *execute(input, ctx, task) {
    "use workflow";

    const run = await startDevbox(input, ctx); // step: resolves the requester's Connect token
    yield task.setState({ devboxTaskId: run.taskId, taskUrl: run.taskUrl }); // receipt

    try {
      while (true) {
        const done = createWebhook();
        await subscribeDevbox(run.taskId, done.url, ctx); // step
        const event = await (await done).json();

        if (event.state === "completed") return await readDevboxResult(run.taskId, ctx);
        if (event.state === "errored") throw new FatalError(`Devbox task ${run.taskId} failed`);

        // attention-required: the human answers, in the same run.
        const answer = await ask(ctx, {
          prompt: event.message,
          display: "text",
          allowFreeform: true,
        });
        yield { state: "resuming", devboxTaskId: run.taskId }; // progress
        await continueDevbox(run.taskId, answer.text, ctx); // step
      }
    } finally {
      if (ctx.abortSignal.aborted) await stopDevbox(run.taskId, ctx);
    }
  },
});

async function startDevbox(input: DevboxInput, ctx: ToolContext) {
  "use step";
  const { token } = await ctx.getToken(devboxUserAuth); // may park the run on sign-in (§3.6)
  return createDevboxClient({
    token,
    onUnauthorized: () => ctx.requireAuth(devboxUserAuth),
  }).createTask(input);
}
```

Every HITL constraint the integration doc lists holds:

- v owns every user-facing message. `ask` renders the question on v's channel;
  Devbox is never a model-visible subagent.
- attention-required does not complete the task. It parks the run on `ask`;
  the task is `input_required` while the human answers and `working` again
  after. No `input.requested` is authored by v; the framework owns it.
- Sign-in is not a special state the tool returns. `getToken` in a step parks
  the run the same way, under the requester's identity.
- The callback is a signal; `readDevboxResult` reads authoritative state.
- Cancellation stops the sandbox from `finally` (§7); `stop_devbox_task` goes.
- Duplicate webhooks are harmless: each iteration mints a fresh webhook URL,
  and a late post to a consumed one is rejected by the SDK.

The relay workflow, relay route, `session.completed` adapter, `task`
continuation argument, and `get_devbox_task` (for anything other than ad hoc
status) are deleted.

## 4. Task state and messages

### 4.1 Task view

`TaskView` gains an author-owned, model-visible field:

```ts
readonly state?: JsonObject;
```

`state` is distinct from the existing `status`. `status` is the framework's
lifecycle verdict (`working`, `input_required`, `completed`, …) and is written
only by lifecycle commands. `state` is whatever the body last set, opaque to
the framework, and is written only by `setState`.

It is present on `working` and `input_required` views and retained unchanged
on terminal views. It is included in model-visible task JSON, in the
`[Task state]` cohort projection, and in `task_status`/TUI rendering. It never
carries routing credentials; those stay on the private `executor` binding.

### 4.2 The `set-state` command

The task run accepts one new command through its existing single-writer inbox:

```ts
{
  kind: "set-state";
  state: JsonObject;
}
```

- Accepted only while the view is `working` or `input_required`; rejected
  (not failed) on a terminal view.
- `state` **replaces** `view.state`. Last-write-wins. No merge.
- Silent: no parent turn is started.
- Idempotency comes from the existing hook cursor plus the run's
  `(epoch, index, callId)` delivery id. Replayed reports are no-ops.

### 4.3 Messages

`postMessage` is not a task command. It does not pass through the task run's
transition function and does not touch the view. It is a delivery to the
parent session, the same kind of `send` command the child workflow already
issues for updates (`wakeTaskUpdateParentStep`), with two differences:

- The payload is the author's message, attributed to the task
  (`taskId`, tool name), rather than the framework's
  `Background task … update:` prose. A string is delivered as text; an object
  is delivered as JSON.
- Delivery is deduplicated by the run's `(epoch, index, callId)` id, so a
  replayed yield does not start a second turn.

The receiving turn runs under the existing task-delivery policy: while the
cohort is pending the model is told to act only if the message requires it and
otherwise stay silent. `postMessage` is how a body tells the agent to act; it
is not a way to talk to the user.

Progress yields keep today's report path unchanged.

### 4.4 Wiring

- **Workflow run → task.** `runBody` already sends each yield as a
  `RunReport` through `resumeHookStep(owner.report)`. The owner
  (`runReportToTaskUpdate`) maps a `TaskSetState` to the `set-state` command,
  a `TaskMessage` to a parent `send`, and an untagged value to today's progress
  note.
- **Receipt.** `createWorkflowToolBackgroundExecute` waits on the owner's
  report channel for the first `setState`, raced against the run's outcome so
  a body that returns or throws first still settles the call. The receipt is
  `{ status: "working", taskId, ...view.state }`. A body that never sets state
  keeps `{ status: "working", taskId }`.
- **Step-lifetime task tool.** The `"Background tools cannot return
AsyncIterable"` guard is removed; the executor iterates the body, sends each
  `setState` as a `set-state`, and completes with the return value. All sets
  precede completion by construction.
- **Waiting workflow tool.** Unchanged: yields stream as `action.partial`.
  `TaskSetState`/`TaskMessage` cannot be constructed there because there is no
  `task` argument.
- **Subagents and the tool-run.** Continue to bind an executor through the
  internal `delegated` seam. Unchanged behaviour; no public surface.
- **Step-scoped auth (§3.6).** `ToolRunWorkflowInput` carries the session
  identity the scoped-authorization resolver needs (it already carries
  `session`). `createWorkflowToolContext` builds `getToken`/`requireAuth` that
  work when invoked from a step and throw when invoked from the body; the
  distinction is the ambient step context the Workflow SDK exposes. A
  step-raised authorization requirement is sent as a `RunRequestMessage` on the
  existing `request` channel with a new `authorization` variant next to
  `question`; `runRequestToInputRequestPayload` maps it to the
  `authorization.required` task event the child workflow already forwards
  (`wakeTaskAuthorizationParentStep`). The callback resumes the same
  `answerToken` hook the step is parked on.

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
  `yield` in a workflow body and by `yield task.setState()` before `return` in a
  step body.
- `binding`. The framework-owned callback wire (`session.completed` /
  `session.failed`) stops being reachable from authored code.
- `session`. Read session context through `ctx.session`, as every other tool
  does.

Pre-1.0: no compatibility shim. The only known external consumer of the
removed surface is the internal-agents Devbox bridge, whose replacement is
§3.8. The `agent-background-tools/export.ts` fixture is rewritten as a workflow
body.

## 7. Cancellation

Unchanged in mechanism, but two behaviours become load-bearing once there is
no executor binding for an authored tool to hang a cancel handler on:

- `task_cancel` on a background workflow tool aborts `ctx.abortSignal` in the
  run and waits the existing grace period.
- A body parked on a hook, webhook, `ask`, or authorization does not observe
  the signal today and is abandoned after the grace period without running
  `finally`. The tool-run should race the parked await against its control
  inbox so `finally` runs before the run ends. Without this, external cleanup
  (`stopDevbox` above) has no home and authors reach for a second tool.

Together with §3.6 these are the two `execution/` changes beyond wiring, and
both are required for the Devbox migration to be complete.

## 8. Invariants

- A tool's cell is fixed at compile time and visible in the manifest.
- The `task` argument exists iff `execution === "background"`.
- `yield` is the only one-way channel from a body to its task. There is no
  post-return path.
- `yield` never asks. Human input is `ask`; provider authorization is
  `getToken`/`requireAuth` in a step. Neither is expressible as a yield.
- `view.state` is written only by `setState`; progress yields never touch
  it; it is never derived from the tool result or the executor binding.
- `postMessage` and `ask` exist only for a workflow body.
- A token never enters a workflow body's replay log. Credentials are resolved
  and consumed inside steps.
- The task run remains the single writer of task lifecycle and `state`.
- A receipt is observed by the launching turn exactly once, from the first
  `setState`; later sets arrive as task state and messages as input, never as a tool
  result.
- Subagent task behaviour is unchanged; it uses the internal seam.

## 9. Open decisions

- Whether `setState`/`postMessage` should also be importable from `eve/tools` as
  standalone descriptor constructors (matches `ask` from `eve/workflow`), or
  stay on `task` for type gating only. Leaning `task` only.
- Whether progress yields in a background body should keep waking the parent
  with the framework's note (today's behaviour) or become stream-only now that
  `postMessage` exists for deliberate wakes. Leaning stream-only: two ways to
  wake the parent is one too many, and a body that wants a wake can say so.
- Whether `postMessage` should accept only strings. An object is convenient
  but blurs the line with `setState`; a body that wants the parent to read
  structured data can set state and post a short pointer. Leaning string only.
- Whether `view.state` should be size-bounded, given it is projected into model
  context on every task-triggered turn.
- Structured `ask` responses (a response schema instead of
  `{ optionId?, text? }`). Deferred; the static shape is sufficient for the
  cases in scope.
- How a step detects it is running inside a step versus the body, for the
  `getToken` gate in §3.6. The Workflow SDK exposes step context; whether eve
  should also mark it explicitly is an implementation detail to settle in the
  PR.

## 10. Testing

- Unit: `applyTaskTransition` for `update` with and without `state` on each
  status; descriptor construction and tagging; `defineTool` overload typing via
  `expectTypeOf` (no `postMessage` on a non-workflow `TaskExec`, no `delegated`/`send`
  anywhere).
- Integration: `setState` → `update` → `view.state`, no parent delivery;
  `postMessage` → parent `send` carrying the message, `view.state` untouched; untagged yield →
  progress note, `view.state` untouched; receipt taken from the first
  `setState` and the race against early return/throw; `getToken` in a step
  of a background run resolves under the session identity; a step-raised
  authorization requirement moves the task to `input_required`, renders on the
  parent channel, and resumes the step on callback; `getToken` in the body
  still throws.
- Scenario: compile-time `shape` for each cell; `execution: "background"` step
  body with `setState` before `return`.
- E2E: rewrite `agent-background-tools/export.ts` as a workflow body that
  sets a receipt, yields progress, parks on `createWebhook`, posts a message on the
  callback, and completes; assert the receipt, the silent setState, the message, and
  the terminal result. Add a second body that parks on `ask` from a background
  run and resumes with the answer. Authorization parking from a step is
  covered at integration tier; e2e cannot drive a real sign-in.
