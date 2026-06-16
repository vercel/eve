---
title: "State"
description: "Durable per-session memory with defineState: get() and update(), persisted across step boundaries."
---

`defineState` is a typed, named slot of durable per-session memory for an agent. Use it when the agent has to remember something between conversation turns (a running budget, a glossary, a checklist) and you don't want to stand up an external store for it. The values survive workflow step boundaries, so they outlast crashes, redeploys, and days-long sessions.

```ts
import { defineState } from "eve/context";

const budget = defineState("my-agent.budget", () => ({ count: 0, cap: 25 }));
```

Pass `defineState(name, initial)` a stable string `name` (namespace it to your agent) and an `initial` function that produces the starting value the first time the slot is read. You get back a `StateHandle<T>`:

- `get()`: read the current value. Returns `initial()` on first access within a context.
- `update(fn)`: replace the value with `fn(current)`.

Declare the handle once at module scope and import it wherever you read or write the slot. Use it from inside a tool, hook, or other framework-managed runtime code:

```ts title="agent/lib/budget.ts"
import { defineState } from "eve/context";

export const budget = defineState("my-agent.budget", () => ({ count: 0, cap: 25 }));
```

```ts title="agent/tools/spend.ts"
import { defineTool } from "eve/tools";
import { z } from "zod";
import { budget } from "../lib/budget.js";
import { runQuery } from "../lib/warehouse.js";

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

`get()` and `update()` require an active Eve context. Calling them outside tools, hooks, or framework-managed code throws.

## Reset state between turns

State is durable by default and does not reset between turns. If you want a clean slate every turn, overwrite it from a lifecycle [hook](./hooks) on `turn.started`:

```ts title="agent/hooks/reset-budget.ts"
import { defineHook } from "eve/hooks";
import { budget } from "../lib/budget.js";

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

`defineState` holds conversation-scoped working memory that lives and dies with the session, including counters, the current plan, and what the user has told you this conversation. It is the agent's short-term memory, persisted durably for the life of the session. Anything that has to outlive the session, be shared across sessions or users, or be queried independently of a turn belongs in an external store, either a [connection](../connections) or your own database.

## What to read next

- Read state inside dynamic resolvers → [Dynamic capabilities](./dynamic-capabilities)
- How step durability works → [Execution model & durability](../concepts/execution-model-and-durability)
- The `ctx` accessors available alongside state → [TypeScript API](../reference/typescript-api)
