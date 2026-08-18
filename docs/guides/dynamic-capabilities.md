---
title: "Dynamic Capabilities"
description: "Resolve models, subagents, tools, skills, and instructions at runtime with defineDynamic resolver events."
---

`defineDynamic` resolves the model, subagents, tools, skills, and instructions at runtime from a session event instead of declaring them up front. Reach for it when the right capability isn't known until the session starts, because it hinges on who the caller is, what tenant they belong to, feature flags, or external data. The [subagents](../subagents), [tools](../tools), [skills](../skills), and [instructions](../instructions) guides each point here for their dynamic form.

## Dynamic models

The `model` field in `agent.ts` accepts `defineDynamic({ events })`. Resolvers
run at `session.started`, `turn.started`, or `step.started` (precedence: step >
turn > session). Every matching handler must return a concrete model. A
missing, invalid, or throwing selection fails the turn before model-dependent
work begins. Prefer `session.started` — prompt caches are per model, so
switching mid-session re-ingests the conversation at uncached prices. See
[agent configuration](../agent-config#choose-the-model-dynamically) for the
full contract.

Dynamic models do not compile a default model or model metadata. When a
resolver first selects a model, eve normalizes the selection and resolves any
omitted context-window metadata from the AI Gateway catalog. Dynamic tools,
skills, instructions, and subagents may return `null` to omit a capability.

### Route image inputs to a vision model

Use `step.started` when model choice depends on the current messages. This
keeps GLM for text and switches to Gemini Flash when user history contains an
image:

```ts title="agent/agent.ts"
import { defineAgent, defineDynamic } from "eve";

export default defineAgent({
  model: defineDynamic({
    events: {
      "step.started": (_event, ctx) => {
        const hasImage = ctx.messages.some(
          (message) =>
            message.role === "user" &&
            Array.isArray(message.content) &&
            message.content.some(
              (part) =>
                part.type === "image" ||
                (part.type === "file" &&
                  (part.mediaType === "image" || part.mediaType.startsWith("image/"))),
            ),
        );

        return hasImage ? "google/gemini-3.5-flash" : "zai/glm-5.2";
      },
    },
  }),
});
```

eve stages byte-backed `file` parts under `/workspace/attachments` before
`step.started`, but keeps their media type in `ctx.messages`. When an image
reaches the provider, vision models can process it and non-vision models reject
it. eve does not reroute automatically. See [Inbound
attachments](../sandbox#inbound-attachments).

## Dynamic subagents

Wrap a declared subagent's own `agent.ts` in `defineDynamic` when its
availability depends on the caller, tenant, environment, or a feature flag.
Return the child definition to configure and expose it. Return `null` to omit
it from the parent's model-visible tools.

```ts title="agent/subagents/finance/agent.ts"
import { defineAgent, defineDynamic } from "eve";

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) =>
      ctx.session.auth.current?.attributes.plan === "enterprise"
        ? defineAgent({
            description: "Analyze financial and accounting data.",
            model: "openai/gpt-5.5",
          })
        : null,
  },
});
```

eve always compiles the subagent's filesystem resources, including its
instructions, tools, skills, connections, sandbox, and nested subagents. It
does not compile an agent config or placeholder model for a dynamic subagent.
When the resolver selects the subagent, eve combines the returned config with
those resources before starting the child session. Each resolution can return
a different model or other runtime agent settings. A returned local config
must use a static model; it cannot contain another `defineDynamic` model.
Runtime-selected models must use string model IDs. Put build configuration on
the outer `defineDynamic` definition; build and Workflow-world configuration
cannot be selected in a handler result.

A single-file remote subagent uses the same lifecycle. Return
`defineRemoteAgent(...)` to expose the selected deployment, or `null` to omit it:

```ts title="agent/subagents/finance.ts"
import { defineDynamic, defineRemoteAgent } from "eve";

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) =>
      ctx.session.auth.current?.attributes.plan === "enterprise"
        ? defineRemoteAgent({
            description: "Analyze financial and accounting data.",
            url: "https://finance-agent.example.com",
          })
        : null,
  },
});
```

The returned remote definition can change its URL, path, headers, auth,
principal forwarding, and output schema. Function-valued URLs resolve when the
dynamic event runs. Auth and headers remain lazy and resolve before each
outbound request without entering durable workflow state.

Dynamic subagents support `session.started` and `turn.started`. A turn selection
shadows the session selection for that turn, including when the turn handler
returns `null`. If a resolver throws or returns an invalid definition, eve logs the
failure and omits the subagent.

The resolved set applies to local and remote direct delegation and the
`Workflow` tool. eve
also checks availability again before starting the child, so a stale or
manually constructed call fails with `SUBAGENT_UNAVAILABLE`. Treat conditional
availability as capability composition, not as the only authorization
boundary: sensitive child tools still need their own authorization and
approval checks.

## Dynamic tools

Pass `defineDynamic` an `events` object whose handlers return either a single `defineTool(...)`, a `Record<string, defineTool(...)>`, or `null` for no tools. Wrap every entry in `defineTool()`. The wrapper stamps them so their `execute` functions survive workflow step boundaries.

Dynamic tool executors receive the same `ToolContext` as static authored tools, including inline provider auth through `ctx.getToken(provider)` and `ctx.requireAuth(provider)`.

The example below builds one tool per warehouse table. A map return names each tool by its bare key, so the model sees `orders`, `users`, and so on.

```ts title="agent/tools/query.ts"
import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { listTables, runReadOnly } from "../lib/warehouse";

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

### Prefer an inline `execute` function

Write `execute` as an inline function expression, arrow, or method shorthand placed directly as the property value. The bundler transform stores the function and its closure variables for durable replay without rerunning the resolver.

The transform does not detect `execute: myFn`, `execute: makeFn()`, or executors created inside an imported dependency. For a `session.started` tool, eve can reconstruct these live functions by rerunning the owning resolver after a durable resume. Keep session resolvers idempotent and avoid unnecessary side effects. A `turn.started` tool still requires an inline executor to survive a fresh runtime.

### Naming

| Return shape            | File                       | Tool name(s)      |
| ----------------------- | -------------------------- | ----------------- |
| single `defineTool`     | `agent/tools/analytics.ts` | `analytics`       |
| map `{ export, query }` | `agent/tools/tenant.ts`    | `export`, `query` |

A single return produces one tool named after the file slug, identical to a static tool. A map names each entry by its **bare key** — there is no automatic slug prefix. If a bare name might collide, namespace the key yourself by including the prefix in the key (e.g. return `{ "tenant__export": … }` to get `tenant__export`).

### Conflicts

A dynamic tool or skill whose name matches an **authored** one **overrides** it — a per-caller resolver can replace a built-in by name. Two **dynamic** resolvers emitting the same name is a genuine ambiguity and throws; namespace one of the keys manually to resolve it.

### Events

| Event             | Resolver runs                              | Tools available for             |
| ----------------- | ------------------------------------------ | ------------------------------- |
| `session.started` | At session start; sometimes after a pause¹ | Every model call in the session |
| `turn.started`    | Once per turn                              | Every model call in the turn    |
| `step.started`    | Before each model call                     | That model call                 |

¹ If a session pauses to wait for approval or other input, eve may run the resolver again when the session continues. Design session resolvers so they can safely run more than once. They do not run before every model call.

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
import { runReadOnly, searchCatalog } from "../lib/catalog";

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
import { PLAYBOOKS } from "../lib/playbooks";

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

Skills follow the same naming rule as tools: a single `defineSkill(...)` is named after the file slug, while a map names each entry by its bare key (namespace the key yourself if it might collide). A dynamic skill overrides a same-named authored one; two dynamic resolvers emitting the same name throws.

## Dynamic instructions

A dynamic instructions file returns `defineInstructions({ content, role? })` built from the principal, tenant, channel, or external data. Omit `role` for system context:

```ts title="agent/instructions/persona.ts"
import { defineDynamic, defineInstructions } from "eve/instructions";

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      const plan = ctx.session.auth.current?.attributes.plan ?? "free";
      return defineInstructions({
        content: `The caller is on the ${plan} plan. Match the depth of your answers to it.`,
      });
    },
  },
});
```

Use `role: "user"` when the resolved value is application or user context that should become part of durable history:

```ts title="agent/instructions/brief.ts"
import { defineDynamic, defineInstructions } from "eve/instructions";
import { loadBrief } from "../lib/briefs";

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const brief = await loadBrief(ctx.session.auth.current);
      return brief ? defineInstructions({ content: brief, role: "user" }) : null;
    },
  },
});
```

Instruction resolvers support `session.started` and `turn.started` only. A system result lives in that scope and stays outside history. A user result is appended to history at the lifecycle boundary, with session results before turn results and both before the current delivery. There is no automatic deduplication: returning the same user content on a later turn intentionally appends another message.

Resolver snapshots reflect that order. At `session.started`, `ctx.messages` includes static user-role instructions. At `turn.started`, it also includes user-role results from `session.started`. These augmented snapshots are specific to instruction resolvers; tools, skills, models, and subagents keep their existing message snapshots.

Returning `null` or blank content contributes nothing. A throwing or invalid session resolver leaves any wider valid system selection in place. Every turn starts with fresh turn-scoped system instructions, so a failed or empty turn result cannot leak the previous turn's value. Completed lifecycle steps are replay-safe: parking, resuming, or replaying them does not duplicate user-role messages.

Dynamic system content that changes frequently can reduce provider prompt-cache reuse. Prefer session scope for stable values and use turn scope only when the context must be refreshed. Cache behavior remains provider-specific.

## What to read next

- Conditionally expose a specialist → [Subagents](../subagents)
- The static tool basics this builds on → [Tools](../tools)
- The built-in tools and how to override them → [Built-in tools](../concepts/built-in-tools)
- Authenticate a tool or connection to an external service → [Auth & route protection](./auth-and-route-protection)
- Durable per-session memory for resolvers to read → [State](../concepts/state)
