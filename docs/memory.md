---
title: "Memory"
description: "Connect scoped, cross-session context to built-in, third-party, or custom memory providers."
---

Memory is a provider-backed capability for context that outlives one session.
Each memory slot binds a provider to an eve-managed scope and visibility
policy. The provider decides how to retrieve relevant context, whether to
capture conversation history, and which model-facing operations to offer.

Breaking down the boundary between eve and the provider:

| eve owns                                                         | The provider owns                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------- |
| Path-derived slots and qualified provider-tool names             | Storage and indexing                                    |
| Namespace and trusted scope resolution                           | Retrieval, ranking, and formatting                      |
| Lifecycle timing, recalled-message attribution, and supersession | Capture and extraction                                  |
| Recall visibility in model context                               | Retention, deletion, and model-facing memory operations |

This lets a bounded text file, a hosted semantic-memory service, or an
application-specific store participate in the same agent lifecycle without
sharing a storage model.

## Choose a provider

Every memory slot needs a provider. Choose one based on how the agent should
recall and maintain memory:

| Provider        | Status         | Use it for                                                                |
| --------------- | -------------- | ------------------------------------------------------------------------- |
| `fileMemory()`  | Built into eve | A bounded, model-maintained list of durable facts and preferences         |
| Supermemory     | Coming soon    | The first third-party implementation of the eve provider contract         |
| Custom provider | Supported      | Application-specific retrieval, capture, retention, or model-facing tools |

Supermemory is building the first third-party provider for eve. It is not
available yet; until it is released, use `fileMemory()` or implement the
provider contract described below.

## Use file memory

`fileMemory()` is ready to use without implementing recall, capture, or memory
tools. It keeps one indexed document for each resolved scope, recalls that
document before each turn and after compaction, and gives the model
`save_memory` and `remove_memory` tools.

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

The filename creates the `profile` slot, so the provider tools are exposed as
`profile__save_memory` and `profile__remove_memory`. The slot description is
prepended to both tool descriptions to tell the model what belongs in this
slot.

File memory does not automatically extract facts from a conversation. The
model decides when to call its save and remove tools. Entries receive permanent
numeric indexes, and the provider recalls the document as one stable keyed
message so updated or empty documents replace stale context.

The provider rejects rather than truncates or evicts data. `maxCharacters`
defaults to 4,000 characters and caps the exact recalled message, including
its heading and removal guidance. Each normalized entry can contain up to
2,048 UTF-8 bytes, and the stored document can contain up to 65,536 bytes:

```ts
provider: fileMemory({ maxCharacters: 8_000 });
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
replaced. For another durable document store, implement `MemoryDocumentBackend`
from `eve/memory/file`. Its `write()` method conditionally replaces the complete
document and must throw `MemoryDocumentConflictError` when `expectedVersion`
is stale. Use `vercelBlob()` from `eve/memory/file/vercel` to configure Vercel
Blob credentials or an object prefix explicitly.

A file backend changes where `fileMemory()` stores its document. It does not
change file memory's recall behavior or tools. Implement a memory provider
instead when you need semantic retrieval, automatic capture, or different
model-facing operations.

## Add a memory slot

Create `agent/memory.ts` for one slot named `memory`, or use
`agent/memory/<slot>.ts` for multiple named slots. The flat file and directory
forms are mutually exclusive:

```text
agent/
  memory/
    profile.ts
    workspace.ts
```

Each slot independently binds a provider, description, scope, namespace, and
visibility policy. The same provider can back several slots without merging
their recalled context or tools. The default namespace includes the slot name,
so `profile` and `workspace` remain separate even if both resolve the same
scope.

For example, `profile.ts` can use `fileMemory()` with `byPrincipal`, while
`workspace.ts` uses another `fileMemory()` instance with a trusted workspace
scope:

```ts title="agent/memory/workspace.ts"
import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";

export default defineMemory({
  description: "Remember shared conventions for the authenticated workspace.",
  provider: fileMemory(),
  scope(ctx) {
    const workspaceId = ctx.session.auth.current?.attributes.workspaceId;
    return typeof workspaceId === "string" ? workspaceId : null;
  },
});
```

## Choose a scope

`scope` decides who or what shares a slot's memory. Set it to a string or
`null`, or use a resolver that returns a string, a tuple of strings, or `null`.
Resolve tenant and caller identity from trusted authentication or channel
metadata, never from model input:

```ts title="agent/memory/account.ts"
import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";

export default defineMemory({
  provider: fileMemory(),
  scope(ctx) {
    const caller = ctx.session.auth.current;
    const tenantId = caller?.attributes.tenantId;

    if (caller?.principalType !== "user" || typeof tenantId !== "string") {
      return null;
    }

    return [tenantId, caller.principalId];
  },
});
```

Returning `null` disables the slot for that operation. eve does not call its
namespace resolver, provider, or tools, and it never falls back to a shared
scope. In `eve dev`, a diagnostic names the disabled slot and the resolver
that returned `null`, without logging the resolved value.

`byPrincipal` uses `auth.current`. It disables memory for anonymous and runtime
principals and returns the shared `local-dev` scope during local development.
Use a custom resolver when the boundary also needs a tenant, channel, or
conversation identifier. See [Multi-tenant memory](./patterns/multi-tenant-memory)
for a complete scoped setup.

eve validates and locks the namespace and scope before calling the provider.
Every provider operation receives:

- `memory.scope.key`: a versioned, opaque digest for storage lookup;
- `memory.scope.namespace`: the resolved namespace;
- `memory.scope.value`: the resolved string or tuple;
- `memory.slot`: the path-derived slot name.

Providers must use `memory.scope.key` as the partition key for every read and
write. The key preserves tuple boundaries and keeps raw scope components out of
eve's durable attribution.

## Choose visibility

`visibility` controls which previously recalled records eve includes in model
context after a slot's scope changes. It does not change the scope passed to
the provider.

| Value               | Behavior after a scope change                                      |
| ------------------- | ------------------------------------------------------------------ |
| `"scope"` (default) | Hide recalled records from the slot's earlier scope                |
| `"session"`         | Keep earlier recalled records visible within the current namespace |

Use `"session"` only when every scope that can appear in the session belongs
to one trusted audience:

```ts
export default defineMemory({
  provider: fileMemory(),
  scope: byPrincipal,
  visibility: "session",
});
```

Namespace remains an isolation boundary in both modes. Applications that need
hard isolation between participants must use separate sessions; visibility
cannot undo information already included in an assistant response.

## Choose a namespace

The namespace separates an application's memory domains before scope is
applied. Omit `namespace` to use `defaultNamespace`, which includes the graph
node and slot plus a deployment-aware identity:

- Production and other Vercel environments use the project and environment.
- Preview also uses the branch or deployment identity.
- Local development uses a digest of the application root, never the raw path.

Redeployments keep the same production namespace, while unrelated Preview
branches do not share memory accidentally. Set a string or resolver when you
need an explicit application domain:

```ts
export default defineMemory({
  namespace: "acme-support-v1",
  provider: fileMemory(),
  scope: byPrincipal,
});
```

A custom namespace is complete; eve adds no hidden suffix. Returning `null`
disables the slot. Scope resolves first, so a disabled scope never invokes the
namespace resolver.

## Build a custom provider

Build a provider when the available providers do not match your storage or
retrieval model. Most application authors do not need this layer: a provider
package should expose a `MemoryProvider` or a configured provider factory that
you pass to `defineMemory()`.

A provider can implement three surfaces:

| Surface   | Responsibility                                                           |
| --------- | ------------------------------------------------------------------------ |
| `recall`  | Return relevant messages at turn start and, optionally, after compaction |
| `capture` | Observe settled history after a turn or before compaction                |
| `tools`   | Return model-facing operations bound to the same locked scope            |

The following is a conceptual skeleton, not a working provider. Each helper
deliberately throws until you connect it to a database or memory-service SDK:

```ts title="agent/lib/semantic-memory-provider.ts"
import {
  defineMemoryProvider,
  type MemoryOperationContext,
  type MemoryRecallResult,
  type MemoryToolsContext,
  type MemoryToolSet,
} from "eve/memory";

async function recallFromYourService(_ctx: MemoryOperationContext): Promise<MemoryRecallResult> {
  throw new Error("Replace with retrieval from your memory service.");
}

async function captureWithYourService(_ctx: MemoryOperationContext): Promise<void> {
  throw new Error("Replace with capture into your memory service.");
}

async function createToolsForYourService(_ctx: MemoryToolsContext): Promise<MemoryToolSet | null> {
  throw new Error("Replace with tools backed by your memory service.");
}

export const semanticMemoryProvider = defineMemoryProvider({
  recall: {
    "turn.started": recallFromYourService,
    "compaction.completed": recallFromYourService,
  },
  capture: {
    "turn.completed": captureWithYourService,
    "compaction.requested": captureWithYourService,
  },
  tools: createToolsForYourService,
});
```

Omit any optional handler that the provider does not need. For example,
`fileMemory()` implements recall and tools but no automatic capture. After
replacing the stubs, bind the provider to a slot like any other provider:

```ts title="agent/memory/profile.ts"
import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";
import { semanticMemoryProvider } from "../lib/semantic-memory-provider";

export default defineMemory({
  provider: semanticMemoryProvider,
  scope: byPrincipal,
});
```

Provider tools are ordinary `defineTool()` values, so schemas, approvals, and
`toModelOutput` work normally. eve qualifies each returned key with the slot
name and keeps its callback replayable after a process restart or deployment.

## Recall behavior

`recall["turn.started"]` is required and runs before the model.
`recall["compaction.completed"]` is optional and runs after a compaction
checkpoint. A recall handler returns `{ messages }`, `null`, or `undefined`.
Each recalled item becomes an untrusted user-role message; provider content is
never promoted to system instructions.

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
call receives a stable `operationId`; providers can use it as an idempotency
key for writes performed by capture handlers.

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

Provider operations should be idempotent, enforce their own size and retention
policies, and treat recalled content as user-controlled data.

## Limits and overrides

Namespaces, scope components, and provider item IDs are limited to 1,024 UTF-8
bytes. Scope tuples accept at most 16 non-empty components, and the combined
canonical namespace and scope input is limited to 4,096 bytes. Provider tool
names must satisfy the normal tool-name grammar after the `<slot>__` prefix is
added.

An application-owned `agent/tools/<slot>.ts` replaces the generated
provider-tool wrapper; export `disableTool()` there to remove it. Extensions
cannot contribute memory slots because scope and lifecycle ownership remain
with the consuming agent or subagent.

## What to read next

- [Multi-tenant memory](./patterns/multi-tenant-memory): isolate any provider by
  authenticated tenant and caller.
- [State](./concepts/state): keep durable working data inside one session.
- [Default harness](./concepts/default-harness): understand compaction and
  context controls.
- [Dynamic capabilities](./guides/dynamic-capabilities): understand the
  ordinary dynamic-tool lifecycle used by provider tools.
