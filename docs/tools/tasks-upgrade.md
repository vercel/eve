---
title: "Upgrade to Tasks"
description: "Move workflow tools, agent calls, clients, hooks, and evals from background tasks to tasks."
url: /tools/tasks-upgrade
---

This release replaces background tasks with [tasks](/docs/tools/tasks). Every change below breaks
the previous API. Work through the sections that apply to your agent. A workflow tool that uses
none of `execution: "background"`, `dismissible`, or `ctx.agent` keeps its code: `execute(input,
ctx)` keeps its signature, and `ctx.abortSignal` and `ctx.callId` are where they were. One behavior
changes for every `execute` tool: a steering message now aborts its `ctx.abortSignal`. See
[Drop `dismissible`](#drop-dismissible-a-new-message-stops-an-execute-call).
Type-checking flags most of the code changes, such as the removed `execution` and `dismissible`
options and the old `ctx.agent` call.

## Replace `execution: "background"` with `task(input, ctx)`

Rename `execute` to `task` and remove `execution`. The body doesn't change:

```diff
 export default defineWorkflowTool({
   description: "Deploy a service.",
   inputSchema: z.object({ service: z.string() }),
-  execution: "background",
-  async execute({ service }, ctx) {
+  async task({ service }, ctx) {
     "use workflow";
     return await deploy(service, ctx.abortSignal);
   },
 });
```

`defineWorkflowTool` rejects `execution` with
`"execution" was replaced by task(). Define task(input, ctx) to run each call as a task.` A
`task` body gets the same `WorkflowToolContext` as an `execute` body, and steering never aborts a
task's `abortSignal`. An `execute` tool is an ordinary tool call: the turn waits for its result. See
[Choose how a call runs](/docs/tools/tasks#choose-how-a-call-runs).

A tool that the model should be able to send more input while it works, such as a plan it revises
on request, defines [`serve(receive, ctx)`](/docs/tools/workflows#resumable-tasks-serve) instead.

## Drop `dismissible`: a new message stops an `execute` call

`ctx.ask` no longer accepts `dismissible`. A steering message now aborts the `ctx.abortSignal` of
each `execute` call the turn waits on, which withdraws every question the call asked, as
`dismissible: true` did:

```diff
-const answer = await ctx.ask({ prompt, dismissible: true });
+const answer = await ctx.ask({ prompt });
```

To keep a question open through new messages, ask it from a
[`task`](#replace-execution-background-with-taskinput-ctx) instead. Other work that
receives `ctx.abortSignal`, such as a step or a `ctx.agent` send, stops too. The call settles with
what the body returns, or with `{ interrupted: true }` if the body rejects, and the model reads the
message next.

A withdrawn question resolves as `{ status: "cancelled" }` instead of `dismissed`, and the
`input.resolved` outcome `"dismissed"` is now `"cancelled"`. Update clients and channels that
match on the old value. See [Pass signals to the work](/docs/tools/tasks#pass-signals-to-the-work).

## Open agent sessions with `ctx.agent(name)`

`ctx.agent(name, { message, agentId })`, which returned the agent's output, is now
`ctx.agent(name)`, which returns a session. Send a message and read the turn's result:

```diff
-const review = await ctx.agent("reviewer", { message: plan });
+const response = await ctx.agent("reviewer").send(plan, { signal: ctx.abortSignal });
+const { message: review, status } = await response.result();
+if (status === "failed") throw new Error("The review failed.");
```

`agentId` is removed. Each `ctx.agent(name)` call returns a new session, and later `send` calls on
the same handle continue its conversation until the workflow run finishes. See
[Delegate work](/docs/tools/workflows#delegate-work-ctxagent). The `workflow` tool's generated
programs keep their `ctx.agent(name, { message, outputSchema? })` capability.

## Continue agents by `taskId`

Every agent tool is now a `serve` tool, so every agent call is a resumable task. The model's agent
tools take `taskId` instead of `agentId`:

```diff
-{ "message": "Check the Q2 numbers too.", "agentId": "…" }
+{ "message": "Check the Q2 numbers too.", "taskId": "researcher-7k2m9q" }
```

An agent call returns a receipt at once, and the agent's reply arrives later in a `task.result`
message. Update instructions, prompts, and evals that mention `agentId` or expect the reply as
the tool result. `agentRouter()` and the `workflow` tool now run each call as a task too.

The removed codes `AGENT_BUSY`, `AGENT_MISMATCH`, `AGENT_UNREACHABLE`, and
`AGENT_INVOCATION_NOT_ADMITTED` have no replacement. A `taskId` that names no unfinished task of
that tool fails with `UNKNOWN_TASK`, and a call past the limit of 32 working tasks fails with
`TOO_MANY_TASKS`.

## Remove background delivery options

Results reach the model one way: a `task.result` message at a step boundary. Remove these:

- `taskDeliveryPolicy` and delivery cohorts.
- The `tasks` option of `session.cancel()`. `session.cancel()` now cancels the turn, the `execute`
  calls it waits on, and every working task; it still accepts `turnId` and `signal`.

The model no longer sees `[Task state]` or `[Agents]` notes, prose task notifications,
`<eve-empty-delivery/>`, or result turns. A `[Tasks]` note lists its working and idle tasks
instead. The `BACKGROUND_TASK_FAILED` and `BACKGROUND_TASK_CANCELLED` codes are removed; a
failed task reports its error in `task.settled` and in its `task.result` block.

## Read task events instead of `subagent.*` events

The `subagent.called`, `subagent.started`, `subagent.completed`, and `subagent.event` events are
removed. Use these instead:

| Event           | Replaces             | Data                                                                             |
| --------------- | -------------------- | -------------------------------------------------------------------------------- |
| `task.started`  | `subagent.called`    | `taskId`, `callId`, `turnId`, `name`, `kind`                                     |
| `task.settled`  | `subagent.completed` | `taskId`, `callId`, `turnId`, `status`, and `output` or `error` unless cancelled |
| `agent.started` | `subagent.started`   | `callId`, `turnId`, `taskId`, `name`, `sessionId`, `streamPath`                  |

Follow a child's own events, which `subagent.event` used to relay, on its stream:
`session.streamSubagent()` is now `session.agent(started).stream()`, and it takes the `agent.started` event.

```diff
 for await (const event of session.stream()) {
-  if (event.type !== "subagent.called") continue;
+  if (event.type !== "agent.started") continue;
-  for await (const childEvent of session.streamSubagent(event)) {
+  for await (const childEvent of session.agent(event).stream()) {
```

Hooks subscribe the same way:

```diff
 export default defineHook({
   events: {
-    async "subagent.completed"(event, ctx) {
+    async "task.settled"(event, ctx) {
+      if (event.data.status !== "completed") return;
```

The eval assertion `t.calledSubagent(name, { status })` keeps its API and reads task events.

## Handle open turns in clients

A turn doesn't end while tasks are working, so one turn can span a wait. The stream
reports each wait with the new `turn.waiting` event, which carries the open turn's `turnId`:

- **Held turns.** When the model ends its text while its tasks work, and when `task_wait` has no
  result yet, the stream emits `turn.waiting`. The next `step.started` for the same `turnId` means
  the turn resumed. In a root session, the text before the wait completes as a normal
  `message.completed`; in child sessions and a schedule's sessions, that step reports
  `finishReason: "tool-calls"`.
- **Questions and sign-ins inside a call no longer end the turn.** Previously, a question or
  sign-in from inside a running call, such as a workflow tool's `ctx.ask()`, `ask_question`, or a
  subagent's question, emitted `turn.completed` and `session.waiting` in the middle of the turn.
  It now emits `input.requested` or `authorization.required`, then `turn.waiting`, and the turn
  resumes under the same `turnId` after the answer. The session you answer on emits
  `input.resolved` for every question it routes an answer to. A tool approval the turn itself
  requests still ends the turn with `turn.completed` and `session.waiting`.
- **`turn.completed` comes only when the turn really ends,** and `session.waiting` always means
  the turn has ended.

The TypeScript client's `send(...).result()` reads past `turn.waiting` and returns the final reply
of a held turn, not the text written before the wait. It stops at `turn.waiting` only while a
question is pending, and returns `status: "waiting"` with that question; `respond()` then reads the
same turn to its end. A custom client that ends a response at `turn.completed` or
`session.waiting` mid-turn, or that shows the first completed message as the reply, should follow
the same rule. See [Aggregate a turn](/docs/guides/client/streaming#aggregate-a-turn).

Task results aren't stream events. Background task results used to appear as `message.received`
with `data.kind: "execution.background_task"`; `message.received` no longer has `kind`, and a task
result reaches only the model. Read each call's outcome from `task.settled` instead.

The message stream version is now 26. The TypeScript client accepts versions 21 through 26. A
client that accepts only versions up to 25 fails the stream with an unsupported-version error. See
[Turns wait for their tasks](/docs/tools/tasks#turns-wait-for-their-tasks).

## Upgrade remote agents before their callers

The remote agent protocol is now version 2. Deploy each [remote agent](/docs/guides/remote-agents)
before the deployments that call it. A remote agent on this release still serves callers on eve 0.66
through 0.68, which speak protocol 1: it runs their turns, sends each result to their callback, and
accepts their follow-up and reset requests. Questions, approvals, and sign-in requests from the
remote agent stay on its own channel, as they did before this release, and activity from a
background task's remote agent isn't relayed to the caller.

Each protocol-1 create logs a `serving a caller on deprecated eve remote agent protocol 1` warning
with the caller's origin, so you can find callers that still need to upgrade. Protocol 1 support is
deprecated and will be removed in a later release.

Upgrade a caller after every remote agent it calls. A caller on this release fails a call at start,
with an error that names both versions, when the remote agent's deployment speaks protocol 1.
