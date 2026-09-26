---
issue: https://github.com/vercel/eve/issues/1084
status: draft
last_updated: "2026-09-26"
---

# eve tasks

This plan replaces background tasks as shipped in eve 0.66 with one task model. It specifies the
authoring API, the model's tools, and the observable semantics, then the runtime invariants and a
stack of pull requests that lands it in pieces. Paths are relative to `packages/eve/src/`.

## Summary

1. **A workflow tool defines exactly one entry point.** `execute(input, ctx)` is an ordinary tool
   call, as on `main`: the turn parks durably until the call settles, and its result is the tool
   result.
2. **`task(input, ctx)` runs each call as a task.** A task returns a receipt at once and keeps
   working while the conversation continues.
3. **`serve(receive, ctx)` runs a resumable task.** It gets each call from `receive()`,
   including later calls the model sends by `taskId`, and settles them with `ctx.reply()`. Every
   agent tool is a `serve` tool built on `ctx.agent`.
4. **Steering never cancels a task.** A new message ends the model's waits, and an `execute` call
   the turn is waiting on learns about it through `ctx.interruptSignal`. Tasks stop only for
   `task_cancel`, `session.cancel()`, or session end.
5. **Results arrive one way:** a `task.result` message at a step boundary. The model gets
   `task_wait`, which parks the turn until a task settles, and `task_cancel`.
6. **No turn ends while its tasks are working.** If the model tries, eve waits as if it had called
   `task_wait`, so every result arrives in the turn that started the work.
7. **eve is built on eve.** `sleep`, `ask_question`, `agentRouter()`, the `workflow` program tool,
   and every agent tool use only public API.

This follows Codex's multi-agent v2 (`openai/codex` `9ef08dc`): the wait only wakes the model, and
content arrives through the inbox at step boundaries. Unlike Codex, eve holds a turn open while
its tasks work, because scheduled, child, MCP, and eval sessions have no later user message to
collect results.

**Baseline.** This plan builds on #3817 (no run mode) and #3700 (answers come only from people),
both on `main`. Every session parks after each settled turn, `capabilities.requestInput` is the
only gate on asking a person, and `outputSchema` is a per-turn option only callers request,
through the session API and `ctx.agent`; agent definitions and the model can't set it.

## Vocabulary

One word per concept, used the same way in the API, docs, model text, events, and errors.

- **Call:** one invocation of a tool by the model, with its own `callId`.
- **Task:** a call that returns a receipt at once and keeps working while the conversation
  continues: every agent call, and every call to a `task()` or `serve()` tool.
- **Receipt:** a task call's immediate tool result, naming its `taskId`.
- **Resumable task:** a task defined with `serve()`, which accepts more calls with its `taskId`.
  Between results it is idle: available, but not working.
- **Result:** one call's outcome, `completed`, `failed`, or `cancelled`, delivered once.
- **Steering:** a `turnPolicy: "steer"` message from the turn's own principal arriving during a
  turn.

## 1. Workflow tools

A workflow tool defines exactly one of three entry points, and the entry point decides how its
calls run. Each entry point is run by the call that starts it: every `execute` or `task` call runs
its own body, and a `serve` body runs once per task and gets later calls through `receive()`.

```ts
defineWorkflowTool({
  description: "Deploy a service.",
  inputSchema: z.object({ service: z.string() }),
  async task(input, ctx) {
    "use workflow";
    return await deploy(input.service, { signal: ctx.abortSignal }); // the task's result
  },
});
```

- **`execute(input, ctx)`** is an ordinary tool call, exactly as on `main` and like
  `defineTool`'s `execute`: the turn parks durably until the call settles, and its result is the
  tool result. Its context, `WorkflowToolContext`, has `callId`, `abortSignal`, and
  `interruptSignal` (§2).
- **`task(input, ctx)`** runs the call as a task: a receipt now, the result later as a
  `task.result` message. Its context, `WorkflowTaskContext`, has `callId` and `abortSignal`, and
  no `interruptSignal`, because tasks are never interrupted.
- **`serve(receive, ctx)`** runs a resumable task (§3). `receive()` resolves each call with its
  own `callId` and `abortSignal`, and the context, `WorkflowServeContext`, has `reply(output)`
  and no `interruptSignal`.
- All three contexts share `ask`, `agent`, `agents`, `getToken`, `requireAuth`, and `session`.
- In `execute` and `task`, `return output` settles the call and a throw fails it. `async *execute`
  and `async *task` still yield progress as `action.partial`.

Defining none of the three, or more than one, fails at definition, where `{found}` is `none` or
the entry points defined, such as `execute and task`:

```text
Define exactly one of execute(input, ctx), task(input, ctx), or serve(receive, ctx); this tool
defines {found}.
```

**Tool calls and tasks.** The entry point answers whether the conversation should continue while
the call runs. Parking alone doesn't need a task: a question, a sleep, or an approval parks
durably inside an `execute` call and holds no compute. A twenty-minute deploy, or research the
model may not need right away, is a task. A long `execute` tool holds the conversation until it
settles; the docs say so where `task()` is introduced.

| Call                                                                     | Runs as                   | Result                                            | Steering during the call                      |
| ------------------------------------------------------------------------ | ------------------------- | ------------------------------------------------- | --------------------------------------------- |
| `execute()` tool, including `sleep` and `ask_question`                   | Tool call; the turn parks | The tool result                                   | Its `interruptSignal` fires; the call decides |
| `task()` tool, including `agentRouter()` and the `workflow` program tool | Task                      | A receipt, then a `task.result` message           | Nothing                                       |
| `serve()` tool, including every agent tool                               | Resumable task            | A receipt, then a `task.result` message per reply | Nothing                                       |
| `task_wait`                                                              | Kernel wait               | Which tasks settled                               | Returns `interrupt`                           |
| Plain and MCP tools                                                      | Inside the model step     | The tool result                                   | Applied at the next step boundary             |

**Agents are always `serve` tasks.** Whether an agent's result is needed now depends on the
conversation, which only the model sees, and the turn rule (§6) guarantees the result reaches it.
An ordering that must always hold, such as "publish only after the review", is a workflow tool
that runs the review through `ctx.agent` and then acts, with the side effect not exposed as a
separate tool.

## 2. Steering and cancellation

Steering is applied in this order:

1. If the message answers a pending request, it answers it and doesn't steer. Only a person's
   message to the session they're talking to can answer, as on `main` after #3700; a caller's
   message, such as an agent tool's message to its child, never does.
2. Otherwise, the `interruptSignal` of every `execute` call the turn is waiting on fires, and
   `task_wait` returns `interrupt`. Tasks are untouched. The model sees the message once the
   step's `execute` calls settle, and decides whether to keep, correct, or cancel each task.

Steering never ends the turn. A `"queue"` message waits for the turn to end.

**`ctx.interruptSignal`** fires once, on the first steering message while the turn waits on the
call; later messages are applied after the call settles anyway. What it means is the author's
choice. A body that ignores it keeps going: a deploy waiting on an approval survives unrelated
messages. A body that wants to stop races or passes the signal. Tasks are never interrupted, so
`task` and `serve` have no `interruptSignal`.

**Anything that waits takes a `signal`.** `ctx.ask(request, { signal })` withdraws the request
when the signal aborts: it resolves `{ status: "cancelled" }`, and `input.resolved` reports
`outcome: "cancelled"` so channels update the question. Cancellation withdraws a pending ask the
same way. An ask that should end when the conversation moves on passes `ctx.interruptSignal`,
which replaces `dismissible`. The built-in tools do exactly this:

```ts
// ask_question, as eve ships it
async execute(input, ctx) {
  "use workflow";
  const answer = await ctx.ask(toQuestion(input), { signal: ctx.interruptSignal });
  return answer.status === "cancelled" ? { interrupted: true } : answer;
}

// sleep, as eve ships it
async execute(input, ctx) {
  "use workflow";
  const interrupted = new Promise<"interrupted">((resolve) =>
    ctx.interruptSignal.addEventListener("abort", () => resolve("interrupted"), { once: true }),
  );
  const elapsed = sleep(input.seconds * 1_000).then(() => "elapsed" as const);
  const woke = await Promise.race([elapsed, interrupted]);
  return woke === "elapsed" ? { waitedSeconds: input.seconds } : { interrupted: true };
}
```

Both render `{ interrupted: true }` as `Stopped early because a new message arrived.`

**Cancellation.**

- **`session.cancel()`** cancels the turn, the `execute` calls it is waiting on, and every
  working task. Its `tasks` option is removed; `turnId` and `signal` stay.
- **`task_cancel({ taskId })`** cancels one task's current work and returns
  `{ status: "cancelled" | "already_finished" }`.
- **Session end** ends every task.

Cancelled work never reports back. A `task()` task is then finished. A `serve()` task stays
available if its body catches the abort (§3): its waiting calls settle as `cancelled`, their
`abortSignal` aborts, and the task becomes idle. For an agent, that cancels the agent's turn and
keeps its conversation.

## 3. Resumable tasks: `serve`

```ts
defineWorkflowTool({
  description: "Draft a release plan and revise it on request.",
  inputSchema: z.object({ request: z.string() }),
  async serve(receive, ctx) {
    "use workflow";
    let plan: Plan | undefined;
    for (;;) {
      const { input, abortSignal } = await receive(); // the first call, then each by taskId
      try {
        plan = await revise(plan, input.request, { signal: abortSignal });
        ctx.reply(plan); // a result; the task stays available
      } catch (error) {
        if (!abortSignal.aborted) throw error; // cancelled: wait for the next call
      }
    }
  },
});
```

A `serve` body runs once per task and gets its calls from `receive()` instead of taking an input:

- **`receive()`** resolves with the next call, `{ input, callId, abortSignal }`, with `input`
  validated by `inputSchema`. The first `receive()` resolves in memory from the call that started
  the task, with no step or hook. After that, it resolves with each call made with the task's
  `taskId`, in arrival order. Calls that arrive while the body isn't waiting are kept. A pending
  `receive()` is shared: calling it again returns the same promise, so a `Promise.race` it loses
  never drops a call.
- **`ctx.reply(output)`** settles the calls received so far with `output`, and the task goes idle
  until the next call. A reply with no call left to settle is dropped, and `ctx.ask` throws while
  no call is waiting for a result.
- **`return output`** settles the calls still waiting and ends the task; throwing fails them.
  `serve` is not a generator, so it can't yield progress for now.
- **`taskId` on the model input.** eve adds an optional `taskId` to the tool's model input.
  Without it, a call starts a new task; with it, the call goes to that task. The build fails if
  `inputSchema` declares its own `taskId`. The ID must name an unfinished task this tool started
  for the caller's principal, or the call fails `UNKNOWN_TASK`.
- **One `abortSignal` per stretch of work.** A stretch starts when a call reaches an idle task and
  ends when a reply or a cancel settles its calls; calls that arrive during it carry the same
  signal. Each signal aborts at most once and the next stretch gets a new one, so a task can be
  cancelled any number of times. A body stays available only if it catches its stretch's abort
  and returns to `receive()`; an abort that escapes the body finishes the task. A body that ignores
  the signal keeps working, and its reply is dropped.
- **Working and idle.** A resumable task is working while one of its calls has no result, and
  idle otherwise. An idle task holds no turn and doesn't count toward the cap.
- **Finishing.** The task finishes when its body returns or throws, or when the session ends,
  which aborts the current stretch's signal and rejects a pending `receive()`.
- eve appends this sentence to the tool's description:

```text
To send this task more input, call this tool again with its taskId; without taskId, each call
starts a new task.
```

## 4. Agents

**`ctx.agent(name)`** returns a handle to a child session owned by the run, shaped like the
TypeScript client's session. The child opens on the first `send`.

```ts
const agent = ctx.agent("researcher");
const response = await agent.send("Find the incidents behind the March outage.", {
  outputSchema, // optional, per turn, as on the client
  signal, // optional; aborting cancels this turn
});
const { data, message, status } = await response.result();
```

- `send` delivers a caller's message. If the agent's turn is running, the message joins it and its
  response resolves with that turn's result; if the agent is idle, it starts the next turn.
- `result()` returns the client's `MessageResult` fields `data`, `message`, and `status`. The
  agent's events stay on its own stream.
- Nothing about opening, sending to, or settling the session passes through the parent session.
  A person still answers the agent's questions and sign-ins at the root, through the owner chain
  (§7). The model can't address these sessions; it sees what the body returns or replies.
- A run's sessions end when the run finishes, cancelling any turn still running.

**Agent tools.** Every agent is a tool named after it, with model input
`{ message: string; taskId?: string }`. It is a `serve` tool that forwards each call to one
session, as eve ships it:

```ts
async serve(receive, ctx) {
  "use workflow";
  const agent = ctx.agent(name);
  // A cancel aborts the call's abortSignal, which ends the agent's turn.
  const send = ({ input, abortSignal }: Awaited<ReturnType<typeof receive>>) =>
    agent
      .send(input.message, { signal: abortSignal })
      .then((response) => response.result());
  let latest = send(await receive());
  for (;;) {
    const event = await Promise.race([
      latest.then((result) => ({ result })),
      receive().then((next) => ({ next })),
    ]);
    if ("next" in event) {
      latest = send(event.next); // joins the running turn, or starts the next if it just ended
      continue;
    }
    if (event.result.status === "failed") throw new Error("The agent's session ended.");
    ctx.reply(toOutput(event.result)); // settles the calls received so far; dropped after a cancel
    latest = send(await receive());
  }
}
```

- **No `outputSchema` from the model.** As on `main` after #3817, structured output is a
  caller's per-turn choice through `send`; the model's agent tools and `agentRouter()` don't
  offer it.
- **One result per agent turn:** the turn's final response. A message that joined the turn is
  settled by the same reply.
- The tool description is the agent's `description` followed by:

```text
It does not see this conversation, so put everything it needs in message. To correct or continue
an agent task, call this tool again with its taskId; without taskId, each call starts a new agent.
```

## 5. The model's view

```ts
task_wait({ timeout?: number })   // parks the turn until any of its tasks settles; ms
task_cancel({ taskId: string })   // → { status: "cancelled" | "already_finished" }
```

Both are offered, with the system block below, when the agent has an agent or a `task()` or
`serve()` tool.
All model text is a draft, tuned with real-model evals.

**`task_wait`** returns when any task the turn's principal started settles, when `timeout`
passes, or when steering arrives, and at once if a result is already waiting. It never returns
content; the settled results follow as the `task.result` message in the same step. Waiting never
stops a task, and a task waiting on a person keeps the wait going.

```text
Wait until one of your tasks has a result, a new message arrives, or timeout (in milliseconds)
passes. Results arrive in a <task_result> message right after this call returns. Waiting never
stops a task. Omit timeout to wait until a result or a message arrives; a timeout of 0 returns
at once with any results that are ready.
```

```ts
type TaskWaitResult =
  | { status: "settled"; settled: string[]; working: string[] } // both empty: nothing was working
  | { status: "timeout" | "interrupt"; working: string[] };
```

`settled` lists the tasks whose results follow, failed ones included; cancelled work never wakes
a wait. The model gets text:

```text
d0-2b0c1a completed; its result follows. 1 task is still working: sre-9x1k2p.

Stopped waiting after 5m; 2 tasks are still working. Their results arrive before your turn
ends; wait again only if you need them now.

A new message arrived, so the wait ended after 40s; 2 tasks are still working. Read the message,
answer it if it asks you something, and decide whether it changes this work: keep the tasks, call
an agent again with its taskId to correct it, or stop a task with task_cancel.

No tasks are working.
```

**`task.result` message.** The one way results reach the model: a user-role message of kind
`task.result` with one `<task_result>` block per result, appended at the next tool-step boundary
after a result settles, right after `task_wait` returns, or when a held turn wakes. The body is
`toModelOutput(output)` when defined, or the error message for a failed call, with
`</task_result` escaped. All results in one message share a limit of 50 KB and 2,000 lines, then
`[truncated]`.

```text
<task_result id="d0-2b0c1a" tool="d0" status="completed">…</task_result>
```

**`task_cancel`:**

```text
Stop a task's current work. That work never reports back; if it already had a result, that
result is still delivered. An agent, or any task that accepts more input, stays available: call
its tool with its taskId to give it new work.
```

**Receipts.** IDs are `<tool>-<6 base32>`.

```text
Started task researcher-7k2m9q. Call researcher again with taskId researcher-7k2m9q to send it
another message.

Started task deploy-4hd8sa.

Sent to task researcher-7k2m9q.
```

**`[Tasks]` note.** A `context.state` message appended at a model-step boundary when the listing
changes, and after compaction, so task IDs survive it. It is derived only from the session's task
table in process, never from child streams: the turn principal's working tasks with tool and
status, then its 10 most recent idle resumable tasks.

```text
[Tasks]
<tasks>
<task id="deploy-4hd8sa" tool="deploy" status="working"/>
</tasks>
<idle>
<task id="researcher-7k2m9q" tool="researcher"/>
</idle>
```

**System block.**

```text
Every subagent call and some tools start a task and return its id right away; the task keeps
working while you continue. Results arrive in <task_result> messages. When you need a result to
continue, call task_wait; it returns when any task has a result. Start independent tasks first,
then wait. To correct or continue an agent, or any task that accepts more input, call its tool
again with its taskId. If you don't need a task's result yet, reply now instead of calling
task_wait: your turn stays open while your tasks work, and eve gives you their results when they
finish. A new message never stops your tasks: answer it if it asks you something, decide whether
it changes the work, then keep the tasks, correct an agent with taskId, or stop a task with
task_cancel. Never use sleep to wait for a task.
```

**Errors.** These are the only task error codes.

| Code             | Where                                 | Message                                                                                                                                           |
| ---------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNKNOWN_TASK`   | Call with `taskId`, `task_cancel`     | `No task "{id}" is available to {tool}: it may have ended or belong to another tool or caller. Start a new one by calling {tool} without taskId.` |
| `TOO_MANY_TASKS` | Start, call to an idle resumable task | `32 tasks are already working ({ids}). Wait with task_wait or stop one with task_cancel, then try again.`                                         |

## 6. Turns, principals, and limits

**The turn rule.** No turn ends while tasks its principal started are working, in any session.
When the model ends such a turn, eve does what `task_wait` does: it parks until one of those tasks
settles or the same principal steers, appends the settled results, and calls the model again. A
`final_output` call while tasks work returns an error naming them. No result ever starts a turn.
Session expiry and turn failures cancel the turn's tasks, as `session.cancel()` does.

**Presentation of a held turn.** A root session's held turn shows a waiting boundary: the
model's interim message completes normally, and the stream emits `session.waiting` with the held
`turnId`. A person can keep writing, and the turn resumes under the same ID. `turn.completed` is
emitted only when the turn really ends, so an MCP `agent_get` or `send().result()` sees the final
reply; this closes the gap #3817 notes for MCP `agent_start` with a delegating agent. A child turn
(its session has a caller) and a schedule's turn (`ScheduleIdKey`, `harness/tool-loop.ts`) show no
boundary: a held text step reports `finishReason: "tool-calls"`, which channels already skip, so
the run posts once. History and traces keep the model's own finish reason.

**Slack posts the text before a wait.** Channels post only on `finishReason: "stop"`, and use a
`"tool-calls"` step's text as a typing status. Slack also posts that text when the step's only
tool call is `task_wait`, so a person sees what is running ("Checking revenue and incidents now;
I'll report back.") while the turn waits. It buffers the text on `message.completed` and posts it
on the following `actions.requested` when that step's only action is `task_wait`. A step with any
other tool call keeps today's typing status, and a schedule's turn doesn't post it. There is no
option yet, and other channels are unchanged.

**Principals.** Only the turn's own principal steers it; another principal's message waits for
the turn to end, then starts that principal's turn. Calls with `taskId` and `task_cancel` accept
only the task's creator principal, and `task_wait` and `[Tasks]` cover only the turn principal's
tasks. Anonymous callers share one principal.

**No task time limits.** `defineAgent`'s `limits.sessionTimeoutMs` keeps its meaning, the
session lifetime (default 30 days), and bounds all work in the session; with `false`, tasks are
unbounded. A body that needs a limit races `sleep` against its work. A person who wants an update asks, and the model decides whether to keep
waiting or cancel.

**Cap.** At most 32 working tasks per session (`TOO_MANY_TASKS`), a worst-case backstop normal use
shouldn't reach. Idle resumable tasks don't count.

### Stream events

```ts
{ type: "task.started"; data: { taskId, callId, turnId, name } }
{ type: "task.settled"; data: { taskId, callId, status: "completed" | "failed" | "cancelled",
                                output?: JsonValue, error?: { message: string } } }
{ type: "agent.started"; data: { callId, name, sessionId, streamPath } }
```

- **`task.started` and `task.settled`** come once each per call to a task: when the call starts
  a task or reaches one by `taskId`, and when a reply, return, failure, or cancel settles it.
  `(taskId, callId)` identifies the call; `callId` is the tool call clients attach status to.
- **`agent.started`** comes once per session a workflow run opens with `ctx.agent`, including an
  agent tool's, with the `callId` of the tool call whose run opened it. Later calls to the same
  task reach the same session, which clients find through the task's first `callId`.
  `streamPath` is a local child's stream route, or the parent-origin proxy for a remote child.
- **`output`** is a completed call's typed result; **`error.message`** explains a failed one.
  There are no error codes and no usage; either can be added later without breaking anyone.

`session.streamSubagent(started)` takes an `agent.started` event and no longer checks the parent
session ID; the proxy validates the parent and call. Hooks subscribe to the new events in place
of `subagent.*`. `input.requested` and `authorization.*` gain `taskId` when a task asks. A
`task.result` message appears as `message.received` with `data.kind: "task.result"`. The eval
assertion `t.calledSubagent(name, { status })` keeps its API and reads task events.

## 7. Runtime invariants

- **One owner per task.** The session owns every task; a workflow run owns only the sessions it
  opens with `ctx.agent`, which are not tasks. One small versioned record per task, written only
  by applying the session's inbox messages (`execution/tasks/table.ts`): `id`, `name`,
  `resumable`, `status` (`working`, `idle`, or finished), the calls without a result, `turnId`,
  `delivered`, `creator` (auth captured at start), and the cancel timestamp. A record that fails
  to decode fails its task ("its state could not be read"), never the session. Sessions aren't
  migrated.
- **Every wait suspends.** The session is a durable workflow (`execution/session/entry.ts`) whose
  inbox is built on Workflow SDK hooks. `execute` calls keep today's path: the call defers out
  of the model step and the turn loop parks until it settles (`execution/session/turn.ts`,
  `waitForRuntimeActionResults`). `task_wait` and a held turn park the same way until a task
  settles, the timeout (a durable `sleep` raced against the inbox), or steering. Nothing polls.
- **First call is free.** The run's start input already carries the tool input
  (`execution/tools/workflow/body.ts`). `execute` and `task` receive it as `input`, as today, and
  a `serve` body's first `receive()` resolves from it in memory and replays deterministically.
  Only later calls to a `serve` task use the run's private hook, created with a token derived
  from `taskId` before the body starts, because a Workflow SDK hook registers only when the run
  suspends.
- **One inbox per run.** A run's signals and ask results are views over one ordered inbox, so
  when an answer and an interrupt race, they resolve in inbox order: `ask_question` gets the
  answer or `cancelled`, whichever its run's inbox received first.
- **Start once.** The model step commits the task record, with an ID assigned by the session,
  alongside the tool call; the session then starts the task's run in one step keyed on `taskId`.
  Commands issued before the run reports started are held on the record.
- **Settle once.** Runs send the session `task.input` and `task.settled`, keyed
  `(taskId, callId, kind)`; a reply sends one `task.settled` per call it settles. The first
  outcome per call wins, owner-cancelled results are dropped, and every other result is appended
  once to the next `task.result` message and marked `delivered`.
- **Calls with `taskId`.** The session checks the task is resumable, unfinished, this tool's, and
  the caller's principal's (else `UNKNOWN_TASK`), records the call, marks the task `working`,
  emits `task.started`, and resumes the task's hook with the validated input.
- **Cancel.** The session settles the waiting calls as `cancelled`, sends the run `cancel`, and
  returns at once. A `task()` run aborts its call's `abortSignal`, and one sleeper run per
  session, armed only for the earliest pending confirmation, hard-stops it after 30 s. A `serve()`
  run aborts the current stretch's signal and stays parked on its hook, so it needs no hard stop.
- **Agent sessions.** A workflow run's start input carries the caller's principal, capabilities,
  dynamic agent selections, and sandbox reference. `ctx.agent` opens its child, local or remote,
  in a step keyed on the run and the handle's position; `send` uses the child's existing deliver
  path with the run's `callId` as `caller.callId`; `result()` waits through a hook. The run
  publishes `agent.started` on the session's stream, as it publishes `action.partial`.
- **Questions go up, answers come down.** A child's `input.requested` and `authorization.*` travel
  up the owner chain to the root, where a person answers, and answers route down by request ID.
  This is the only path from a run's sessions to the session. Remote children run the same
  protocol over HTTP, with idempotent callbacks and a version check that fails the call at start
  with a message naming both versions.
- **Turn end.** The harness's terminate branch (`harness/tool-loop.ts`) returns `held` with the
  working task IDs, the turn loop waits, and the program (`execution/session/program.ts`) sends
  the caller's reply from one guarded site. The hold is keyed by principal, so a turn resumed
  after an approval or sign-in still holds on the parked turn's work.
- **Guards** (`pnpm guard:invariants`): `tools/provided/**` and generated agent tools import only
  public entry points, except the kernel's `task_wait` and `task_cancel`; only
  `execution/tasks/table*.ts` writes records; model text lives only in
  `execution/tasks/render.ts`; one caller-reply site.

## 8. Removed and changed

These are the upgrade notes; everything is breaking and allowed pre-1.0.

- **Workflow tool bodies** keep `execute(input, ctx)`, `ctx.abortSignal`, and `ctx.callId`.
- **`execution: "background"`** is replaced by defining `task(input, ctx)` in place of
  `execute`. `defineWorkflowTool` rejects `execution` with this error:

```text
"execution" was replaced by task(). Define task(input, ctx) to run each call as a task.
```

- **`ctx.agent`:** `ctx.agent(name, { message, agentId })` returning output becomes
  `ctx.agent(name)` returning a session handle. `agentId` is removed; each handle is a new child.
- **`ctx.ask`:** `dismissible` is removed; pass `ctx.interruptSignal` as `signal`. The
  `input.resolved` outcome `"dismissed"` becomes `"cancelled"`.
- **Agent tools:** `agentId` becomes `taskId`, and every agent call is a task.
- **`agentRouter()` and the `workflow` program tool** become `task()` tools instead of blocking
  calls.
- **Removed:** `taskDeliveryPolicy` and cohorts; the `[Task state]` and `[Agents]` notes, prose
  task notifications, `<eve-empty-delivery/>`, and result turns; `session.cancel()`'s `tasks`
  option; the `subagent.called`, `subagent.completed`, `subagent.started`, and `subagent.event`
  events; the `AGENT_BUSY`, `AGENT_MISMATCH`, `AGENT_UNREACHABLE`,
  `AGENT_INVOCATION_NOT_ADMITTED`, `BACKGROUND_TASK_FAILED`, and `BACKGROUND_TASK_CANCELLED`
  codes.
- **Remote agents:** the remote protocol version changes; both deployments must upgrade together.

Workflow tools that use none of `execution: "background"`, `dismissible`, or `ctx.agent` don't
change. In the repository today, this touches those that do, code reading `subagent.*` events,
the fixtures under `e2e/`, the templates and apps, and the docs pages that describe them. In
internal-agents it touches 5 files with `ctx.agent`, 39 reading `subagent.called`, 8 with
`execution: "background"`, and 7 with `dismissible`.

## 9. Delivery

The work lands as a stack of pull requests managed with `gh stack`, on top of this plan's PR.
Each PR is one coherent step from the one below it: it passes CI on its own, updates the docs and
fixtures for the behavior it changes, and carries a changeset (`minor` when it breaks a public
API). Main may lack features between PRs, never correctness. **Hold the Changesets release from
PR 1 until PR 10 merges**, so no release ships without background work and then without its
replacement.

### Implementation rules

- **One large removal, then narrow steps.** PR 1 deletes background tasks wholesale, including
  every test of them: unit, integration, scenario, and e2e. Every later PR is tight and changes
  only what its step needs; unrelated cleanup waits for its own PR.
- **The bar for each PR is a passing build.** `pnpm build`, `pnpm typecheck`, `pnpm lint`, and
  `pnpm guard:invariants` pass, and CI is green. An existing test a PR breaks is updated if it
  still describes intended behavior and deleted if it doesn't.
- **Few tests during implementation, if any.** Don't add unit tests that restate the code just
  written. Add a test only when a PR can't be trusted without one. Proper coverage comes after
  the stack lands, as e2e suites where they prove behavior end to end (§10).
- **Code quality comes first.**
  - Write readable code, not compact code: no dense one- or two-line expressions such as nested
    ternaries, chained callbacks that do several things, or clever reduces. Name each step.
  - Extract a helper function wherever a step has a name, and define explicit interfaces and
    types at module boundaries: task records, inbox commands, the received call, and agent
    session handles.
  - Keep related code together: the task kernel under `execution/tasks/`, its model text in one
    renderer, and public types beside the definitions they describe.
  - Follow `AGENTS.md`: keep it simple, comment why rather than what, add no legacy fallbacks,
    and wrap third-party APIs.

| #   | PR                            | Main after it lands                                             |
| --- | ----------------------------- | --------------------------------------------------------------- |
| 1   | Remove background tasks       | Every workflow tool and agent call blocks                       |
| 2   | Workflow tool body (dropped)  | Nothing: `execute(input, ctx)` keeps its signature              |
| 3   | Steering signals              | `ctx.interruptSignal`; `sleep` and `ask_question` on public API |
| 4   | Agent sessions                | `ctx.agent(name)` handles owned by the run; `agent.started`     |
| 5   | Task kernel and the turn rule | `task(input, ctx)`, `task_wait`, `task_cancel`, held turns      |
| 6   | Held-turn presentation        | Waiting boundary; `turn.completed` only at the real end         |
| 7   | Resumable tasks               | `serve(receive, ctx)`, `ctx.reply()`, `taskId`                  |
| 8   | Agents as tasks               | Agent tools as `serve` tools; `subagent.*` removed              |
| 9   | Slack post before a wait      | The text of a `task_wait` step is posted                        |
| 10  | Tests and release readiness   | E2E suites, real-model evals, Tasks and upgrade guides          |

**1. Remove background tasks.** Delete `execution: "background"` (rejected at definition),
`taskDeliveryPolicy`, cohorts, the `[Task state]` and `[Agents]` notes, prose notifications,
`<eve-empty-delivery/>`, result turns, `session.cancel()`'s `tasks` option, the
`BACKGROUND_TASK_*` codes, and background subagent dispatch; agent calls use the existing blocking
path, with `agentId` continuation unchanged. Delete the `agent-background-tools`,
`agent-task-reporting`, `agent-task-wake-policy`, and `fixture-tasks` fixtures and the background
suites in `agent-subagents`, `agent-cancellation`, and `agent-workflow-tools`; update the docs to
describe blocking calls only. Delete `research/background-task-wake-policy.md`, which describes
the removed behavior, and every test of background tasks.

**2. Workflow tool body.** Dropped. `execute(input, ctx)` keeps its signature, so no workflow
tool migrates; `receive()` and `reply()` move to PR 7 as `serve()`.

**3. Steering signals.** Start with a spike commit proving an `interrupt` command on the run's
command hook reaches the body and replays deterministically; it is the one unproven mechanism.
Then `ctx.interruptSignal` on the `execute` context, the steering rule for waited `execute`
calls, `ctx.ask(..., { signal })` withdrawal with `outcome: "cancelled"`, removing `dismissible`,
`sleep` and `ask_question` rebuilt as `execute(input, ctx)` on public API, and the
`tools/provided/**` guard.

**4. Agent sessions.** `ctx.agent(name)` handles opened from the run with the caller's principal,
capabilities, dynamic selections, and sandbox reference in the start input; `agent.started`;
`streamSubagent()` accepting `agent.started`; questions and sign-ins up the owner chain from
run-owned sessions; the remote protocol change and version check. Delete `agent-invoke`,
`agent-settled`, and the workflow-leased agent handles; migrate `agentRouter()`, the `workflow`
program tool, and the `agent-cancellation` fixture, whose `agentId` continuation is dropped. The
model's agent tools keep the old path and `subagent.called` until PR 8. Check first: how the
remote stream proxy finds the remote URL and credential key without `findRemoteSubagentBinding`
scanning for `subagent.called` (`eve-channel/support.ts`); resolve it from the agent definition by
`agent.started.name`, and if dynamic remote agents can't be resolved that way, record the binding
on the run's `agent.started` step instead.

**5. Task kernel and the turn rule.** Task records, `task(input, ctx)` with
`WorkflowTaskContext` and the one-entry-point definition error, receipts, `task.started` and
`task.settled`, `task_wait`, `task_cancel`, the `task.result` message, `[Tasks]`, the system block,
`UNKNOWN_TASK`, `TOO_MANY_TASKS`, principals, `session.cancel()` cancelling working tasks, the
hard-stop timer, and the turn rule with `final_output`'s error. A held turn shows no waiting
boundary yet: every held text step reports `"tool-calls"`, as child turns do. `agentRouter()` and
the `workflow` program tool become `task()` tools; the `execution` error gains its final
wording.

**6. Held-turn presentation.** The waiting boundary for root sessions, `turn.completed` only at
the real end, and `"tool-calls"` only for child and schedule turns.

**7. Resumable tasks.** `serve(receive, ctx)` and `WorkflowServeContext`: `receive()` with the
first call from the start input and later calls through the run's hook, `ctx.reply()`, return
and throw settlement, `ctx.ask` throwing while no call waits, `taskId` on the model input and its
build check, per-stretch `abortSignal`, idle tasks in the turn rule and `[Tasks]`, and cancel
keeping the task.

**8. Agents as tasks.** Agent tools rebuilt as `serve` tools on `ctx.agent`;
`agentId` becomes `taskId`. Delete the old dispatch (`subagents/handle-dispatch.ts`,
`subagents/remote-dispatch.ts`, `execution/tools/subagent/`), the four `subagent.*` events, the
`AGENT_*` codes, and `streamSubagent(called)`. Move the client reducer, dev TUI, eval assertions,
and hook event map to task events. #3700's delegated-session regressions and its
`agent-subagents-hitl` eval keep passing for agent tools, local and remote.

**9. Slack post before a wait.** First confirm Slack's event handlers can read `ScheduleIdKey`.

**10. Tests and release readiness.** The test pass in §10, a Tasks guide in `docs/` (choosing
`execute`, `task()`, or `serve()`, the ordering pattern, signals), and the upgrade guide from §8. Then release, and migrate
internal-agents.

## 10. Tests after the stack

Tests are written once the implementation has landed and the build is green, starting with e2e
suites under the fixtures they exercise.

**E2E (mock model):**

- An `execute` tool's result arrives as its tool result.
- Steering ends `sleep` but not an approval-gated tool, and a withdrawn ask reports
  `outcome: "cancelled"`.
- A `task()` tool starts, is waited on, and delivers its result; `task_cancel` stops one.
- The turn rule in each session kind: a root session's waiting boundary, a child turn, a
  schedule's turn, and MCP `agent_start` with a delegating agent reporting only the final reply.
- A user-defined `serve()` tool is continued by `taskId`, cancelled, and continued again.
- An agent, local and remote, is continued by `taskId` across turns and after `task_cancel` with
  its conversation intact; a child's question is answered at the root.
- Slack posts the text of a step whose only tool call is `task_wait`.

**Real-model evals** that gate the release: waits when the answer is needed; fans out, then waits
for every result; keeps tasks after an unrelated message; corrects an agent by `taskId` or
cancels after a redirect; continues an agent instead of starting a new one; doesn't wait when
told there's no rush; doesn't use a side-effect tool before the result it depends on.

**Candidates beyond e2e,** decided in this pass because e2e can't hit them deterministically:
duplicate settlement; a result before the run reports started; a cancel before it starts; a crash
between the record and the start; a hard stop racing a result; a result settling as `task_wait`
starts or ends; an agent message racing the end of its turn; a call arriving before a `serve`
body's first `receive()`.

## 11. Risks and accepted costs

1. **One more model step per needed result** (start, then wait), and one wake per result when the
   model needs several.
2. **Long `execute` tools** hold the conversation until they settle.
3. **`interruptSignal` is unproven** until PR 3's spike.
4. **Shared-thread wait.** Another person's message waits for a held turn, tasks included. One
   open turn per principal is the first follow-up.
5. **`serve` bodies own their correctness.** A body must catch its stretch's abort to stay
   available, one that never replies holds the turn until its call is cancelled, and one that
   ignores `abortSignal` keeps working after a cancel.
6. **Every agent task costs a workflow run** around its child session.
7. **A lost remote completion** leaves its task working until the session ends; remote callback
   retries and an `agent_state` tool are follow-ups.
8. **Most PRs in the stack break public API** before one release; holding the release is what
   keeps users from seeing the intermediate states.
