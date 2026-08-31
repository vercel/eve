---
issue: https://github.com/vercel/eve/issues/1084
status: implemented
last_updated: "2026-08-31"
---

# Tools as workflows

## Summary

A tool's `execute` may be a Workflow SDK workflow. eve starts one run per tool call and, by
default, waits for it: the run's return value is the tool result, however long it takes. While the
run waits on a hook, a webhook, or a sleep, the turn is parked and nothing is running. Mark the same
tool `execution: "background"` and the model gets a receipt instead; eve wakes the agent with the
return value when the run ends.

Inside the tool, everything is the Workflow SDK: `"use workflow"`, `"use step"`, `createHook`,
`createWebhook`, `sleep`, retries, replay. eve adds two things: `ask` from `eve/workflow`, a
question the human on the session's channel answers, and `yield` from an async-generator body as a
durable progress report. There is no `agent/workflows/` directory, no eve variant of the Workflow
API, and no second durable runtime. The unit is the tool, not a workflow file.

## Authoring shape

```ts title="agent/tools/deploy.ts"
import { defineTool } from "eve/tools";
import { ask } from "eve/workflow";
import { z } from "zod";

export default defineTool({
  description: "Deploy a service to production. Pauses for a human to approve the plan.",
  inputSchema: z.object({ service: z.string() }),
  async execute({ service }, ctx) {
    "use workflow";

    const plan = await planDeploy(service);
    const answer = await ask(ctx, {
      prompt: `Deploy ${service}?\n\n${plan.summary}`,
      display: "confirmation",
      options: [
        { id: "approve", label: "Deploy", style: "primary" },
        { id: "cancel", label: "Cancel" },
      ],
    });

    if (answer.optionId !== "approve") return { deployed: false, reason: "rejected" };
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

### What is Workflow and what is eve

Workflow SDK, unchanged:

- `"use workflow"` as the first statement of `execute`, on its own line, makes it a durable body.
  eve hoists the method into a workflow function named after the tool. A top-level `async function`
  referenced as `execute: fn` works too.
- `"use step"` functions may live in the tool module or any module it imports under the application
  root. They retry on failure and never re-run once their result is recorded.
- `createHook`, `createWebhook`, `sleep`, `getWritable`, `getWorkflowMetadata`, and `FatalError`
  from `workflow` in the body; `start`, `getRun`, and `resumeHook` from `workflow/api` in steps. A
  body that calls `workflow/api` fails the build with the rule. Same types, same semantics, same
  version eve builds and runs.

eve:

- Starts exactly one run per tool call, keyed by session, turn, and call id. A retried harness
  step never starts a second run.
- Awaits the run, or returns a receipt when `execution: "background"`.
- Provides `ctx` inside the body.
- Bridges run and session: `ask` and `yield`.
- Maps the run's end onto the tool call: the return value is the result, a throw is a tool error,
  cancellation is a cancelled call.

### `ctx` in a workflow body

`ctx` is the same `ToolContext` type. Inside the body it carries `session`, `callId`, `toolName`,
and `abortSignal`. The members that need the turn's process — `getSandbox`, `getSkill`, `getToken`,
`requireAuth` — throw when touched, naming the member and what to do instead. Credentials are read
from the environment inside the step that uses them; provider objects are not serializable and the
turn's authorization context does not exist in a run.

The tool's parsed input must be a JSON object, because it crosses the run's serialization boundary.
Workflow bodies are for static tools under `agent/tools/`; tools returned from `defineDynamic`
resolvers keep their callback contract.

### Wait or run in the background

|                          | default                             | `execution: "background"`                   |
| ------------------------ | ----------------------------------- | ------------------------------------------- |
| tool result              | the run's return value              | `{ status: "working", taskId }`             |
| turn while the run lives | parked                              | continues                                   |
| when the run ends        | result lands in the tool call       | agent is woken with the result or the error |
| progress (`yield`)       | `action.partial` on the turn        | wakes the agent with a note                 |
| cancel                   | cancelling the turn cancels the run | `task_cancel`, or the session ending        |

### Asking a human: `ask`

```ts
function ask(ctx: ToolContext, request: ToolInputRequest): Hook<ToolInputResponse>;

interface ToolInputRequest {
  readonly prompt: string;
  readonly display?: "confirmation" | "select" | "text";
  readonly options?: readonly InputOption[];
  readonly allowFreeform?: boolean;
}
interface ToolInputResponse {
  readonly optionId?: string;
  readonly text?: string;
}
```

`ask` publishes the request as an `input.requested` event on the session, rendered the way channels
already render `ask_question` and tool approvals, and returns the SDK hook the answer resumes — the
way `createHook` returns one. It is synchronous on purpose: a `Hook` is thenable, so an async `ask`
would adopt it and could only ever hand back the answer. Awaiting the hook suspends the run;
`Promise.race([ask(ctx, q), sleep("4h")])` is a deadline.

- The request belongs to the run, not the turn. It stays answerable until it is answered or the run
  ends; in a background tool that means long after the turn that started it.
- A request is answered once. Ending the run withdraws its pending requests.
- Several requests may be outstanding at once.
- A response never steers. A new human message while a request is pending follows the session's
  normal `turnPolicy`.

### Reporting progress: `yield`

A body may be an async generator. Each `yield` is a durable progress snapshot; the return value is
the result, or the last `yield` when the body returns nothing. For a waiting tool a `yield` streams
as an `action.partial` event, last-write-wins by call id, never in model history. For a background
tool it wakes the owning agent with a note.

### Cancelling: `ctx.abortSignal`

Cancellation sends the run a control message. The body's `ctx.abortSignal` aborts — durably, so
steps that received it observe the abort — and the run waits up to 30 seconds for the body to
unwind through `finally`, then ends as cancelled whether or not it did. A body parked on a hook or a
`sleep` does not observe the signal and is abandoned when the grace period ends. Ending the run
withdraws its pending requests.

## Observable semantics

One call, one result. A waiting tool's call resolves once, with the return value, the error, or a
cancellation. A background tool's call resolves once, with the receipt; everything after arrives as
separate session input.

While a waiting tool runs, the turn is parked. A `queue` message waits for it. A `steer` message
cancels the turn, which cancels the run, which withdraws its requests. Input responses never steer.

Background runs belong to the session. They survive turn completion and cancellation, appear in the
session's task index, can be cancelled with `task_cancel`, and are cancelled when the session ends.

Errors follow the SDK. A thrown error in a step retries per the step's policy; `FatalError` does
not. An error that escapes the body fails the run: a tool error for a waiting tool, a failure
notification for a background one.

Identity follows the tool. The workflow id derives from the tool's application-relative path, so
renaming or moving the file creates a new workflow. Runs in flight finish on the deployment that
started them; a run that resumes on a deployment without its tool fails with an error naming the
missing workflow id.

In development, editing a body, a step, or a module they import rebuilds the server, not only the
module map: those sources are compiled into the workflow driver and the step registry.

## Boundaries

```
turn / task (owner)                          tool run
  inbox hook ──────── starts ───────────────▶ toolRunWorkflow(execute)
  <inbox>:report  ◀── yield ─────────────────   body
  <inbox>:request ◀── ask (replyTo = answer) ─   body
  <inbox>:outcome ◀── return / throw / cancel   body
  answer hook     ─── input response ────────▶ ask's hook
  run's own hook  ─── cancel ────────────────▶ ctx.abortSignal
```

The owner — the parked turn or the owning task — creates three hooks derived from its inbox token
and passes their tokens to every run it starts. A run's own hook is its identity claim (a replayed
start loses the claim and exits) and its control inbox. Each `ask` creates a fresh answer hook whose
token the owner routes the human's response to directly. These tokens and message shapes are
framework-internal; the authoring surface is `ask`, `yield`, and `ctx.abortSignal`.

Directive discovery reads the syntax tree. Authored modules are compiled into the existing Workflow
driver bundle with the module body kept, eve-definer default exports dropped, and unused imports
stripped, so `defineTool` and the schema library never enter the driver. The server bundle registers
the steps and leaves `execute` as a stub carrying its `workflowId`; that stamp is how the harness
recognizes a workflow tool.

## Decisions made while implementing

- No new flag. Waiting tools work out of the box; `execution: "background"` keeps requiring
  `experimental.tasks`.
- Inputs are validated at start: a parsed input that is not a JSON object fails the call with a
  `TypeError` naming the tool.
- `ask` returns the hook rather than a promise of the answer, so deadlines are `Promise.race` with
  the SDK's `sleep` and no timeout option exists. A standing question — one card answered
  repeatedly — is not supported: the channel request is retired on its first answer.
- `workflow/api` keeps its SDK meaning and runs in steps; a body that calls it fails the driver
  build. An earlier draft aliased it to step wrappers inside the body, which made `start` return a
  run id where the types promised a `Run`.
- Applications do not install the Workflow SDK. eve resolves `workflow` and `workflow/api` to its
  vendored copy everywhere authored code is bundled, and ships the types as `eve/workflow-modules`,
  an ambient declaration listed in the scaffolded tsconfig's `types`. An installed `workflow`
  package takes precedence for types if an application adds one.
- The run-to-owner protocol (three owner hooks, `RunRef`, message shapes) stayed internal. Nothing
  authored needs to construct those messages.

## Open questions

1. Channel UX for a parked tool call. Channels should be able to tell "waiting on a human or an
   external system" from "computing". A tool-call status, or inference from the pending request?
2. Maximum wait. The session timeout is 30 days by default; hook and run retention have their own
   limits. What happens to a run, and its pending request, when the session expires first?
3. Authorization from a run. Connection-backed `getToken` needs the turn's authorization context;
   a run-side equivalent would have to park the run on the existing authorization callback.
4. Standing questions. Keeping a request answerable until the run ends would let `for await` over
   `ask`'s hook work; it needs the owner to keep the route and channels to keep the card live.

## Validation

Unit, integration, and scenario tests cover: directive placement and module-level rejection in
`eve dev` and `eve build`; a waiting tool parking the turn and returning one result; a thrown error
as a tool error; a human answer resuming the body; a deadline winning a race against an unanswered
`ask`; cancelling the waiting turn cancelling the run; a background tool's receipt, progress, and
completion wake; a background question answered after its turn ended; and the development host
fingerprint following step helpers. The `agent-workflow-tools` e2e fixture runs the same flows
through the CLI with a mock model.

Not yet covered: the Vercel and custom worlds (the suites run the local world), `createWebhook`
end to end, and session expiry while a run is parked.
