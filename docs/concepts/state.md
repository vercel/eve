---
title: "State"
description: "Durable per-session memory with defineState: get() and update(), persisted across step boundaries."
---

`defineState` declares a typed, named slot of per-session memory. Use it when the agent has to remember something between turns, such as a running budget, a glossary, or a checklist, without an external store. Values survive crashes, redeploys, and days-long sessions.

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

`get()` and `update()` require an active eve context. Calling them outside tools, hooks, or framework-managed code throws.

## Reset state between turns

State persists across turns. For a clean slate every turn, overwrite it from a [hook](../guides/hooks) on `turn.started`:

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

The hook imports the same module-scope `budget` handle as the tool, so both read and write the same slot.

## State is never shared with subagents

Every [subagent](../subagents) starts with its own fresh state, whether it's a built-in `agent` copy or a declared specialist. `defineState` values never cross the parent/child boundary, even when the child is a copy of the same agent.

## State vs. connection-side storage

`defineState` holds working memory that lives and dies with the session, such as counters, the current plan, and what the user said. For context that must outlive a session, configure a [memory provider](../memory): the built-in file provider, a third-party provider, or a custom one. Use a [connection](../connections) instead when the model should query the data only through explicit tool calls rather than recall it automatically.

## What to read next

- Vary tools, skills, and instructions per session → [Dynamic capabilities](../guides/dynamic-capabilities)
- How turns checkpoint and resume → [Execution model & durability](../concepts/execution-model-and-durability)
- The `ctx` accessors available alongside state → [TypeScript API Reference](../reference/typescript-api)
- Tenant-scoped long-term memory with any provider → [Multi-tenant memory](../patterns/multi-tenant-memory)
- First-class recall, capture, and provider tools → [Memory](../memory)
