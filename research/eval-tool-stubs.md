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

Stub sets are code in `evals/stubs/`. They keep state for a session and its
subagents, so a stubbed `create_issue` followed by a stubbed `list_issues`
stays consistent. Only the local server that `eve eval` starts loads them, so a
deployed agent never contains stub code.

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

`t.session({ stubs })` accepts the same option. Later messages and approval
responses in that session use the set without repeating it.

A stub receives the tool input and the context an authored tool's `execute`
receives, plus `state`. It returns the same shape as the real `execute`.
`state()` returns the starting state for each root session.

## Semantics

```text
eve eval
  └─ starts the local server with EVE_EVALUATION=1 and the evals/stubs/ path

t.send(message, { stubs: "two-workflows" })
  └─ session create carries `stubs`
       └─ eve channel accepts it only on that server, loads the set,
          and stores { set, worldId } with the session

model calls schedules_read
  └─ approval policy                       (unchanged)
       └─ execute: session has a stub set?
            ├─ stub for this tool     → run the stub with the world's state
            ├─ no stub for this tool  → fail the turn (agent/tools/, dynamic, connection tools)
            │                           run for real (eve's default tools)
            └─ no stub set            → run the real tool
       └─ toModelOutput, durable history   (unchanged)
```

- **Only the local eval server accepts stubs.** It is the server `eve eval`
  starts, which runs with `EVE_EVALUATION=1` and knows the app's
  `evals/stubs/` directory. A session create with `stubs` anywhere else fails
  with an error that names the cause, including under `eve eval --url`.
  Deployed builds never load stub sets or the module loader that imports them.
- **`stubs` is a create-only field.** The session create body accepts it, also
  for a session created without a message. A later message or approval
  response that carries it fails.
- **Approval runs first.** A stub replaces `execute`, so approval policies,
  pending approval cards, and denials behave as they do in production. A denied
  call never reaches the stub.
- **Results take the real path.** A stub's return value goes through the same
  normalization and `toModelOutput` as a real result and lands in durable
  session history. Resuming a parked turn does not run the stub again.
- **Missing stubs fail the turn.** In a stubbed session, a tool from
  `agent/tools/` (including opt-in framework tools added there), a dynamic
  tool, or a connection tool without a stub fails the turn with
  `TOOL_STUB_MISSING` and an error that names the set and the tool. Its real
  `execute` does not run. eve's default tools, such as `bash`, `web_fetch`,
  and `load_skill`, run as usual. A missing stub in a subagent fails the
  subagent's turn and the root session's turn.
- **Tools outside the model step are stubbed by name.** A set can stub a
  workflow tool, a local subagent, or a remote agent by its model-visible
  name; the stub answers the whole call after any approval. Without a stub,
  workflow tools and local subagents run for real and the agent sessions they
  open share the set and its state. A remote agent without a stub fails the
  turn.
- **Connection tools are stubbed by their visible names.** The model reaches
  connection tools through `connection_search` and `connection_execute`, so a
  set stubs those names and branches on the input.
- **Unknown sets fail at session create.** The error lists the sets eve found
  in `evals/stubs/`.
- **One state per session tree.** Session create starts a world, and the set's
  `state()` seeds it on first use. Local subagents carry the same world id, so
  the parent and every subagent read and write one state object. The world
  lives in the eval server's memory: it survives approval pauses and later
  turns, is lost if the server restarts, and a retried workflow step can apply
  a stub's change twice.
- **One set per session.** A set describes one starting world, so eve never
  merges sets. Shared stubs can be imported into a set file.
- **The model sees nothing.** `stubs` is never sent to the model, and the
  real tool definitions are unchanged. Events and traces do not mark stubbed
  calls.

## Scope

In scope: tools in `agent/tools/`, eve's default tools when a set stubs them,
dynamic tools, connection tools, and, by name, workflow tools, local
subagents, and remote agents.

Out of scope:

- provider-executed tools, such as a provider's built-in web search;
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
  the real tool's input schema? Stub inputs are untyped today.
