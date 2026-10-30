---
title: "Dynamic Capabilities"
description: "Compute models, subagents, connections, tools, skills, and instructions from the session with defineDynamic."
---

`defineDynamic(fn)` builds a model, subagent, connection, tool, skill, or instructions from the caller, the conversation, or external data. The function returns the definition, or `null` to leave it out. Import `defineDynamic` from `eve` or from the entry point of what you define, such as `eve/tools`.

eve runs the function before every ordinary model call, including when a turn continues after steering, a sign-in, or an approval. It doesn't run for compaction's summary call or `auto()`'s routing call. Introspection reads the values it last returned.

The module's top-level code runs at build time and at runtime, so keep caller-specific work inside the function. See [Authored module lifecycle](../reference/typescript-api#authored-module-lifecycle).

## Context and memoization

Every dynamic function receives:

| Field                     | Contents                                                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.session`             | Session ID, authenticated caller and initiator, and optional schedule and predecessor.                                                  |
| `ctx.session.parent`      | In a delegated session: the parent session, its turn, the call that opened this session, and `rootSessionId`. Absent in a root session. |
| `ctx.channel`             | Channel kind, continuation token, and metadata. Narrow typed metadata with `isChannel`.                                                 |
| `ctx.view`                | Read-only view of the session so far. Read it with selectors from `eve/events`, such as `turns(ctx.view)`.                              |
| `ctx.turn`                | Latest turn, with its ID, input, and status; `null` before the first turn.                                                              |
| `ctx.now`                 | Time of the latest recorded session event, as a `Date`.                                                                                 |
| `ctx.model.id`            | Selected model ID. Unavailable inside the `model` field, before the model is chosen.                                                    |
| `await ctx.messages()`    | The conversation so far, assembled only when you call it.                                                                               |
| `await ctx.memo(key, fn)` | A saved JSON result for a key.                                                                                                          |

Code outside a memo runs every time eve runs the function. Put a fetch or decision inside a memo when its answer should stay fixed for a key:

```ts title="agent/tools/query.ts"
import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { listTables, runReadOnly } from "../lib/warehouse";

export default defineDynamic(async (ctx) => {
  const tables = await ctx.memo(ctx.session.id, listTables);
  return Object.fromEntries(
    tables.map((table) => [
      table.name,
      defineTool({
        description: `Query ${table.name}. Columns: ${table.columns.join(", ")}`,
        inputSchema: z.object({ sql: z.string() }),
        execute: ({ sql }) => runReadOnly(table.name, sql),
      }),
    ]),
  );
});
```

After a cold start, eve runs the function again. The memo returns the saved tables without querying the database, and ordinary code rebuilds the tools and their callbacks.

### Choose a lifetime

| Key                    | Observation runs                            |
| ---------------------- | ------------------------------------------- |
| No memo                | Every run of the function                   |
| `ctx.turn?.id ?? null` | Once per turn                               |
| `ctx.session.id`       | Once per session, until a deployment change |
| A caller or tenant ID  | When that key changes                       |

The key sets a lifetime, not a dependency list. A change in context that the callback reads doesn't clear a saved result.

### Memo rules

- Keys compare as canonical JSON. A top-level `undefined` key means `null`; `undefined` inside a key is rejected. Use `tenantId ?? null` to represent a missing value explicitly. A key is at most 64 KB and a result at most 1 MB. Save plain JSON, not clients, functions, dates, or schemas.
- Each definition or hook retains at most 4 MB of memo JSON, including keys. Memoize a collection rather than each row, and keep IDs instead of whole records.
- Identity includes the session and mounted definition. Separate files do not share memo results.
- Give multiple memos distinct keys, usually tuples such as `["tables", tenantId]` and `["flags", ctx.turn?.id ?? null]`. Reusing a key in one run of the function throws.
- eve keeps only the keys that the latest successful run used. A skipped branch loses its saved results; returning to it runs the callback again.
- A failing memo keeps no result. Successful memos survive a later error in the definition if they fit alongside its earlier memo results. If they don't fit within 4 MB, eve keeps the earlier results, and the new memos run again next time.
- Deployment changes discard memos. Memos are a cache, not a record of side effects.
- Memos can run concurrently with `Promise.all`, but cannot nest. Await every memo before returning.
- Memo results are saved privately with the session and never appear on the stream.

A memo callback receives `{ idempotencyKey, abortSignal }`. Pass `idempotencyKey` to an external service that supports idempotency, because an interrupted step can run again before eve saves its result. The key is stable per session, definition, and memo key. It repeats when a deployment change or skipped branch runs the memo again, so send your own key when a run needs a fresh response. Perform side effects in [hooks](./hooks) or tool execution, not while computing a definition.

## Dynamic models

The agent's `model` field accepts a dynamic function that returns a model ID, a provider instance, or a selection containing `model` and optional model settings. A missing or invalid model fails the turn. `ctx.model` is unavailable here.

```ts title="agent/agent.ts"
import { defineAgent, defineDynamic } from "eve";

export default defineAgent({
  model: defineDynamic(async (ctx) => {
    const hasImage = (await ctx.messages()).some(
      (message) =>
        message.role === "user" &&
        Array.isArray(message.content) &&
        message.content.some(
          (part) =>
            part.type === "image" || (part.type === "file" && part.mediaType.startsWith("image/")),
        ),
    );
    return hasImage ? "google/gemini-3.5-flash" : "zai/glm-5.2";
  }),
});
```

Changing models can reduce prompt-cache reuse. Use a session- or turn-keyed memo for a decision that should stay fixed. See [Choose the model dynamically](../agent-config#choose-the-model-dynamically).

## Dynamic subagents

A declared subagent's `agent.ts` can return a child configuration or `null`:

```ts title="agent/subagents/finance/agent.ts"
import { defineAgent, defineDynamic } from "eve";

export default defineDynamic((ctx) =>
  ctx.session.auth.current?.attributes.plan === "enterprise"
    ? defineAgent({ description: "Analyze financial data.", model: ctx.model.id })
    : null,
);
```

The child's tools, instructions, skills, and nested subagents still build from the filesystem; the returned config supplies runtime settings. A local child config requires a string model ID. Put build settings such as `build.externalDependencies` on the root agent, because build and Workflow world settings can't be chosen at runtime.

A single-file remote subagent returns `defineRemoteAgent(...)` or `null`. Compute the URL string in the function. Credentials can use memo results, and later requests to the same child rebuild them from the session as it was when the child opened. See [Dynamic remote agents](./remote-agents#dynamic-remote-agents) for the rebuild rules.

Hiding a subagent doesn't authorize anything: sensitive child tools still need authorization and approval checks.

## Dynamic connections

Return a `defineMcpClientConnection(...)`, a `defineOpenAPIConnection(...)`, a map of definitions, or `null`. Select accounts and endpoints from authenticated identity or application-owned data, not untrusted conversation URLs.

```ts title="agent/connections/accounts.ts"
import { defineDynamic, defineMcpClientConnection } from "eve/connections";
import { listEnabledAccounts, mintAccountToken } from "../lib/accounts";

export default defineDynamic(async (ctx) => {
  const principal = ctx.session.auth.current;
  if (principal?.principalType !== "user") return null;
  const accounts = await ctx.memo(principal, () => listEnabledAccounts(principal));
  return Object.fromEntries(
    accounts.map((account) => [
      account.slug,
      defineMcpClientConnection({
        url: "https://mcp.cloud.example.com",
        description: account.label,
        instanceKey: account.accountId,
        auth: {
          principalType: "user",
          getToken: ({ principal }) => mintAccountToken(principal, account),
        },
      }),
    ]),
  );
});
```

The memo saves account metadata, not tokens; auth and header callbacks run when needed. Set `instanceKey` to a stable, non-secret account identifier, and change it when the endpoint, account, or auth provider changes. eve rejects a waiting sign-in callback if its connection's name, URL, or `instanceKey` changed.

Dynamic connections take the same filtering, provided arguments, and approval options as static [MCP](../connections/mcp) and [OpenAPI](../connections/openapi) connections. Each run refreshes connection callbacks and may replace clients, so don't rely on a dynamic MCP protocol session surviving between model calls. Models discover connection tools through `eve__search` and call them through `eve__tool`.

## Dynamic tools

Return a single `defineTool(...)`, a map of tools, or `null`. Executors receive the same `ToolContext` as static tools, including `ctx.getToken` and `ctx.requireAuth`. Validators, including refinements and transformations, and an `endsTurn` function run as they do on a static tool.

### Author replayable callbacks

Build callbacks and schemas with ordinary code. Save observations in memos when a fresh process must rebuild from the same data, because values fetched outside a memo are fetched again. Avoid `Math.random()` and `Date.now()` in declarations unless memoized; use `ctx.now` for commit time.

### Create dynamic tools in a package

Packages can return ordinary `defineTool` values, including callbacks made by factories. Prefer an [extension](../extensions) when distributing a namespaced collection of capabilities.

### Identity and redeploys

A fresh process rebuilds tools from their definitions and saved memo results. A deployment change discards the results and runs the new code. Approved work runs before the functions run for the next model call. Check authorization inside execution when a check must also stop already-approved work.

A call waiting for approval or sign-in runs only if its dynamic tool, connection, or subagent is unchanged. eve compares what the model was offered, a connection's target, or a subagent's selection, plus the memo results its definition used. If any changed, the call returns a tool error saying the tool changed since it was offered, and the model can request it again.

### Naming

A single tool takes the file's slug. A map uses bare keys, with no automatic file prefix: `agent/tools/tenant.ts` returning `{ query, export }` exposes `query` and `export`.

Names use ASCII letters, digits, underscores, and dashes, start with a letter, and contain at most 64 characters. `eve` and the `eve__` prefix are reserved. A connection reserves its name and its `<name>__` prefix, so tools cannot take those names.

### Conflicts

A dynamic tool, connection, or skill overrides a static one of the same kind and name. Two dynamic connection definitions can't emit the same name. For tools and skills, the earlier definition keeps a duplicate name and eve logs an error for the other. Dynamic tools can't take workflow-tool or subagent names. Other invalid results and name conflicts fail the turn.

<span id="events"></span>

### Steering and sign-in

Because eve runs dynamic functions before every model call, they see a steering message or completed sign-in without a new turn. A turn-keyed memo stays fixed until the next turn.

### Execution order

Hooks finish first, then model selection, then connections, subagents, tools, skills, and instructions. Don't depend on the order in which files run; each definition computes its own value.

A tool with `deferred: true` stays out of the model's tool list. It is found with `eve__search` and called with `eve__tool`, like a [static deferred tool](../tools#keep-a-tool-out-of-the-tool-list).

## Dynamic skills

Return a `defineSkill(...)`, a map, or `null`. A single skill takes the file slug; map entries use bare keys, with the same name constraints as tools.

```ts title="agent/skills/team_playbook.ts"
import { defineDynamic, defineSkill } from "eve/skills";
import { PLAYBOOKS } from "../lib/playbooks";

export default defineDynamic((ctx) => {
  const team = ctx.session.auth.current?.attributes.team;
  const content = team ? PLAYBOOKS[team] : undefined;
  return content ? defineSkill({ content, description: "The team's playbook." }) : null;
});
```

A skill with only `content` doesn't start a sandbox. A skill with files installs its package in the sandbox, and a changed package replaces the earlier files:

- The model call doesn't wait for the install. A tool or hook that uses the sandbox waits for it.
- If the install fails twice in a row, eve logs a warning and retries on the next model call.
- When the session detects a recreated sandbox, the next run reinstalls the package. A replacement made by a subagent or workflow step sharing the sandbox may go undetected, and then the files aren't rewritten until the package changes.
- Omitting `files` from a skill that stays available keeps its installed files; withdraw the skill to remove them.

`deferred: true` keeps a skill out of the announcement, while leaving it discoverable through `eve__search` and loadable with `eve__skill`.

## Dynamic instructions

Return `defineInstructions({ content, role? })` or `null`. System instructions apply while the function returns them and stay outside history. User instructions join the conversation history only when their content changes:

```ts title="agent/instructions/brief.ts"
import { defineDynamic, defineInstructions } from "eve/instructions";
import { loadBrief } from "../lib/briefs";

export default defineDynamic(async (ctx) => {
  if (!ctx.turn) return null;
  const brief = await ctx.memo(ctx.turn.id, () => loadBrief(ctx.session.auth.current));
  return brief ? defineInstructions({ content: brief, role: "user" }) : null;
});
```

Before a turn's first model call, new user content joins just before the turn's input; mid-turn changes append at the current position. Returning `null` adds nothing and resets content tracking, so returning the earlier content later adds it again, but it doesn't remove earlier history. Clear, compaction, and deployment changes don't re-append unchanged content.

## Errors and recovery

An unhandled error in a dynamic function or memo fails the turn with `REACTION_FAILED`. Catch optional work and return `null` when it should contribute nothing. A catch around `await ctx.memo(...)` leaves the failure uncached, so a later run tries it again. A catch inside the memo that returns `null` caches that `null` for the key's lifetime. A failed turn's input is not replayed.

With `EVE_LOG_LEVEL=debug`, eve logs each memo run with its file, key digest, reason (`new key` or `deployment change`), and duration, and whether each run's value changed. Logs never include the key. The digest is an unsalted hash, so someone who can guess a key, such as a tenant ID, can confirm it against the digest.

## What to read next

- [Hooks](./hooks) for effects and cancellation
- [Subagents](../subagents) and [Remote agents](./remote-agents)
- [Connections](../connections), [Tools](../tools), and [Skills](../skills)
- [State](../concepts/state) for durable application state
- [Memory](../memory) for cross-session recall and provider tools
