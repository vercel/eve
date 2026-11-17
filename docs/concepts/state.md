---
title: "State"
description: "Read and update per-session state across turns and restarts with defineState."
---

`defineState` declares a typed, named slot of per-session memory. Use it when the agent has to remember something between turns, such as a running budget, a glossary, or a checklist, without an external store. Values survive crashes, redeploys, and days-long sessions.

Use state for values your agent owns, such as budgets and counters. Do not duplicate session state that eve already tracks, such as the active turn, call status, or open requests for input; read those with [session views & selectors](/docs/concepts/session-views-and-selectors). A view is an operational snapshot with bounded retention, so store a historical record yourself when you need one.

```ts
import { defineState } from "eve/context";

const budget = defineState("my-agent.budget", () => ({ count: 0, cap: 25 }));
```

Pass `defineState(name, initial)` a stable string `name`, namespaced to your agent, and an `initial` function that produces the starting value. It returns a `StateHandle<T>`:

- `get()`: read the current value. Returns `initial()` on first access within a context.
- `update(fn)`: replace the value with `fn(current)`.

Declare the handle once at module scope and import it wherever you read or write the slot:

```ts title="agent/lib/budget.ts"
import { defineState } from "eve/context";

export const budget = defineState("my-agent.budget", () => ({ count: 0, cap: 25 }));
```

```ts title="agent/tools/spend.ts"
import { defineTool } from "eve/tools";
import { z } from "zod";
import { budget } from "../lib/budget";
import { runQuery } from "../lib/warehouse";

export default defineTool({
  description: "Run a query, counting it against the session budget.",
  inputSchema: z.object({ sql: z.string() }),
  async execute({ sql }) {
    const { count, cap } = budget.get();
    if (count >= cap) throw new Error("Query budget exhausted for this session.");
    budget.update((s) => ({ ...s, count: s.count + 1 }));
    return runQuery(sql);
  },
});
```

`get()` and `update()` require an active eve context. They work in tools, hooks, channel handlers, dynamic functions, and OpenTelemetry [`runtimeContext`](../observability/otel#add-runtime-context) resolvers. Calling them outside code eve runs, such as at module scope, throws.

## Update state from a workflow tool

`get()` and `update()` throw inside a [workflow tool](../tools/workflows)'s `"use step"` function, because the step runs outside the session that owns the state. Return the value from the workflow tool instead:

```ts title="agent/tools/compile_report.ts"
import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

export default defineWorkflowTool({
  description: "Compile a report on a topic.",
  inputSchema: z.object({ topic: z.string() }),
  async execute({ topic }) {
    "use workflow";
    return await compile(topic);
  },
});

async function compile(topic: string) {
  "use step";
  return `Report on ${topic}`; // a defineState get() or update() here throws
}
```

Then save the output from a [hook](../guides/hooks) on `call.settled`, which runs in the session when the call finishes:

```ts title="agent/hooks/save-report.ts"
import { defineState } from "eve/context";
import { call } from "eve/events";
import { defineHook } from "eve/hooks";

const reports = defineState<string[]>("my-agent.reports", () => []);

export default defineHook({
  events: {
    "call.settled"(event, ctx) {
      const finished = call(ctx.view, event.data.callId);
      if (finished?.name === "compile_report" && finished.state === "completed") {
        reports.update((saved) => [...saved, finished.output as string]);
      }
    },
  },
});
```

## Reset state between turns

State persists across turns. To reset it on every turn, overwrite it from a `turn.started` [hook](../guides/hooks):

```ts title="agent/hooks/reset-budget.ts"
import { defineHook } from "eve/hooks";
import { budget } from "../lib/budget";

export default defineHook({
  events: {
    async "turn.started"() {
      budget.update(() => ({ count: 0, cap: 25 }));
    },
  },
});
```

The hook imports the same module-scope `budget` handle as the tool, so both read and write the same slot. A `turn.started` hook finishes before the turn's first model call, so the reset is in place before any tool of that turn runs.

## State is never shared with subagents

Every [subagent](../subagents) starts with its own fresh state, whether it's a built-in `agent` copy or a declared specialist. `defineState` values never cross the parent/child boundary, even when the child is a copy of the same agent.

## State vs. connection-side storage

`defineState` holds working state scoped to a single session, such as counters, the current plan, and user preferences from the conversation. For context that must outlive a session, configure a [memory provider](../memory): the built-in file provider, a third-party provider, or a custom one. Use a [connection](../connections) instead when the model should query the data only through explicit tool calls rather than recall it automatically.

## What to read next

- [Dynamic capabilities](../guides/dynamic-capabilities): vary tools, skills, and instructions per session
- [Execution model & durability](../concepts/execution-model-and-durability): how turns checkpoint and resume
- [TypeScript API Reference](../reference/typescript-api): `ctx` accessors available alongside state
- [Multi-tenant memory](../patterns/multi-tenant-memory): tenant-scoped long-term memory with any provider
- [Memory](../memory): cross-session recall, capture, and provider tools
