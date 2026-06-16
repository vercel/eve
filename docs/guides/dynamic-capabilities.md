---
title: "Dynamic Capabilities"
description: "Resolve tools, skills, and instructions at runtime with defineDynamic: the resolver events, execution order, and how dynamic tools survive step boundaries."
---

`defineDynamic` resolves tools, skills, and instructions at runtime from a session event instead of declaring them up front. Reach for it when the right capabilities aren't known until the session starts, because they hinge on who the caller is, what tenant they belong to, feature flags, or external data. The [tools](../tools), [skills](../skills), and [instructions](../instructions) guides each point here for their dynamic form.

## Dynamic tools

Pass `defineDynamic` an `events` object whose handlers return either a single `defineTool(...)`, a `Record<string, defineTool(...)>`, or `null` for no tools. Wrap every entry in `defineTool()`. The wrapper stamps them so their `execute` functions survive workflow step boundaries.

The example below builds one tool per warehouse table. A map return names tools `slug__key`, so the model sees `query__orders`, `query__users`, and so on.

```ts title="agent/tools/query.ts"
import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { listTables, runReadOnly } from "../lib/warehouse.js";

export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) =>
      Object.fromEntries(
        (await listTables()).map((t) => [
          t.name,
          defineTool({
            description: `Query ${t.name}. Columns: ${t.columns.join(", ")}`,
            inputSchema: z.object({ sql: z.string() }),
            execute: ({ sql }) => runReadOnly(t.name, sql),
          }),
        ]),
      ),
  },
});
```

### `execute` must be an inline function

Write `execute` as an inline function expression, arrow, or method shorthand placed directly as the property value. The bundler transform does not detect `execute: myFn` or `execute: makeFn()`, so those tools work on the first step but do not survive replay (re-running a step after a crash or resume; see [Execution model & durability](../concepts/execution-model-and-durability)). On later steps the transform reconstructs each `execute` from its stored closure variables instead of re-running the resolver, which is why it has to be inline.

### Naming

| Return shape              | File                       | Tool name(s)                      |
| ------------------------- | -------------------------- | --------------------------------- |
| single `defineTool`       | `agent/tools/analytics.ts` | `analytics`                       |
| map `{ export, query }`   | `agent/tools/tenant.ts`    | `tenant__export`, `tenant__query` |
| map `{ run }` (one entry) | `agent/tools/search.ts`    | `search__run`                     |

A single return produces one tool named after the file slug, identical to a static tool. A map always uses `slug__key`, even when it holds a single entry, so adding a second entry later never renames the first.

### Events

| Event             | Resolver runs          | Tools available for             |
| ----------------- | ---------------------- | ------------------------------- |
| `session.started` | Once per session       | Every model call in the session |
| `turn.started`    | Once per turn          | Every model call in the turn    |
| `step.started`    | Before each model call | That model call                 |

### Execution order

When a stream event fires, three things happen in order.

1. The channel adapter handler runs and the event is written to the durable stream.
2. Stream-event [hooks](./hooks) fire.
3. Dynamic tool resolvers subscribed to that event run and update the tool set.

The tool loop reads the current set right before each model call, so a mid-turn update is visible on the next call.

A single file can declare handlers for several events, and the most recently fired one owns that file's tool set. Re-resolve on `turn.started` to replace what `session.started` returned:

```ts title="agent/tools/catalog.ts"
import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { runReadOnly, searchCatalog } from "../lib/catalog.js";

export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => ({
      query: defineTool({
        description: "Run a read-only query.",
        inputSchema: z.object({ sql: z.string() }),
        execute: ({ sql }) => runReadOnly(sql),
      }),
    }),
    // On each turn, re-resolve. Replaces this file's session.started tools for later calls.
    "turn.started": async (_event, ctx) => ({
      search: defineTool({
        description: "Search the catalog.",
        inputSchema: z.object({ term: z.string() }),
        execute: ({ term }) => searchCatalog(term),
      }),
    }),
  },
});
```

Resolvers across files run concurrently.

## Dynamic skills

A dynamic skills file resolves which [skill](../skills) a caller can load, keyed on the principal. It resolves on `session.started` and `turn.started` only (`step.started` is reserved for dynamic tools). Read `ctx.session.auth` or channel metadata and return a `defineSkill(...)` (named after the file slug) or `null`:

```ts title="agent/skills/team_playbook.ts"
import { defineDynamic, defineSkill } from "eve/skills";
import { PLAYBOOKS } from "../lib/playbooks.js";

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      const team = ctx.session.auth.current?.attributes.team;
      const markdown = team ? PLAYBOOKS[team] : undefined;
      return markdown ? defineSkill({ markdown }) : null;
    },
  },
});
```

The caller's team gets its own playbook advertised as a loadable skill; everyone else gets nothing.

## Dynamic instructions

A dynamic instructions file resolves the per-session system prompt the same way, returning `defineInstructions(...)` built from the principal, tenant, or external data:

```ts title="agent/instructions/persona.ts"
import { defineDynamic, defineInstructions } from "eve/instructions";

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      const plan = ctx.session.auth.current?.attributes.plan ?? "free";
      return defineInstructions({
        markdown: `The caller is on the ${plan} plan. Match the depth of your answers to it.`,
      });
    },
  },
});
```

Both resolve before the prompt is assembled, so the model sees the right instructions and skill set for whoever is calling, without that context reaching anyone else.

## What to read next

- The static tool basics this builds on → [Tools](../tools)
- The built-in tools and how to override them → [Default harness](../concepts/default-harness)
- Authenticate a tool or connection to an external service → [Auth & route protection](./auth-and-route-protection)
- Durable per-session memory for resolvers to read → [State](./state)
