---
issue: TBD
status: draft
last_updated: 2026-09-03
---

# Tools: suspendability and lifetime as two explicit axes

## 1. Summary

An authored tool has two independent properties that eve encodes as two
unrelated flags and re-derives with `if` chains at every consumer:

- **Suspendability** — can the body park without holding compute? Implied by
  the `"use workflow"` directive; surfaces as `handling.kind === "workflow-tool"`.
- **Lifetime** — does the call end with the harness step, or outlive it as a
  durable task? Declared by `execution: "background"`.

This document makes the pair explicit in the compiled tool shape and gives
each of the four cells one `execute` contract. The authoring surface keeps
`execution: "background"` and the third `task` argument, but `task` loses
`delegated`, `send`, `binding`, and the non-serializable `batch`. In their place a background body has one
one-way channel to its task (`yield`) and two round-trip primitives that
already exist for waiting workflow tools: `ask` for the human, and
`ctx.getToken`/`ctx.requireAuth` inside a step for the provider. The latter is
a blocker today for any Connect-backed workflow tool and is in scope.

Motivating case: [vercel/internal-agents#2173](https://github.com/vercel/internal-agents/pull/2173)
runs Devbox as a background tool and had to build a relay workflow, a webhook
route, and a `session.completed` adapter because a background `execute()`
cannot park on an external webhook, cannot resolve the requester's token, and
cannot put author data in its receipt.

## 2. The four cells

|                       | `lifetime: "step"`                                                              | `lifetime: "task"`                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `suspend: "none"`     | `execute(input, ctx)`. Runs in the step; generator yields are `action.partial`. | `execute(input, ctx, task)`. Runs in the step; `yield task.setState()` then `return` completes. No `postMessage`, no `ask`. |
| `suspend: "workflow"` | `execute(input, ctx)` with `"use workflow"`. Turn parks on the run.             | `execute(input, ctx, task)` with `"use workflow"`. Receipt to the model; run outlives the step; all of §3.                  |

Every cell exists today. What changes: the pair is data the compiler writes
once (§5), the same `task` capability means the same thing in both task cells,
and a background workflow body receives `task` at all — today it is silently
absent. `execution: "background"` selects the task row; the directive selects
the workflow column; there is no combined enum.

## 3. Authoring API

### 3.1 The `task` argument and `yield`

`TaskExec` shrinks to identity plus two descriptor constructors. Both return
tagged JSON and do no I/O, so they are replay-safe in a workflow body.

```ts
interface TaskExec {
  readonly taskId: string;
  setState(state: JsonObject): TaskSetState;
  postMessage(message: string): TaskMessage;
}
```

A background body may `yield` three kinds of value:

| form                          | `view.state`          | parent                                  | use                                         |
| ----------------------------- | --------------------- | --------------------------------------- | ------------------------------------------- |
| `yield value` (untagged)      | untouched             | not woken; streamed as `action.partial` | transient progress                          |
| `yield task.setState(state)`  | replaced with `state` | not woken                               | receipt, identifiers, state for later turns |
| `yield task.postMessage(msg)` | untouched             | woken with `msg` as the turn's input    | something the parent should act on now      |

Progress is stream-only. Today an untagged yield from a background body wakes
the parent with a framework-authored note; that goes away, so `postMessage` is
the one way to wake the parent. `setState` is the only writer of `view.state`
(§4.1): replace, not merge, silent. `postMessage` is one delivery to the
parent, like `postMessage` between windows: not stored, attributed to the
task, run under the existing task-delivery policy. A body that wants both sets
state and then posts. Neither constructor is importable elsewhere; they live on
`task` so the type system can withhold them by cell.

The model receives `{ status: "working", taskId }` as soon as the task is admitted. The receipt is independent of state: a body may set state later, park before setting it, or never set it. `taskId` and the task's private run addresses—not `view.state`—are what resume parked work.

### 3.2 Replies: `ask` and provider authorization

`yield` never asks. Anything that needs a reply is a suspension point with a
typed reply, disjoint from `yield`:

| direction                | primitive                                    | reply                         |
| ------------------------ | -------------------------------------------- | ----------------------------- |
| body ↔ human             | `ask(ctx, request)` from `eve/workflow`      | `{ optionId?, text? }`        |
| body ↔ identity provider | `ctx.getToken` / `ctx.requireAuth` in a step | a token, or a park on sign-in |

The parent reaches the body only through `ctx.abortSignal`.

**`ask`** is unchanged from the waiting-tool contract in
`docs/tools/workflows.mdx`: the request travels over the run's `request`
channel, the task moves to `input_required`, the channel renders it like
`ask_question`, the answer resumes the hook. Richer response schemas are
deferred. `postMessage` tells the agent something; `ask` asks the human
something. A body never posts a question for the parent to relay.

**Provider authorization** is the change. Today `getToken`/`requireAuth`
throw in a workflow body and a step sees only `process.env`, so no
Connect-backed tool can be a workflow. Contract:

- Both are callable inside a `"use step"` that received `ctx`. They resolve
  under the session identity in the run's serialized context, through the
  scoped-authorization path a step tool uses (`execution/tool-auth.ts`). The
  gate is the Workflow SDK's ambient step context: the same `ctx` method
  succeeds when that context is present and throws when it is not.
- A token is returned to the step and never enters the body's replay log.
- Interactive authorization does not return an `AuthorizationSignal` to the
  model. The run parks the way `ask` parks: the challenge is a `RunRequestMessage`
  with a new `authorization` variant next to `question`; the task moves to
  `input_required`; the parent channel renders it like a subagent's
  `authorization.required` today (`tasks/child/steps.ts`); the callback resumes
  the step's hook and it re-resolves. To the body this is one `await`.
- The loop guard is unchanged: a token rejected immediately after
  authorization fails the run.
- In the body itself both methods keep throwing.

### 3.3 Example: Devbox as a background durable tool

Against the api-devbox contract the v PR already codes to: one webhook URL at
`createTask`; `taskStateChange` posts with
`state ∈ { pending, running, attention-required, complete, errored }`; a
`prompt` endpoint for follow-ups; a result `{ summary, exitStatus, error?, prs? }`
from `getTask`. `Hook` is an `AsyncIterable`, so one webhook receives every
state change for the task's lifetime.

One run owns the whole api-devbox task. Every follow-up — an
attention-required answer, or "now fix the review findings" — goes through
`ask`, so there is no continuation argument and no second tool.

```ts
export default defineTool({
  execution: "background",
  description: "Start repository work in api-devbox and see it through. Use once per task.",
  inputSchema: devboxInputSchema, // repos, prompt, title?, assistant?, model?, pr?
  async *execute(input, ctx, task) {
    "use workflow";

    const events = createWebhook(); // registered before the task exists
    const devbox = await createDevboxTask(input, events.url, ctx); // step
    yield task.setState({ devboxTaskId: devbox.taskId, taskUrl: devbox.taskUrl, state: "pending" });

    try {
      for await (const request of events) {
        const change = parseTaskStateChange(await request.json());
        if (change === null || change.taskId !== devbox.taskId) continue;
        yield task.setState({
          devboxTaskId: devbox.taskId,
          taskUrl: devbox.taskUrl,
          state: change.state,
        });

        switch (change.state) {
          case "pending":
          case "running":
            continue;

          case "attention-required": {
            // api-devbox does not carry the question in the webhook; the task page does.
            const answer = await ask(ctx, {
              prompt:
                `Devbox needs your input to continue "${devbox.title}".\n` +
                `Open ${devbox.taskUrl} to see what it is asking, then reply here.`,
              display: "text",
              allowFreeform: true,
            });
            await promptDevbox(devbox.taskId, answer.text ?? "", ctx); // step
            continue;
          }

          case "complete": {
            const result = await readDevboxTask(devbox.taskId, ctx); // step: authoritative
            if (input.pr === false) {
              const next = await ask(ctx, {
                prompt: `Review finished:\n\n${result.summary}\n\nApply these findings?`,
                display: "confirmation",
                options: [
                  { id: "apply", label: "Apply the findings", style: "primary" },
                  { id: "done", label: "Done" },
                ],
              });
              if (next.optionId === "apply") {
                await promptDevbox(devbox.taskId, "Apply the review findings and open a PR.", ctx);
                continue;
              }
            }
            return { summary: result.summary, prs: result.prs ?? [], taskUrl: devbox.taskUrl };
          }

          case "errored": {
            const result = await readDevboxTask(devbox.taskId, ctx);
            throw new FatalError(result.error ?? `Devbox task ${devbox.taskId} errored`);
          }
        }
      }
      throw new FatalError(
        `Webhook for Devbox task ${devbox.taskId} closed before a terminal state`,
      );
    } finally {
      if (ctx.abortSignal.aborted) await stopDevbox(devbox.devboxId, ctx); // step
    }
  },
});

async function createDevboxTask(input: DevboxInput, webhookUrl: string, ctx: ToolContext) {
  "use step";
  const { token } = await ctx.getToken(devboxUserAuth); // parks the run on sign-in (§3.2)
  const client = createDevboxClient({
    token,
    onUnauthorized: () => ctx.requireAuth(devboxUserAuth),
  });
  const snapshot = await selectSnapshot(client, input.repos);
  const set = await client.createTaskSet(input.title ?? deriveTitle(input.prompt));
  const created = await client.createTask({
    setId: set.set_id,
    snapshotId: snapshot.id,
    prompt: promptWithDeliverable(input),
    assistant: input.assistant,
    model: input.model,
    webhookUrl,
  });
  return {
    taskId: created.task_id,
    devboxId: created.devbox_id,
    title: input.title ?? deriveTitle(input.prompt),
    taskUrl: devboxTaskUrl(created.task_id),
  };
}
```

`promptDevbox`, `readDevboxTask`, and `stopDevbox` are one-call steps over the
same client; snapshot selection and prompt construction are the PR's helpers.

What this buys over the bridge:

- attention-required is not terminal. The run parks on `ask`, the requester
  answers on v's channel (only the requester — `ask` already enforces that on
  Slack), and the answer is posted from the same run.
- A review can be followed by a fix without a second launch.
- Sign-in is not a state the tool returns; `getToken` parks the run under the
  requester's identity.
- Cancellation stops the sandbox from `finally` (§7).
- Duplicate or out-of-order webhooks are harmless: other tasks' posts are
  skipped, a repeated `attention-required` re-asks, and a post after `return`
  hits a hook nobody reads.

Deleted: the relay workflow and route, the `session.completed`/`subagentName`
adapter, the launch and follow-up fingerprint guards (replay is the idempotency
mechanism), the `task` continuation argument, and `stop_devbox_task`.

## 4. Task state and messages

### 4.1 `view.state`

`TaskView` gains an author-owned, model-visible `state?: JsonObject`. It is
distinct from `status`, the framework's lifecycle verdict: `state` is whatever
the body last set, opaque to the framework. Present on `working` and
`input_required` views, retained on terminal ones, included in model-visible
task JSON and the `[Task state]` projection. Never carries credentials; those
stay on the private `executor` binding.

### 4.2 The `set-state` command

One new task command through the existing single-writer inbox:
`{ kind: "set-state", state: JsonObject }`. Accepted while `working` or
`input_required`, rejected on a terminal view. Replaces `view.state`. Starts no
turn. Idempotent under the existing hook cursor and the run's
`(epoch, index, callId)` delivery id.

### 4.3 Messages

`postMessage` is not a task command and does not touch the view. It is the
parent-session `send` the child workflow already issues for updates
(`wakeTaskUpdateParentStep`), carrying the author's message attributed to the
task instead of the framework's `Background task … update:` prose, deduplicated
by the same delivery id. The receiving turn runs under the existing
task-delivery policy.

### 4.4 Wiring

- `runBody` already sends each yield as a `RunReport`. The owner maps
  `TaskSetState` → `set-state`, `TaskMessage` → parent `send`, untagged →
  `action.partial` on the stream. The `wakeTaskUpdateParentStep` path for
  untagged reports is removed.
- `createWorkflowToolBackgroundExecute` returns `{ status: "working", taskId }` after task admission. It never waits for a body yield.
- The `"Background tools cannot return AsyncIterable"` guard goes; the
  step-lifetime executor iterates the body and sends each `setState` before
  completing with the return value.
- Step-scoped auth: `createWorkflowToolContext` builds `getToken`/`requireAuth`
  that work under ambient step context and throw otherwise;
  `runRequestToInputRequestPayload` maps the `authorization` request variant to
  the `authorization.required` task event the child workflow already forwards.
- Subagents and the tool-run keep binding executors through the internal
  `delegated` seam. No public surface.

## 5. Compiled shape

`CompiledToolBehavior` carries the pair as data:

```ts
readonly shape: {
  readonly lifetime: "step" | "task";
  readonly suspend: "none" | "workflow";
};
```

`handling.kind === "workflow-tool"` collapses into `suspend: "workflow"` plus
its `workflowId`. `prepareToolBehavior`, the background-call filter in
`tool-loop.ts`, `dispatchTaskStep`, and `createWorkflowToolBackgroundExecute`
switch on `shape` instead of re-deriving it. `defineTool` overloads gate the
capabilities by cell: no `task` on a step-lifetime call; no `postMessage` on a
non-workflow `TaskExec`.

## 6. Removed

From the public `TaskExec`: `delegated()` and `TaskExecutorBinding` (a tool
parks on the external system from a workflow body instead of handing off by
sentinel; the seam stays internal), `send()` (not restart-safe by its own
contract; dominated by `yield`), `binding` (the framework callback wire stops
being reachable from authored code), and `session` (use `ctx.session`).

Pre-1.0: no shim. The only known external consumer is the Devbox bridge; §3.3
is its replacement. The `agent-background-tools/export.ts` fixture is rewritten
as a workflow body.

## 7. Cancellation

`task_cancel` aborts `ctx.abortSignal` in the run and waits the existing grace
period — unchanged. What changes: a body parked on a hook, webhook, `ask`, or
authorization does not observe the signal today and is abandoned after the
grace period without running `finally`. The tool-run must race the parked
await against its control inbox so `finally` runs before the run ends;
otherwise external cleanup has no home and authors reach for a second tool.

With §3.2's auth change, this is one of two `execution/` changes beyond wiring.
Both are required for the Devbox migration.

## 8. Invariants

- A tool's cell is fixed at compile time and visible in the manifest; `task`
  exists iff `execution === "background"`.
- `yield` is the only one-way channel from a body to its task, and it never
  asks. There is no post-return path.
- `view.state` is written only by `setState`; never derived from the tool
  result or the executor binding. The task run stays the single writer.
- A fixed `{ status: "working", taskId }` receipt is observed exactly once and never depends on `view.state`.
- A token never enters a workflow body's replay log.
- Subagent task behaviour is unchanged.

## 9. Deferred

- Structured `ask` responses (a response schema instead of
  `{ optionId?, text? }`).
- A size bound on `view.state`. It is projected into model context on every
  task-triggered turn; revisit if it becomes a problem in practice.

## 10. Testing

- Unit: `applyTaskTransition` for `set-state` on each status; descriptor
  tagging; `defineTool` overload typing via `expectTypeOf`.
- Integration: `setState` → `view.state` with no parent delivery;
  `postMessage` → parent `send` with `view.state` untouched; immediate receipt independent of state; `getToken` in a
  step of a background run resolves under the session identity; a step-raised
  authorization requirement parks the task `input_required` and resumes on
  callback; `getToken` in the body still throws.
- Scenario: compiled `shape` for each cell.
- E2E: rewrite `agent-background-tools/export.ts` as a workflow body that sets
  a receipt, parks on `createWebhook`, posts a message on callback, and
  completes. Add a body that parks on `ask` from a background run. Sign-in
  cannot be driven in e2e; it stays at integration tier.
