---
issue: TBD
status: draft
last_updated: "2026-09-06"
---

# Tools: suspendability and lifetime as two explicit axes

## 1. Summary

The proposal uses workflow-local bindings for execution data, ordinary yields
for silent progress, and `yield task.postMessage(...)` for parent messages.
There is no `task.setState()` or authored `TaskView.state`.

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

[Implementation PR #2997](https://github.com/vercel/eve/pull/2997) implements
the compiled shape, fixed receipt, progress and message yields, and removal of
`task.delegated()`. Cancellation of
parked bodies (§7), consolidation of inbound messages (§4.1), and removal of
the remaining deprecated `TaskExec` fields (§6) are still proposed work. The
Devbox example below still depends on the cancellation work. Step-scoped
provider authorization (§3.2) is implemented through a step adapter: pass the
workflow context directly to the helper. Sign-in ends the interrupted step
attempt, parks the workflow, and retries that step with the callback. Earlier
completed steps are retained. Put auth before side effects within a step.

Motivating case: [vercel/internal-agents#2173](https://github.com/vercel/internal-agents/pull/2173)
runs Devbox as a background tool and had to build a relay workflow, a webhook
route, and a `session.completed` adapter because a background `execute()`
cannot park on an external webhook or resolve the requester's token.

## 2. The four cells

|                       | `lifetime: "step"`                                                              | `lifetime: "task"`                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `suspend: "none"`     | `execute(input, ctx)`. Runs in the step; generator yields are `action.partial`. | `execute(input, ctx, task)`. Runs in the step; yields report progress or parent messages, and `return` completes. No `ask`. |
| `suspend: "workflow"` | `execute(input, ctx)` with `"use workflow"`. Turn parks on the run.             | `execute(input, ctx, task)` with `"use workflow"`. Receipt to the model; run outlives the step; all of §3.                  |

Every cell exists today. What changes: the pair is data the compiler writes
once (§5), the same `task` capability means the same thing in both task cells,
and a background workflow body receives `task` at all — today it is silently
absent. `execution: "background"` selects the task column; the directive selects
the workflow row; there is no combined enum.

## 3. Authoring API

### 3.1 The `task` argument and `yield`

`TaskExec` shrinks to identity plus one message constructor. It returns tagged
JSON and does no I/O, so it is replay-safe in a workflow body.

```ts
interface TaskExec {
  readonly taskId: string;
  postMessage(message: string): TaskMessage;
}
```

A background body may `yield` two kinds of value:

| form                          | parent                               | use                                    |
| ----------------------------- | ------------------------------------ | -------------------------------------- |
| `yield value` (untagged)      | not woken; streamed as progress      | transient progress                     |
| `yield task.postMessage(msg)` | woken with `msg` as the turn's input | something the parent should act on now |

Ordinary yields from authored background tools become stream-only progress.
Subagent update delivery stays unchanged. `postMessage` sends one message
attributed to the task under the existing task-delivery policy.

The model receives `{ status: "working", taskId }` after task admission.
Workflow-local bindings carry the data needed after a durable wait; replay
reconstructs them from recorded steps and events. No separate authored task
snapshot is needed to resume the body.

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

**Provider authorization** is the change. `getToken`/`requireAuth`
throw in a workflow body. Passing the context directly into a step installs
requester-scoped auth there. Contract:

- Both are callable inside a `"use step"` that received `ctx` as a direct argument. They resolve
  under the session identity in the run's serialized context, through the
  shared authorization capability (`runtime/authorization-context.ts`). Ordinary tools and
  workflow steps use the same `getToken`/`requireAuth` implementation. Connection search and
  discovered connection tools use its underlying scoped execution for callback completion,
  challenges, and rejection after sign-in. The step adapter reconstructs the capability under that identity;
  the workflow body retains throwing implementations.
- The auth capability returns a shared authorization signal. The executing runtime supplies
  the callback hook and owns suspension/resumption; the auth implementation does not choose
  between an agent turn and an authored workflow. Interactive providers without a callback
  address fail instead of leaving the model to improvise a sign-in flow.
- A token is returned to the step and never enters the body's replay log.
- Interactive authorization does not return an `AuthorizationSignal` to the
  model. The workflow forwards the challenge through its owner's existing
  `authorization-request` message; the task moves to `input_required` and the
  parent channel renders `authorization.required`. The callback resumes the
  workflow's hook and retries the interrupted step. To the body this is one
  `await`; side effects before authorization must be safe to retry.
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
  async execute(input, ctx) {
    "use workflow";

    const events = createWebhook(); // registered before the task exists
    const devbox = await createDevboxTask(input, events.url, ctx); // step

    try {
      for await (const request of events) {
        const change = parseTaskStateChange(await request.json());
        if (change === null || change.taskId !== devbox.taskId) continue;

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

## 4. Task messages

### 4.1 Delivery

`postMessage` is not a task command and does not touch the view. It is the
parent-session `send` the child workflow already issues for updates
(`wakeTaskUpdateParentStep`), carrying the author's message attributed to the
task instead of the framework's `Background task … update:` prose, deduplicated
by the same delivery id. The receiving turn runs under the existing
task-delivery policy.

Use one `TaskInboundMessage` contract for parent-bound traffic, subsuming
`TaskInboundUpdate` rather than keeping separate message and update queues.
Subagent updates retain their formatting and delivery policy. `TaskProgress`
remains the stream-only contract. The shared delivery path must preserve
deduplication ids, buffer messages until dispatch acknowledgement, and drain
persisted reports before task completion.

### 4.2 Wiring

- `runBody` already sends each yield as a `RunReport`. The owner maps
  `TaskMessage` → parent `send`, untagged → progress on the stream. Subagent
  reports retain their parent wakes through the shared message path.
- `createWorkflowToolBackgroundExecute` returns `{ status: "working", taskId }` after task admission. It never waits for a body yield.
- The `"Background tools cannot return AsyncIterable"` guard goes; the
  ordinary background executor iterates the body, routes progress and messages,
  and completes with the return value.
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
capabilities by cell: `task` is available only for background execution, and
`ask` requires a workflow body.

## 6. Removed

From the public `TaskExec`: `delegated()` and `TaskExecutorBinding` (a tool
parks on the external system from a workflow body instead of handing off by
sentinel; the seam stays internal), `send()` (not restart-safe by its own
contract; dominated by `yield`), `binding` (the framework callback wire stops
being reachable from authored code), `session` (use `ctx.session`), and `task`
(the durable task internals remain framework-owned).

Pre-1.0: no shim. The only known external consumer is the Devbox bridge; §3.3
is its replacement. The `agent-background-tools/export.ts` fixture is rewritten
as a workflow body.

Extension manifests requiring removed delegation contracts are rejected before
their code runs. Keep the historical contract fixtures immutable, but compile
only the versions still declared supported.

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
- Workflow-local values survive durable waits through replay; there is no
  authored `TaskView.state` snapshot.
- A fixed `{ status: "working", taskId }` receipt is observed exactly once and
  never depends on a body yield.
- A token never enters a workflow body's replay log.
- Subagent task behaviour is unchanged.

## 9. Deferred

- Structured `ask` responses (a response schema instead of
  `{ optionId?, text? }`).
- Externally readable authored task snapshots, pending a concrete consumer.

## 10. Testing

- Unit: message descriptor tagging; `defineTool` overload typing via
  `expectTypeOf`.
- Integration: ordinary yields remain silent; `postMessage` → parent `send`;
  receipt independent of body yields; local values remain usable after a
  durable wait; `getToken` in a
  step of a background run resolves under the session identity; a step-raised
  authorization requirement parks the task `input_required` and resumes on
  callback; `getToken` in the body still throws.
- Scenario: compiled `shape` for each cell.
- E2E: rewrite `agent-background-tools/export.ts` as a workflow body that
  parks on `createWebhook`, posts a message on callback, and
  completes. Add a body that parks on `ask` from a background run. Sign-in
  cannot be driven in e2e; it stays at integration tier.
