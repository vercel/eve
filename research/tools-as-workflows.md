---
issue: https://github.com/vercel/eve/issues/1084
status: implemented
last_updated: "2026-08-23"
---

# Tools as workflows

## Summary

A tool's `execute` may be a Workflow SDK workflow. eve starts one run per tool call and, by
default, waits for it: the run's return value is the tool result, however long it takes. While the
run waits on a hook, a webhook, or a sleep, the turn is parked and nothing is running. Mark the same
tool `execution: "background"` and the model gets a receipt instead; eve wakes the agent with the
return value when the run ends.

Inside the tool, everything is the Workflow SDK: `"use workflow"`, `"use step"`, `createHook`,
`createWebhook`, `sleep`, retries, replay. eve adds the two things a run needs to talk to its
session: `ctx.requestInput()` asks the human on the session's channel, and
`task.send({ kind: "update" })` sends the owning agent a note from a background run. There is no `agent/workflows/` directory, no
`eve/workflows` module, and no second durable runtime. The existing `execution: "background"`
contract is kept; a workflow body becomes its first authored executor.

This refines the earlier "authored workflows" proposal, which put workflow files under
`agent/workflows/`. The rule that eve ships no variant of the Workflow API stands. The unit is the
tool, not a workflow file.

## Authoring shape

```ts title="agent/tools/deploy.ts"
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Deploy a service to production. Pauses for a human to approve the plan.",
  inputSchema: z.object({ service: z.string() }),
  async execute({ service }, ctx) {
    "use workflow";

    const plan = await planDeploy(service);
    const answer = await ctx.requestInput({
      prompt: `Deploy ${service}?\n\n${plan.summary}`,
      display: "confirmation",
      options: [
        { id: "approve", label: "Deploy", style: "primary" },
        { id: "cancel", label: "Cancel" },
      ],
    });

    if (answer.optionId !== "approve") {
      return { deployed: false, reason: "rejected" };
    }
    return { deployed: true, url: await applyDeploy(plan) };
  },
});

async function planDeploy(service: string) {
  "use step";
  return computePlan(service);
}

async function applyDeploy(plan: DeployPlan) {
  "use step";
  return runDeploy(plan);
}
```

The model calls `deploy`. The turn parks while the human reads the plan. When they answer, minutes
or days later, the run resumes, deploys, and returns. The model sees one tool result:
`{ deployed: true, url }`.

### What is Workflow and what is eve

Workflow SDK, unchanged:

- `"use workflow"` on `execute` makes it a durable body. It is replayed, so it must be
  deterministic; side effects live in `"use step"` functions.
- `"use step"` functions may live in the tool module or any module it imports. They retry on
  failure and never re-run once their result is recorded.
- `createHook`, `createWebhook`, `sleep`, `getWritable`, `getWorkflowMetadata`, and `FatalError`
  from `workflow`; `start`, `getRun`, and `resumeHook` from `workflow/api`. Same types, same
  semantics, same version eve builds and runs.

eve:

- Starts exactly one run per tool call, keyed by session, turn, and call id. A retried harness
  step never starts a second run.
- Awaits the run, or returns a receipt when `execution: "background"`.
- Provides `ctx` inside the body.
- Bridges run and session: `ctx.requestInput()` and `task.send()`.
- Maps run status onto the tool call: completed is the result, failed is a tool error, cancelled is
  a cancelled call.

### `ctx` in a workflow body

`ctx` is the same `ToolContext` type. Inside the body it carries `session`, `callId`, `toolName`,
and `requestInput`, which is a step. The members that need the turn's process — `abortSignal`,
`getSandbox`, `getSkill`, `getToken`, `requireAuth` — throw when touched, naming the member and
what to do instead. Cancellation is run cancellation: the body stops at its next await, and a step
that is already running finishes with its result discarded. Credentials are read from the
environment inside the step that uses them; provider objects are not serializable and the turn's
authorization context does not exist in a run.

The tool's parsed input must be a JSON object, because it crosses the run's serialization boundary.
Workflow bodies are for static tools under `agent/tools/`; tools returned from `defineDynamic`
resolvers keep their callback contract.

### Wait or run in the background

|                          | default                             | `execution: "background"`                   |
| ------------------------ | ----------------------------------- | ------------------------------------------- |
| tool result              | the run's return value              | `{ status: "working", taskId }`             |
| turn while the run lives | parked                              | continues                                   |
| when the run ends        | result lands in the tool call       | agent is woken with the result or the error |
| third argument           | none                                | `task`                                      |
| cancel                   | cancelling the turn cancels the run | `task_cancel`, or the session ending        |

Wait when the model needs the answer to continue. Go background when the wait may outlive the
conversation or the user should keep talking in the meantime.

### Asking a human: `ctx.requestInput`

```ts
interface RequestInput {
  readonly prompt: string;
  readonly display?: "confirmation" | "select" | "text";
  readonly options?: readonly InputOption[];
  readonly allowFreeform?: boolean;
}

requestInput(request: RequestInput): Promise<{ optionId?: string; text?: string }>;
```

These are today's `InputRequest` fields minus `kind` and `requestId`, which eve fills. The request
is published as an `input.requested` event on the session and rendered the way channels already
render `ask_question` and tool approvals. The response resumes a hook inside the run.

- The request belongs to the run, not the turn. It stays answerable until it is answered or the run
  ends. In a background tool that means long after the turn that started it.
- Cancelling the run withdraws its pending requests.
- Several requests may be outstanding at once.
- A response never steers. A new human message while a request is pending follows the session's
  normal `turnPolicy`.

### Talking to the agent: `task.send`

Background tools receive `task` as the third argument, as they do today. Inside a workflow body:

- `task.send({ kind: "update", message })` wakes the owning agent with a framework-authored note.
  It is a step, so replay does not duplicate it. The other `send` kinds and `task.delegated()` throw:
  returning completes the task, throwing fails it, and cancellation belongs to `task_cancel`.
- `task.binding` and `task.task` carry the task's identity; `task.batch` and `task.session` are
  turn-process snapshots and throw.

A waiting tool has no `task`. The agent is blocked on the result; there is nothing to tell it.

## Flows

### Approve in the middle of the work

The shape above. The tool does enough work to show the human something concrete, asks, then
finishes or stops. Compare the existing `approval` policy, which gates the call before `execute`
runs and can only show the model's input. Both compose: `approval` before the run, `requestInput`
inside it.

### Approve with a deadline and an escalation

```ts
async execute({ service }, ctx) {
  "use workflow";

  const plan = await planDeploy(service);
  const pending = ctx.requestInput({
    prompt: `Deploy ${service}?\n\n${plan.summary}`,
    display: "confirmation",
    options: APPROVE_OR_CANCEL,
  });

  let answer = await Promise.race([pending, sleep("4h")]);
  if (answer === undefined) {
    await pageOnCall(service);
    answer = await Promise.race([pending, sleep("20h")]);
  }

  if (answer === undefined) return { deployed: false, reason: "timed out" };
  if (answer.optionId !== "approve") return { deployed: false, reason: "rejected" };
  return { deployed: true, url: await applyDeploy(plan) };
}
```

One request stays on the channel the whole time. `sleep` is the deadline, `pageOnCall` is a step,
and returning withdraws the request. No timeout option, no escalation API.

### Collect a value the model should not see

```ts
async execute({ account }, ctx) {
  "use workflow";

  const challenge = await startLogin(account);
  const code = await ctx.requestInput({
    prompt: `Enter the verification code sent to ${challenge.maskedPhone}.`,
    display: "text",
  });
  await completeLogin(challenge, code.text);
  return { connected: true };
}
```

The code travels human → run → provider. It never enters model context because the tool returns
only `{ connected: true }`.

### Wait for an external system to call back

```ts
import { createWebhook, FatalError } from "workflow";

export default defineTool({
  description: "Render a video. Returns the URL once the render farm finishes.",
  inputSchema: z.object({ projectId: z.string() }),
  async execute({ projectId }) {
    "use workflow";

    const done = createWebhook();
    const jobId = await submitRender(projectId, done.url);
    const callback = await done;
    const { status, url } = await callback.json();

    if (status !== "ok") throw new FatalError(`Render ${jobId} failed: ${status}`);
    return { url };
  },
});
```

`createWebhook` mints a URL eve serves. The external system posts to it when it is done. Nothing
runs in between.

### Poll until ready

```ts
async execute({ jobId }) {
  "use workflow";

  for (;;) {
    const job = await fetchJob(jobId);
    if (job.status === "done") return { result: job.result };
    if (job.status === "failed") throw new FatalError(job.error);
    await sleep("30s");
  }
}
```

For systems without callbacks. Each iteration is one recorded step and one durable sleep.

### Long job in the background, with progress

```ts
export default defineTool({
  description:
    "Generate the monthly report for an account. Runs in the background; you are notified when it is ready.",
  inputSchema: z.object({ accountId: z.string() }),
  execution: "background",
  async execute({ accountId }, ctx, task) {
    "use workflow";

    const sections = await listSections(accountId);
    const rendered = await Promise.all(sections.map((s) => renderSection(accountId, s)));
    await task.send({ kind: "update", message: `Rendered ${rendered.length} sections.` });
    return { url: await assemble(accountId, rendered) };
  },
});
```

The model gets `{ status: "working", taskId }` at once and keeps going. `Promise.all` over steps
fans out durably. When the run returns, the agent is woken with
`Background task task_… (generate_report) is completed.` and the result, the same notification
background tasks produce today.

### Ask now, act when answered

```ts
export default defineTool({
  description: "Request approval to refund an order, then issue the refund once approved.",
  inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
  execution: "background",
  async execute({ orderId, amount }, ctx) {
    "use workflow";

    const decision = await ctx.requestInput({
      prompt: `Refund $${amount} on order ${orderId}?`,
      display: "confirmation",
      options: [
        { id: "approve", label: "Refund", style: "primary" },
        { id: "deny", label: "Deny" },
      ],
    });

    if (decision.optionId !== "approve") return { refunded: false };
    return { refunded: true, receipt: await issueRefund(orderId, amount) };
  },
});
```

The model reports that approval is pending and the conversation continues. The approval card stays
on the channel. When it is answered, next week if need be, the refund runs and the agent is woken
with the outcome. This is the case issue #1084 describes as broken today: a response that arrives
after its turn is downgraded to text and the action never runs.

### Remind me later

```ts
export default defineTool({
  description: "Remind the user about something after a delay.",
  inputSchema: z.object({
    note: z.string(),
    delay: z.string().describe('A duration such as "20m" or "2h".'),
  }),
  execution: "background",
  async execute({ note, delay }) {
    "use workflow";
    await sleep(delay);
    return { reminder: note };
  },
});
```

The session parks between the receipt and the wake. The agent receives the return value and relays
it.

### Custom protocols

A tool that is not itself a workflow may still `start()` one and hand the model a run reference,
then expose inspect, continue, and cancel as further tools over `getRun`, `resumeHook`, and
`run.cancel()`. That is ordinary `workflow/api` use and is worked through in
authored workflows. It is the escape hatch for protocols eve does not
model, such as multi-party commands into one run. Most tools will not need it.

## Observable semantics

One call, one result. A waiting tool's call resolves once, with the return value, the error, or a
cancellation. A background tool's call resolves once, with the receipt; everything after arrives as
separate session input.

While a waiting tool runs, the turn is parked. A `queue` message waits for it. A `steer` message
cancels the turn, which cancels the run, which withdraws its requests. Input responses never steer.
Authors who want the conversation to continue use `execution: "background"`.

Background runs belong to the session. They survive turn completion and cancellation, appear in the
session's task index, can be cancelled with `task_cancel`, and are cancelled when the session ends.
Cancellation commits before the abort propagates; a late result cannot revive a cancelled task.

Errors follow the SDK. A thrown error in a step retries per the step's policy; `FatalError` does
not. An error that escapes the body fails the run: a tool error for a waiting tool, a failure
notification for a background one.

Identity follows the tool. The workflow id derives from the tool's path, so renaming or moving the
file creates a new workflow. Runs in flight finish on the deployment that started them.

Replay is the SDK's. The body must be deterministic; eve's start is idempotent per tool call; every
eve-provided `ctx` and `task` operation is a recorded step.

## What eve provides

- Accepts `"use workflow"` on `defineTool().execute` (hoisted to a top-level `async function
execute`) or on a referenced top-level function, and `"use step"` on top-level async functions in
  any application module. Module-level directives and every other placement are build errors that
  name the rewrite. Extensions keep rejecting directives. Discovery reads the syntax tree, never the
  text.
- Compiles authored modules into the existing Workflow driver bundle with the module body kept,
  eve-definer default exports dropped, and unused imports stripped, so `defineTool` and the schema
  library never enter the driver. The server bundle registers the steps and leaves `execute` as a
  stub carrying its `workflowId`; that stamp is how the harness recognizes a workflow tool. Ids derive
  from the application-relative path. `workflow` and `workflow/api` resolve to eve's vendored SDK in
  development, production, and the driver.
- Runs each call as eve's `toolRunWorkflow`, which looks the authored body up in the driver's
  workflow registry and calls it. The run's hook is its identity claim and its answer inbox: a
  replayed start loses the claim and exits. The body reports once to its owner: a `tool-result` on
  the parked turn's inbox, or `complete`/`fail` on the owning task.
- Waiting tools ride the runtime-action park: the harness records the call, the dispatch step
  starts the run and records it on the session, the turn binds the inbox result to that record,
  applies `toModelOutput`, and cancels recorded runs when the turn is cancelled.
- Background tools ride the task runtime: the run is the task's executor, so `task_cancel`, session
  end, and the task wire's input routing apply unchanged.
- `requestInput` publishes the same input-request payload a delegated child does, so channels,
  proxy routes, and answer delivery are the existing ones; answers reach the run through the session
  inbox wire, which the run's hook advertises.
- Serves the Workflow webhook route at `/.well-known/workflow/v1/webhook/:token` in every world.
- In development, the authored workflow source graph is part of the host fingerprint, so editing a
  body, a step, or a module they import rebuilds the server rather than only the module map.

## Relationship to existing plans

authored workflows proposed `agent/workflows/` and tools that `start()`
them. This keeps its stance, no eve variant of the Workflow API and Workflow runs as the durable
record, and removes the slot. Its `SessionInbox` becomes unnecessary for the common case: a
background run reaches its agent by returning or by `task.update()`. A send capability for
unrelated sessions remains an agent-to-agent concern.

[tools as tasks](./tools-as-tasks.md) defines `execution: "background"`, the receipt,
`task_cancel`, the wake policy, and one-result-per-call. All of that is unchanged here. What changes
is the executor: today a background tool must `task.delegated()` to a framework-owned executor and
`task.send` is not restart-safe; a workflow body is an authored executor with restart safety by
construction. The durable task run that plan introduces and the authored workflow run are the same
kind of thing; whether they merge is an implementation decision for that plan.

tool generators gives waiting tools preliminary results through async
iteration. A workflow body cannot be a generator. See open questions.

## Decisions made while implementing

- No new flag. Waiting tools work out of the box; `execution: "background"` keeps requiring
  `experimental.tasks`.
- Inputs are validated at start: a parsed input that is not a JSON object fails the call with a
  `TypeError` naming the tool.
- `getSandbox`, `getSkill`, `getToken`, and `requireAuth` are unavailable in the body. Steps read
  credentials from the environment.
- A run that resumes on a deployment without its tool fails with an error naming the missing
  workflow id; the tool call gets that error.
- Applications do not install the Workflow SDK. eve resolves `workflow` and `workflow/api` to its
  vendored copy everywhere authored code is bundled, and ships the types as `eve/workflow-modules`,
  an ambient declaration listed in the scaffolded tsconfig's `types`. An installed `workflow`
  package takes precedence for types if an application adds one.

## Open questions

1. Preliminary results from a waiting tool. Project a conventional stream, say
   `getWritable({ namespace: "progress" })`, onto `action.partial`, or leave progress to background
   tools and `task.send`?
2. Channel UX for a parked tool call. Channels should be able to tell "waiting on a human or an
   external system" from "computing". A tool-call status, or inference from the pending request?
3. Maximum wait. The session timeout is 30 days by default; hook and run retention have their own
   limits. What happens to a run, and its pending request, when the session expires first?
4. Authorization from a run. Connection-backed `getToken` needs the turn's authorization context;
   a run-side equivalent would have to park the run on the existing authorization callback.

## Validation

Covered by unit, integration, and scenario tests in the implementation:

- `"use workflow"` on `execute` and `"use step"` in imported modules compile in development
  (`eve dev`) and production (`eve build`); invalid placements and module-level directives fail the
  build with the rewrite named; extension modules still reject directives.
- A waiting tool runs a step and returns one result after the turn parked; a thrown error settles
  the call as a tool error; a human answer to `requestInput` resumes the body.
- Cancelling the waiting turn cancels the run and the session accepts the next message.
- A background tool returns a receipt, reports progress, and wakes the agent with its result; a
  background tool's question is answerable after its turn ended and the answer runs the rest of the
  body.
- Editing a step helper changes the development host fingerprint; editing an unrelated tool does
  not.

Not yet covered: the Vercel and custom worlds (the suites run the local world), `createWebhook`
end to end, and session expiry while a run is parked.
