---
title: "Memory"
description: "Recall and capture scoped, cross-session context with a custom eve memory provider."
---

Memory connects an agent to application-owned storage that can outlive one
session. A provider recalls relevant context before a turn, can capture the
settled conversation afterward, and can expose tools that operate on the same
locked scope.

eve owns the lifecycle and model-facing history. Your provider owns storage,
retrieval, retention, and deletion. M1 does not include a built-in filesystem
provider.

## Add a memory slot

Create `agent/memory.ts` for one slot named `memory`, or use
`agent/memory/<slot>.ts` for named slots. These forms are mutually exclusive.

```ts title="agent/memory/profile.ts"
import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { profileStore } from "../lib/profile-store";

export default defineMemory({
  description: "Manage durable facts and preferences for the current caller.",
  scope: byPrincipal,
  provider: {
    async recall(ctx) {
      const profile = await profileStore.get(ctx.memory.scope.key);
      if (profile === null) return null;

      return {
        messages: [{ id: "profile", content: JSON.stringify(profile) }],
      };
    },

    async capture(ctx) {
      if (ctx.phase !== "turn.completed") return;
      await profileStore.observe(ctx.memory.scope.key, ctx.messages, {
        operationId: ctx.operationId,
      });
    },

    async tools(ctx) {
      return {
        save: defineTool({
          description: "Save one durable profile fact.",
          inputSchema: z.object({ key: z.string(), value: z.string() }),
          async execute(input) {
            await profileStore.put(ctx.memory.scope.key, input);
            return { saved: true };
          },
        }),
      };
    },
  },
});
```

The filename is the slot name. The provider tool above is exposed as
`profile__save`; the slot description is prepended to the tool description.
Provider tools are ordinary `defineTool()` values, so schemas, approvals, and
`toModelOutput` work normally. Their callbacks remain replayable after a
process restart or deployment.

Use `defineMemoryProvider()` when several slots share a provider factory or
when you want its contract checked separately:

```ts
import { defineMemoryProvider } from "eve/memory";

export const provider = defineMemoryProvider({
  async recall(ctx) {
    return await recallFromStore(ctx.memory.scope.key, ctx.messages);
  },
});
```

## Choose a scope

`scope` decides who or what shares memory. It accepts a string, a tuple of
strings, `null`, or a resolver. Resolve tenant and caller identity from trusted
authentication or channel metadata, never from model input:

```ts title="agent/memory/account.ts"
import { defineMemory } from "eve/memory";

export default defineMemory({
  scope: (ctx) => {
    const caller = ctx.session.auth.current;
    const tenantId = caller?.attributes.tenantId;

    if (caller?.principalType !== "user" || typeof tenantId !== "string") {
      return null;
    }

    return [tenantId, caller.principalId];
  },
  provider,
});
```

Returning `null` disables the slot for that operation. eve does not call its
namespace resolver, provider, or tools, and it never falls back to a shared
scope. In `eve dev`, a diagnostic names the disabled slot and the resolver
that returned `null`, without logging the resolved value.

`byPrincipal` uses `auth.current`. It disables memory for anonymous and runtime
principals and returns the shared `local-dev` scope during local development.
Use a custom resolver when the boundary also needs a tenant, channel, or
conversation identifier.

eve validates the namespace and scope, then gives the provider:

- `memory.scope.key`: a versioned, opaque digest for storage lookup;
- `memory.scope.namespace`: the resolved namespace;
- `memory.scope.value`: the resolved string or tuple;
- `memory.slot`: the path-derived slot name.

Use `memory.scope.key` as the provider partition key. It preserves tuple
boundaries and does not persist raw scope components in eve's durable
attribution.

## Choose a namespace

The namespace separates an application's memory domains before scope is
applied. Omit `namespace` for `defaultNamespace`, which includes the graph
node and slot plus a deployment-aware identity:

- production and other Vercel environments use the project and environment;
- Preview also uses the branch or deployment identity;
- local development uses a digest of the application root, never the raw path.

Redeployments keep the same production namespace. Preview branches do not
share memory accidentally. Set a string or resolver for an explicit domain:

```ts
export default defineMemory({
  namespace: "acme-support-v1",
  scope: byPrincipal,
  provider,
});
```

A custom namespace is complete; eve adds no hidden suffix. Returning `null`
disables the slot. Scope resolves first, so a disabled scope never invokes the
namespace resolver.

## Recall behavior

`recall()` runs before the model and after a compaction checkpoint. It returns
`{ messages }`, `null`, or `undefined`. Each recalled item becomes an untrusted
user-role message; provider content is never promoted to system instructions.

```ts
return {
  messages: [
    { id: "preferred-language", content: "The user prefers Spanish." },
    { content: "A relevant note without a stable identity." },
  ],
};
```

Use stable `id` values for replaceable facts. A later item with the same ID in
the same slot, namespace, and scope supersedes the earlier value. An identical
value is a no-op. Items without IDs accumulate, even when their content is
identical. Omitting an earlier item from a later result does not delete it.

All active slots lock their scopes before any recall runs. They see the same
pre-recall history, and eve commits their validated results atomically. Each
call receives a stable `operationId`; use it as an idempotency key for writes
performed by `capture()`.

The default `visibility: "scope"` hides a slot's prior recalled records when
its scope changes. Set `visibility: "session"` only when those records are
safe to retain for the rest of the session across scope changes. Namespace
and slot boundaries still apply.

## Lifecycle and compaction

| Phase                  | Provider call | Context                                                    |
| ---------------------- | ------------- | ---------------------------------------------------------- |
| `turn.started`         | `recall`      | History before recall; current delivery is in `turn.input` |
| `turn.completed`       | `capture`     | Settled, projected history after a successful turn         |
| `compaction.requested` | `capture`     | Projected history before the checkpoint changes            |
| `compaction.completed` | `recall`      | The checkpoint plus canonical recalled records             |

Compaction excludes recalled records from the summarizer, preserves only the
latest keyed values plus unkeyed values, then recalls again against the new
checkpoint. This keeps provider context attributable and prevents a summary
from turning it into ordinary conversation history.

If raw superseded records exceed 512 entries or 256 KiB, eve can canonicalize
them without waiting for the normal token threshold. This folds superseded
records without changing the provider's external storage.

`clear()` removes conversation history, recalled records, locked scopes, and
memory replay bookkeeping from the session. It does not delete data in the
provider's external store. A later turn can recall that data again.

## Failure behavior

- A throwing or invalid turn-start recall fails before the model call. No
  slot's recall results are committed.
- A pre-compaction capture failure leaves history unchanged.
- A post-compaction recall failure fails an automatic turn. Standalone
  compaction reports a diagnostic and returns the session to waiting because
  the checkpoint has already been written.
- An invalid or throwing `tools()` result is diagnosed and omitted for that
  turn.
- A completed-turn capture failure is diagnosed after the response and does
  not rewrite the completed turn.

Keep provider operations idempotent, enforce backend size and retention
policies, and treat recalled content as user-controlled data.

## Limits and overrides

Namespaces, scope components, and provider item IDs are limited to 1,024 UTF-8
bytes. Scope tuples accept at most 16 non-empty components, and the combined
canonical namespace and scope input is limited to 4,096 bytes. Provider tool
names must satisfy the normal tool-name grammar after the `<slot>__` prefix is
added.

Set `tools: false` to disable a provider's tool factory while keeping recall
and capture. An application-owned `agent/tools/<slot>.ts` also replaces the
generated provider-tool wrapper; export `disableTool()` there to remove it.
Extensions cannot contribute memory slots because scope and lifecycle
ownership remain with the consuming agent or subagent.

## What to read next

- [Multi-tenant memory](./patterns/multi-tenant-memory): define a tenant and
  caller scope for an application store.
- [State](./concepts/state): keep durable working data inside one session.
- [Default harness](./concepts/default-harness): understand compaction and
  context controls.
- [Dynamic capabilities](./guides/dynamic-capabilities): understand the
  ordinary dynamic-tool lifecycle used by provider tools.
