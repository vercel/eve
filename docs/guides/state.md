---
title: "State"
description: "Durable per-session memory with defineState: get() and update(), persisted across step boundaries."
---

`defineState` is a typed, named slot of durable per-session memory for an agent. Use it when the agent has to remember something between the turns of a conversation (a running budget, a glossary, a checklist) and you don't want to stand up an external store for it. The values survive workflow step boundaries, so they outlast crashes, redeploys, and days-long sessions.

```ts
import { defineState } from "eve/context";

const budget = defineState("my-agent.budget", () => ({ count: 0, cap: 25 }));
```

Pass `defineState(name, initial)` a stable string `name` (namespace it to your agent) and an `initial` function that produces the starting value the first time the slot is read. You get back a `StateHandle<T>`:

- `get()`: read the current value. Returns `initial()` on first access within a context.
- `update(fn)`: replace the value with `fn(current)`.

Use the handle from inside a tool, hook, or other framework-managed runtime code:

```ts title="agent/tools/spend.ts"
import { defineState } from "eve/context";
import { defineTool } from "eve/tools";
import { z } from "zod";

const budget = defineState("my-agent.budget", () => ({ count: 0, cap: 25 }));

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

```ts
budget.update(() => ({ count: 0, cap: 25 }));
```

## State is never shared with subagents

Every [subagent](../subagents) starts with its own fresh state, whether it's a built-in `agent` copy or a declared specialist. `defineState` values never cross the parent/child boundary, even when the child is a copy of the same agent.

## State vs. connection-side storage

`defineState` is for conversation-scoped working memory that lives and dies with the session: counters, the current plan, what the user has told you this conversation. Anything that has to outlive the session, be shared across sessions or users, or be queried independently of a turn belongs in an external store, either a [connection](../connections) or your own database. State is not a database. It's the agent's short-term memory, persisted durably for the life of the session.

## What to read next

- Read state inside dynamic resolvers → [Dynamic capabilities](./dynamic-capabilities)
- How step durability works → [Execution model & durability](../concepts/execution-model-and-durability)
- The `ctx` accessors available alongside state → [Tools](../tools)
