---
issue: TBD
status: implemented
last_updated: "2026-10-01"
---

# Tool stubs for evals

## Summary

An eval can choose a stub set for the sessions it starts. A stub set replaces
what named tools return. The model still sees each real tool's name,
description, input schema, and approval policy, and still decides on its own
whether to call it. Only the tool's `execute` changes.

Stub sets are code in `evals/stubs/`. They keep state per root session, so a
stubbed `create_issue` followed by a stubbed `list_issues` stays consistent.
Only the local server that `eve eval` starts loads them, so a deployed agent
never contains stub code.

## Problem

An eval that exercises a real tool needs that tool's credentials, network
access, and live data, and its side effects really happen. Agents work around
this today in three ways:

- **Evals that avoid tools.** They assert decisions that come before a tool
  runs, such as a pending approval, or they call library functions directly.
  The model never reads a tool result.
- **Results pasted into the prompt.** The eval tells the agent not to call
  tools and supplies the data as text. The model never sees the data as a
  tool result, and the eval cannot check that the tool was called.
- **External runners.** A separate benchmark runner starts a fake MCP server
  per task in Docker and wires it to the agent's tool names. This works, but
  it needs Docker and its own runner, and it does not run under `eve eval`.

An app cannot build this cleanly on top of eve. Replacing a tool with a
same-named dynamic tool means copying its description, schema, and approval by
hand, and those copies drift from the real tool. The eval client has no
model-invisible field for the server, so apps carry stub data in custom headers
and channel code.

## Authoring API

A stub set is one file. Its name comes from the file path, and its tool names
are the keys of `tools`.

```ts title="evals/stubs/two-workflows.ts"
import { defineToolStubs } from "eve/evals";

export default defineToolStubs({
  state: () => ({
    schedules: [{ id: "sched_1", name: "Weekly commit activity", cron: "0 17 * * 4" }],
  }),
  tools: {
    schedules_read: (input, { state }) => ({
      action: "read",
      schedules: state.schedules,
    }),
    schedules_create: (input, { state }) => {
      const schedule = { id: `sched_${state.schedules.length + 1}`, ...input };
      state.schedules.push(schedule);
      return { action: "create", schedule };
    },
  },
});
```

An eval selects the set when it starts a session:

```ts title="evals/schedules.eval.ts"
import { defineEval } from "eve/evals";

export default defineEval({
  async test(t) {
    const turn = await t.send("What workflows do I have?", { stubs: "two-workflows" });
    t.calledTool("schedules_read");
    turn.messageIncludes("Weekly commit activity");
  },
});
```

`t.session({ stubs })` accepts the same option, and so do the client's
`client.sessions.create(...)` inputs. Later messages and approval responses in
that session use the set; they do not accept `stubs`.

A stub receives the tool input and a context with `state`, `toolName`, and
`callId`. It returns the same shape as the real tool. `state()` returns the starting
state for a root session.

## Semantics

```text
eve eval
  └─ starts the local server with EVE_EVALUATION=1 and the evals/stubs/ path

t.send(message, { stubs: "two-workflows" })
  └─ session create carries `stubs`
       └─ eve channel accepts it only on that server, checks the set loads,
          and stores the set name with the session

model calls schedules_read
  └─ approval policy                       (unchanged)
       └─ execute: session has a stub set?
            ├─ eve-provided or framework tool → run the real tool
            ├─ stub for this tool             → run the stub
            ├─ no stub for this tool          → fail the turn
            └─ no stub set                    → run the real tool
       └─ toModelOutput, durable history   (unchanged)
```

- **Only the local eval server accepts stubs.** A session create with `stubs`
  on any other server fails with an error that names the cause. The eval
  runner refuses `stubs` against `eve eval --url` targets before sending,
  because an older deployed eve ignores the field and runs real tools.
- **Approval runs first.** A stub replaces `execute`, so approval policies,
  pending approval cards, and denials behave as they do in production. A denied
  call never reaches the stub.
- **Results take the real path.** A stub's return value goes through the same
  normalization and `toModelOutput` as a real result and lands in durable
  session history. Resuming a parked turn does not run the stub again.
- **State is one in-memory world per root session.** The eval server keeps it,
  keyed by the root session id, and subagents share it. It survives approval
  pauses and later turns. It is not durable: a retried step can apply a write
  twice, and a server restart loses it.
- **Missing stubs fail the turn.** In a stubbed session, an authored,
  extension, dynamic, or connection tool without a stub ends the turn with
  `turn.failed` code `TOOL_STUB_MISSING`, naming the set and the tool. Its real
  `execute` does not run, and the model never sees the error, so it cannot work
  around the gap. The harness gains one generic mechanism for this: a tool's
  `execute` throws a `TurnFailingToolError`, and the tool loop fails the turn
  after the model call.
- **Connection tools are stubbed by their visible names**, `connection_search`
  and `connection_execute`. Without stubs, both fail closed.
- **eve's own tools run as usual**, including when an app mounts them from
  `agent/tools/`: `bash`, `read_file`, `write_file`, `glob`, `grep`,
  `web_fetch`, `load_skill`, `no_reply`, `ask_question`, `sleep`, and
  `workflow`. Provider-executed tools such as `web_search` are outside the
  swap.
- **Authored workflow tools are stubbed at dispatch.** In a stubbed session the
  call settles with its stub's result and starts no run. A workflow tool that
  runs as a task fails the turn with `TOOL_STUB_UNSUPPORTED`.
- **Remote agents are stubbed by name.** The session layer runs the stub for
  each message and delivers its reply on the message's reply hook in the
  payload a remote callback carries; no request leaves the server.
- **Unknown sets fail at session create.** The error lists the sets eve found
  in `evals/stubs/`.
- **Local subagents inherit the set** and share the root session's state. A
  missing stub in a subagent fails that subagent's turn and the root session's
  turn. A stub that fails a turn outside a model step (a workflow tool, a
  remote agent, a subagent) records the failure in the eval server's memory,
  and the session takes it at its next step, before its model call.
- **The model sees nothing.** `stubs` is never sent to the model, and the
  real tool definitions are unchanged.

## Scope

In scope: authored and extension tools in `agent/tools/`, dynamic tools,
connection tools through `connection_search` and `connection_execute`,
authored workflow tools that return one result, and remote agents.

Out of scope for this proposal:

- workflow tools that run as tasks (`task`, `serve`);
- provider-executed tools, such as `web_search`;
- combining several stub sets in one session;
- marking stubbed calls in `action.result` events or traces;
- deployed targets reached with `eve eval --url`;
- matching rules on tool arguments, and recording real results for replay.
  A stub is a function, so it can branch on its input.

## Prior art

- **Interceptors in the agent process.** LangChain's `wrap_tool_call`,
  Mastra's `beforeToolCall`, Google ADK's `before_tool_callback`, Semantic
  Kernel's function filters, and Microsoft Agent Framework's
  `FunctionMiddleware` let test code return a result in place of running the
  tool. They rely on the test building the agent in-process.
- **Temporal mock Activities.** Tests register fake Activities under the real
  names on a separate worker and route the run to it. The fake code lives with
  the worker, the run selects it, and results enter durable history. This is
  the model for stub sets.
- **Mock MCP servers.** Fake servers hold a simulated world behind related
  tools. `state` plays that role here.

## Alternatives

- **Fixed results sent with the request.** The eval passes
  `{ toolName: result }` and eve returns it. It needs no new discovery, but it
  cannot keep state or react to input, and large results such as images must
  travel in the request.
- **Network-level mocks.** Intercepting `fetch` fakes the services a tool
  calls. It cannot reach clients built on `node:http` or raw sockets, and the
  eval author writes upstream API responses.

## Open questions

- **Typed stub inputs.** Can `defineToolStubs` type each stub's `input` from
  the real tool's input schema?
