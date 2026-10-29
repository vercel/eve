---
title: "Dynamic Capabilities"
description: "Compute models, subagents, connections, tools, skills, and instructions from the session with defineDynamic."
---

Use `defineDynamic(fn)` when a capability depends on the caller, the conversation, or external data. The function returns the capability, or `null` to omit it. Import `defineDynamic` from `eve` or the capability's entry point, such as `eve/tools`.

eve evaluates dynamic values before every ordinary model call, including after steering, sign-in, and approval resumes. Hooks finish first, then eve chooses the model before evaluating other kinds. Introspection reads the last installed values without evaluating definitions. Compaction's summarizing call and `auto()`'s routing call do not evaluate them.

The module's top-level code runs during compilation and at runtime. Keep caller-specific work inside the function. See [Authored module lifecycle](../reference/typescript-api#authored-module-lifecycle).

## Context and memoization

Every dynamic function receives:

- `ctx.session`: the session ID, authenticated caller and initiator, and optional schedule and predecessor. In a delegated session, `ctx.session.parent` names the immediate parent session, its turn, and the call that opened this session, plus `rootSessionId` for the top-level session. A root session has no `parent`.
- `ctx.channel`: the channel kind, continuation token, and metadata. Use `isChannel` to narrow typed metadata.
- `ctx.view`: the committed session view. Read it with the selectors from `eve/events`, such as `turns(ctx.view)`.
- `ctx.turn`: the latest turn, including its ID, input, and status; `null` before the first turn.
- `ctx.now`: the latest commit's time as a `Date`.
- `ctx.model.id`: the selected model ID, except inside the `model` field, where the model is not chosen yet.
- `await ctx.messages()`: the conversation as of the latest commit, assembled lazily.
- `await ctx.memo(key, fn)`: a saved JSON observation.

Code outside a memo runs at each evaluation. Put a fetch or decision inside a memo when its answer should stay fixed for a key:

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

After a cold start, eve evaluates the function again. The memo returns the saved tables without querying the database, and ordinary code rebuilds the tools and their callbacks. Helpers, factories, schemas in variables, and provider packages work without compiler rewriting.

### Choose a lifetime

| Key                    | Observation runs                            |
| ---------------------- | ------------------------------------------- |
| No memo                | Every evaluation                            |
| `ctx.turn?.id ?? null` | Once per turn                               |
| `ctx.session.id`       | Once per session, until a deployment change |
| A caller or tenant ID  | When that key changes                       |

The key is a lifetime, not a dependency list. The callback may read the enclosing context; those reads do not invalidate a saved result.

### Memo rules

- Keys compare as canonical JSON. A top-level `undefined` key means `null`; `undefined` inside a key is rejected. Use `tenantId ?? null` to represent a missing value explicitly. A key is at most 64 KB and a result at most 1 MB. Save plain JSON, not clients, functions, dates, or schemas.
- Each definition or hook retains at most 4 MB of memo JSON, including digest keys. Memoize a collection rather than each row, and keep IDs instead of whole records.
- Identity includes the session and mounted definition. Separate files do not share memo results.
- Give multiple memos distinct keys, usually tuples such as `["tables", tenantId]` and `["flags", ctx.turn?.id ?? null]`. Reusing a key in one evaluation throws.
- Only keys used by the latest successful evaluation are retained. A skipped branch loses its observations; returning to it runs the callback again.
- A failing memo keeps no result. Successful memos survive a later error in the definition if they fit alongside its prior memo state. If that merge exceeds 4 MB, eve keeps the prior state; new memos run again on the next evaluation.
- Deployment changes discard memos. They are a cache, not an effect ledger.
- Memos can run concurrently with `Promise.all`, but cannot nest. Await every memo before returning.
- Results are private checkpointed state, never public stream events.

A memo callback receives `{ idempotencyKey, abortSignal }`. Pass the key to an external service that supports idempotency: an interrupted step can retry before its result commits. The key is stable per session, definition, and memo key, so it also repeats when a deployment change or a skipped branch makes the same key run again. Send a key of your own when a run needs a fresh response. Use [hooks](./hooks) or tool execution for effects rather than performing them while computing a capability.

## Dynamic models

The agent's `model` field accepts a dynamic function. It must return a concrete model ID, a provider instance, or a selection containing `model` and optional model settings. A missing or invalid model fails the turn. `ctx.model` is unavailable here; selection runs first.

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

Filesystem resources still compile, including the child's tools, instructions, skills, and nested subagents. The dynamic config supplies runtime settings. Local child configs require a static string model ID. Put packaging configuration such as `build.externalDependencies` on the root agent, not beside or inside the dynamic function. Build and Workflow-world configuration cannot be chosen at runtime.

Single-file remote subagents return `defineRemoteAgent(...)` or `null`. Their URL is a string; compute it in the dynamic function. Credentials can close over memo results. Later requests to the same child rebuild those credentials from the session as it was when the child was opened, not from a newer caller. The rebuild fails if it reads a memo the child wasn't opened with, or if the child's name or URL changed. `ctx.messages()` is unavailable during that rebuild; keep conversation-based decisions inside a memo. See [Remote agents](./remote-agents).

Availability is capability composition, not an authorization boundary. Sensitive child tools still need authorization and approval checks.

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

The memo saves account metadata, not tokens. Auth and header callbacks run when needed. Set `instanceKey` to a stable, non-secret account identifier and change it when the endpoint, account, or auth provider changes. eve rejects a parked authorization callback if its connection instance changed.

Connections use the same filtering, provided arguments, and approval options as static [MCP](../connections/mcp) and [OpenAPI](../connections/openapi) connections. Each evaluation refreshes connection callbacks, even when the endpoint is unchanged; per-step clients may be replaced. Do not rely on a dynamic MCP protocol session surviving between model calls. Models discover connection tools through `eve__search` and call them through `eve__tool`.

## Dynamic tools

Return a single `defineTool(...)`, a map of tools, or `null`. Executors receive the same `ToolContext` as static authored tools, including `ctx.getToken` and `ctx.requireAuth`. Input and output validators remain live authored code, including refinements and transformations, and so is an `endsTurn` function, which decides from the call's output whether the turn ends, as on a static tool.

### Author replayable callbacks

Build callbacks and schemas with ordinary code. Save observations in memos when a fresh process must rebuild from the same data. Values fetched outside a memo are fetched again during reconstruction. Avoid `Math.random()` and `Date.now()` in declarations unless their result is memoized; prefer `ctx.now` for commit time.

### Create dynamic tools in a package

Packages can return ordinary `defineTool` values, including callbacks made by factories. There is no separate callback-registration API; `defineDurableCallback` and `defineDurableSchema` were removed. Prefer an [extension](../extensions) when distributing a namespaced collection of capabilities.

### Identity and redeploys

A fresh process rebuilds tools by evaluating their definitions with saved memo results. Deployment changes discard those results and evaluate under the new code. Approved work runs before the next ordinary model-call evaluation. Check authorization inside execution when a check must also stop already-approved work.

A call waiting for approval or sign-in runs only if its dynamic tool, dynamic connection, or dynamic subagent is unchanged. eve compares what the model was offered, a connection's target, or a subagent's selection, plus the memo results its definition used. If any of these changed, the call returns a tool error saying the tool changed since it was offered. The model can request it again.

### Naming

A single tool takes the file's slug. A map uses bare keys, with no automatic file prefix: `agent/tools/tenant.ts` returning `{ query, export }` exposes `query` and `export`.

Names use ASCII letters, digits, underscores, and dashes, start with a letter, and contain at most 64 characters. `eve` and the `eve__` prefix are reserved. A connection owns its name and its `<name>__` prefix, so tools cannot take those names.

### Conflicts

Dynamic tools, connections, and skills can override authored static capabilities of the same kind by name. Two dynamic connection definitions cannot emit the same name. For tools and skills, the earlier definition keeps a duplicate name and eve logs an error for the other. Dynamic tools cannot take workflow-tool or subagent names. Other invalid results and name conflicts fail the turn rather than silently omitting capabilities.

<span id="events"></span>

### Steering and sign-in

Every ordinary model call evaluates dynamic values against the latest committed session. A steering message or completed sign-in is therefore visible without starting a new turn. A turn-keyed memo stays fixed until a new turn.

### Execution order

Hooks finish first, then model selection, then connections, subagents, tools, skills, and instructions. Do not depend on cross-file evaluation order; each definition computes its own value.

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

A skill with only `content` does not start a sandbox. Skills with files install their package in the sandbox; changed packages replace earlier files:

- Installing does not delay the model call: eve writes the package in the background, and a tool or hook that uses the sandbox waits until the write finishes.
- If the write fails twice in a row, eve logs a warning and writes the package again on the next model call.
- When the session detects that its sandbox was recreated, the next evaluation reinstalls the package even when its content is unchanged. A replacement made by a subagent or workflow step sharing that sandbox may go undetected; in that case the files are not rewritten until the package changes.
- Omitting `files` from a skill that remains available keeps its installed files; withdraw the skill to remove them.

Keep caller-specific instructions in `content`, or withdraw the skill when the caller should no longer have its files.

`deferred: true` keeps a skill out of the announcement, while leaving it discoverable through `eve__search` and loadable with `eve__skill`.

## Dynamic instructions

Return `defineInstructions({ content, role? })` or `null`. System instructions apply while returned and stay outside history. User instructions join durable history only when their content changes:

```ts title="agent/instructions/brief.ts"
import { defineDynamic, defineInstructions } from "eve/instructions";
import { loadBrief } from "../lib/briefs";

export default defineDynamic(async (ctx) => {
  if (!ctx.turn) return null;
  const brief = await ctx.memo(ctx.turn.id, () => loadBrief(ctx.session.auth.current));
  return brief ? defineInstructions({ content: brief, role: "user" }) : null;
});
```

Before a turn's first model call, new user content joins just before the turn's input. Mid-turn changes append at the current position. Returning `null` adds nothing and resets content tracking: returning the earlier content later adds it again. It does not remove earlier history. Clear and compaction do not cause unchanged content to append again, and content digests survive deployment changes.

## Errors and recovery

An unhandled error in a dynamic function or memo fails the turn with `REACTION_FAILED`. Catch optional work explicitly and return `null` if it should contribute nothing. A catch around `await ctx.memo(...)` leaves a failed observation uncached; catching inside the memo and returning `null` caches that null for the key's lifetime.

With `EVE_LOG_LEVEL=debug`, eve logs each memo run with its file, the key's digest, the reason (`new key` or `deployment change`), and its duration. Logs never include the key itself. The digest is an unsalted hash, not a secret: someone who can guess a key, such as a tenant ID, can confirm it against the digest. Each evaluation also logs whether its value changed.

A later evaluation can retry a failed memo. A failed turn's input is not automatically replayed. External effects must tolerate retries; use service-side idempotency rather than relying on memo caching.

## What to read next

- [Hooks](./hooks) for effects and cancellation
- [Subagents](../subagents) and [Remote agents](./remote-agents)
- [Connections](../connections), [Tools](../tools), and [Skills](../skills)
- [State](../concepts/state) for durable application state
- [Memory](../memory) for cross-session recall and provider tools
