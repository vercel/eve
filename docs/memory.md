---
title: "Memory"
description: "Recall and capture scoped, cross-session context with built-in or custom eve memory providers."
---

Memory connects an agent to application-owned storage that can outlive one
session. A provider recalls relevant context before a turn, can capture the
settled conversation afterward, and can expose tools that operate on the same
locked scope.

eve owns the lifecycle and model-facing history. A provider owns storage,
retrieval, retention, and deletion. Use the built-in bounded file provider for
model-maintained facts, or implement a provider for application-specific
retrieval and capture.

## Use file memory

`fileMemory()` keeps one indexed document for each resolved scope and gives the
model `save_memory` and `remove_memory` tools. It recalls the document before
each turn and after compaction, but does not automatically extract facts from
the conversation.

```ts title="agent/memory/profile.ts"
import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";
import { fileMemory } from "eve/memory/file";

export default defineMemory({
  description: "Remember stable facts and preferences about the caller.",
  provider: fileMemory(),
  scope: byPrincipal,
});
```

The `profile` slot exposes `profile__save_memory` and
`profile__remove_memory`. Saved entries are normalized, assigned permanent
numeric indexes, and recalled as one stable keyed message. Removing an entry
replaces the previous recalled document at the next boundary, including when
the final entry is removed, so stale content does not remain in model context.

The provider rejects rather than truncates or evicts data. Each normalized
entry can contain up to 2,048 UTF-8 bytes; the stored document can contain up
to 65,536 bytes; and `maxEntries` defaults to 100 live entries:

```ts
provider: fileMemory({ maxEntries: 25 });
```

### Choose a file backend

With no `backend`, `fileMemory()` selects storage lazily:

| Environment                                                       | Backend                                  |
| ----------------------------------------------------------------- | ---------------------------------------- |
| Vercel with Blob credentials (token, or attached store with OIDC) | Private Vercel Blob                      |
| Vercel without Blob configuration                                 | Error asking you to attach a Blob store  |
| `eve dev`                                                         | Shared process-local in-memory storage   |
| Every other environment                                           | Error asking you for an explicit backend |

`NODE_ENV=development` alone does not select in-memory storage, and a Blob
token outside Vercel does not select Blob. For tests, pass a fresh in-memory
backend explicitly:

```ts
import { fileMemory, inMemory } from "eve/memory/file";

provider: fileMemory({ backend: inMemory() });
```

`inMemory()` loses its contents when its backend instance or process is
replaced. For another durable store, implement `MemoryDocumentBackend` from
`eve/memory/file`. Its `write()` method conditionally replaces the complete
document and must throw `MemoryDocumentConflictError` when `expectedVersion`
is stale. Use `vercelBlob()` from `eve/memory/file/vercel` when you want to
configure Vercel Blob credentials or an object prefix explicitly.

## Add a memory slot

Create `agent/memory.ts` for one slot named `memory`, or use
`agent/memory/<slot>.ts` for named slots. These forms are mutually exclusive.

```ts title="agent/memory/profile.ts"
import { defineMemory, type MemoryOperationContext } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { profileStore } from "../lib/profile-store";

async function recallProfile(ctx: MemoryOperationContext) {
  const profile = await profileStore.get(ctx.memory.scope.key);
  if (profile === null) return null;

  return {
    messages: [{ id: "profile", content: JSON.stringify(profile) }],
  };
}

export default defineMemory({
  description: "Manage durable facts and preferences for the current caller.",
  scope: byPrincipal,
  provider: {
    recall: {
      "turn.started": recallProfile,
      "compaction.completed": recallProfile,
    },

    capture: {
      async "turn.completed"(ctx) {
        await profileStore.observe(ctx.memory.scope.key, ctx.messages, {
          operationId: ctx.operationId,
        });
      },
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

Use `defineMemoryProvider()` when several slots share one provider or when you
want its contract checked separately:

```ts
import { defineMemoryProvider, type MemoryOperationContext } from "eve/memory";

async function recall(ctx: MemoryOperationContext) {
  return await recallFromStore(ctx.memory.scope.key, ctx.messages);
}

export const provider = defineMemoryProvider({
  recall: {
    "turn.started": recall,
    "compaction.completed": recall,
  },
});
```

## Choose a scope

`scope` decides who or what shares memory. Set it to a string or `null`, or use
a resolver that returns a string, a tuple of strings, or `null`. Resolve tenant
and caller identity from trusted authentication or channel metadata, never from
model input:

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

Register recall handlers under their lifecycle keys. `"turn.started"` is
required and runs before the model. `"compaction.completed"` is optional and
runs after a compaction checkpoint. A recall handler returns `{ messages }`,
`null`, or `undefined`. Each recalled item becomes an untrusted user-role
message; provider content is never promoted to system instructions.

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
performed by capture handlers.

The default `visibility: "scope"` hides a slot's prior recalled records when
its scope changes. Set `visibility: "session"` only when those records are
safe to retain for the rest of the session across scope changes. Namespace
and slot boundaries still apply.

## Lifecycle and compaction

| Phase                  | Provider handler                  | Context                                                    |
| ---------------------- | --------------------------------- | ---------------------------------------------------------- |
| `turn.started`         | `recall["turn.started"]`          | History before recall; current delivery is in `turn.input` |
| `turn.completed`       | `capture["turn.completed"]`       | Settled, projected history after a successful turn         |
| `compaction.requested` | `capture["compaction.requested"]` | Projected history before the checkpoint changes            |
| `compaction.completed` | `recall["compaction.completed"]`  | The checkpoint plus canonical recalled records             |

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
