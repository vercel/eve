---
title: "Tool Stubs"
description: "Replace what an agent's tools return during eve eval, while the model still sees and calls the real tools."
---

A stub set replaces what named tools return in an eval session. The model still sees each real tool's name, description, input schema, and approval policy, and decides on its own whether to call it. Only the tool's `execute` changes: a call runs the stub instead, so an eval can exercise the full tool loop without credentials, live data, or side effects.

Stub sets work only on the agent server that `eve eval` starts, locally or in CI. `eve eval --url` targets and deployed agents reject them, and deployed agents never load stub set files or the loader that imports them.

## Write a stub set

Put each stub set in its own file under `evals/stubs/`. The set's name is its path there without the extension: `evals/stubs/two-workflows.ts` is `"two-workflows"`, and `evals/stubs/slack/two-channels.ts` is `"slack/two-channels"`.

```ts title="evals/stubs/two-workflows.ts"
import { defineToolStubs } from "eve/evals";

export default defineToolStubs({
  state: () => ({
    schedules: [{ id: "sched_1", name: "Weekly commit activity" }],
  }),
  tools: {
    schedules_read: (input, { state }) => ({ schedules: state.schedules }),
    schedules_create: (input, { state }) => {
      const schedule = { id: `sched_${state.schedules.length + 1}`, ...input };
      state.schedules.push(schedule);
      return { schedule };
    },
  },
});
```

- `tools` maps model-visible tool names to stubs. A stub receives the tool input and a context, and returns a result in the shape the real `execute` returns. The context is the tool context an authored tool receives (`toolName`, `callId`, `session`, and the rest), plus `state`.
- `state` returns the starting state for a session that selects this set; eve calls it on the session's first stub call. Stubs read and change the state in place, so a stubbed create followed by a stubbed list returns what was just created.
- Stub inputs are untyped (`any`): the stub set and the tools it stubs live in different modules, so the input type is not inferred from the real tool's schema.

A stub's return value goes through the same normalization and `toModelOutput` as a real result, and lands in session history like one.

## Select a stub set in an eval

Pass `stubs` when the eval creates the session, with `t.send` or `t.session`:

```ts title="evals/schedules.eval.ts"
import { defineEval } from "eve/evals";

export default defineEval({
  async test(t) {
    const first = await t.send("What workflows do I have?", { stubs: "two-workflows" });
    first.calledTool("schedules_read");
    first.messageIncludes("Weekly commit activity");

    const parked = await first.session.send("Remind me to check the canary tomorrow at 9am.");
    const created = await parked.session.respondAll("approve");
    created.calledTool("schedules_create");

    const listed = await created.session.send("What workflows do I have now?");
    listed.messageIncludes("canary");
  },
});
```

Later messages and approval responses in that session use the same set. The session API accepts `stubs` only when a session is created.

## How a stubbed session runs tools

- **Approvals run first.** A tool with an approval policy still pauses the turn for approval. The stub runs only after the eval approves the call, and a denied call never reaches the stub. Resuming a parked turn does not run the stub again.
- **Missing stubs fail the turn.** When the model calls a tool from `agent/tools/` other than a workflow tool, a dynamic tool, or a connection tool that the set does not stub, the turn fails with `TOOL_STUB_MISSING` and an error that names the set and the tool. The real `execute` does not run, including for a call the eval approved. This includes opt-in framework tools added with `eve add tool/...`, such as `glob`, `grep`, and `no_reply`, because they are files in `agent/tools/`. A missing stub in a subagent fails the subagent's turn and the root session's turn.
- **eve's default tools run as usual.** `bash`, `read_file`, `write_file`, `web_fetch`, `load_skill`, and the other tools eve adds by default run for real unless the set stubs them by name.
- **Connection tools are stubbed by their visible names.** The model reaches MCP and OpenAPI tools through `connection_search` and `connection_execute`, so a set that needs them stubs those two names and branches on the input, such as `input.tool === "linear:create_issue"`.
- **Subagents share the state.** A local subagent uses its parent's stub set and reads and writes the same `state` object, so a schedule a subagent creates is visible to the parent's next read.
- **Tools that run outside the model step are stubbed by name.** When the set stubs a workflow tool (`defineWorkflowTool`), a local subagent, or a remote agent by its model-visible tool name, the stub answers the whole call, after any approval. Without a stub, a workflow tool and a local subagent run for real and use the session's stubs: agent sessions they open share the set and its state. A workflow tool's own code, such as `fetch` or SDK calls, has real side effects. A remote agent without a stub fails the turn, because the deployed agent cannot use the session's stubs.
- **State lives in the eval server.** It survives approval pauses and later turns in the same `eve eval` run. It is not durable session data: it is lost if the server restarts, and a retried workflow step can apply a stub's change twice.

Provider-executed tools, such as `web_search`, cannot be stubbed and run as usual.

## Errors at session create

A session create that names a stub set fails with `400` when:

- the target is not the server `eve eval` started, including any `eve eval --url` target;
- the set does not exist. The error lists the sets eve found in `evals/stubs/`;
- the set's file does not default-export `defineToolStubs({ ... })`.

To run an eval with stubs only where they are supported, skip it on other targets:

```ts
if (t.target.kind !== "local") {
  t.skip("Stub sets are accepted only by the agent server that eve eval starts.");
}
```

## What to read next

- [Cases](./cases): the drive API for sessions, turns, and approvals
- [Targets](./targets): local and remote eval targets
- [Assertions](./assertions): `calledTool`, `messageIncludes`, and event assertions
