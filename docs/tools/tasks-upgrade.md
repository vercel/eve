---
title: "Upgrade to Tasks"
description: "Move workflow tools, agent calls, clients, hooks, and evals from background tasks to tasks."
url: /tools/tasks-upgrade
---

This release replaces background tasks with [tasks](/docs/tools/tasks). Every change below breaks
the previous API. Work through the sections that apply to your agent. A workflow tool that uses
none of `execution: "background"`, `dismissible`, or `ctx.agent` doesn't change: `execute(input,
ctx)` keeps its signature, and `ctx.abortSignal` and `ctx.callId` are where they were.
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
`task` body's context, `WorkflowTaskContext`, has no `interruptSignal`, because steering never
interrupts a task. An `execute` tool is an ordinary tool call: the turn waits for its result. See
[Choose how a call runs](/docs/tools/tasks#choose-how-a-call-runs).

A tool that the model should be able to send more input while it works, such as a plan it revises
on request, defines [`serve(receive, ctx)`](/docs/tools/workflows#resumable-tasks-serve) instead.

## Pass `ctx.interruptSignal` instead of `dismissible`

`ctx.ask` no longer accepts `dismissible`. To withdraw a question when the conversation moves on,
pass the call's `interruptSignal` as `signal`:

```diff
-const answer = await ctx.ask({ prompt, dismissible: true });
+const answer = await ctx.ask({ prompt }, { signal: ctx.interruptSignal });
```

A withdrawn question resolves as `{ status: "cancelled" }` instead of `dismissed`, and the
`input.resolved` outcome `"dismissed"` is now `"cancelled"`. Update clients and channels that
match on the old value. Only an `execute` body has `ctx.interruptSignal`; see
[Pass signals to the work](/docs/tools/tasks#pass-signals-to-the-work).

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
`AGENT_INVOCATION_NOT_ADMITTED` have no replacement. A `taskId` that names no task available to
the caller fails with `UNKNOWN_TASK`, and a call past the limit of 32 working tasks fails with
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

| Event           | Replaces             | Data                                                  |
| --------------- | -------------------- | ----------------------------------------------------- |
| `task.started`  | `subagent.called`    | `taskId`, `callId`, `turnId`, `name`                  |
| `task.settled`  | `subagent.completed` | `taskId`, `callId`, `status`, and `output` or `error` |
| `agent.started` | `subagent.started`   | `callId`, `name`, `sessionId`, `streamPath`           |

Follow a child's own events, which `subagent.event` used to relay, on its stream:
`session.streamSubagent()` now takes the `agent.started` event.

```diff
 for await (const event of session.stream()) {
-  if (event.type !== "subagent.called") continue;
+  if (event.type !== "agent.started") continue;
   for await (const childEvent of session.streamSubagent(event)) {
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

## Handle held turns in clients

A turn doesn't end while tasks it started are working, so one turn can span a wait:

- In a root session, the model's text before the wait completes as a normal `message.completed`,
  followed by `session.waiting` with the held `turnId`. A `session.waiting` event without `turnId`
  still marks the end of a turn.
- `turn.completed` comes only when the turn really ends.
- In child sessions and a schedule's sessions, the held text step reports
  `finishReason: "tool-calls"`.

The message stream version is now 26. The TypeScript client accepts versions 21 through 26, and
its `send(...).result()` and `isCurrentTurnBoundaryEvent` already account for held turns. A client
that treats every `session.waiting` as the end of a turn must check `turnId`, and a client that
accepts only versions up to 25 fails the stream with an unsupported-version error. See
[Turns wait for their tasks](/docs/tools/tasks#turns-wait-for-their-tasks).

## Upgrade remote agents together

The remote agent protocol is now version 2. Upgrade the calling deployment and every
[remote agent](/docs/guides/remote-agents) it calls to this release together; a mismatch fails the
call at start with an error that names both versions.
