---
title: "File Memory"
description: "Configure the built-in fileMemory() provider: a bounded, model-maintained document per scope with save and remove tools."
---

`fileMemory()` from `eve/memory/file` is the memory provider built into eve.
It keeps one small document per resolved scope, recalls that document before
each turn and after compaction, and gives the model two tools to maintain it.
Use it when a short list of durable facts and preferences is enough; use
[another provider](/docs/memory#choose-a-provider) when you need semantic
retrieval or automatic capture.

Add and provision file memory from an eve project:

```bash
eve add memory/file
```

After you choose **Install and set up**, eve creates or reuses one private
Vercel Blob store for the linked project, connects it to production, preview,
and development using OIDC, and pulls the updated environment. The connection
sets `EVE_MEMORY_BLOB_STORE_ID` and `EVE_MEMORY_BLOB_WEBHOOK_PUBLIC_KEY`
without adding a read-write token. It uses the project's first configured
function region, falling back to `iad1`. Blob usage may incur charges.

The registry writes:

```ts title="agent/memory/file.ts"
import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";
import { fileMemory } from "eve/memory/file";

export default defineMemory({
  description: "Remember stable facts and preferences about the caller.",
  provider: fileMemory(),
  scope: byPrincipal,
});
```

## How it behaves

The provider implements recall and tools but no automatic capture. The model
decides when to call `file__save_memory` and `file__remove_memory`, where
`file` is the slot name. The slot `description` is prepended to both tool
descriptions.

Each saved entry receives a permanent numeric index that the model uses to
remove it later. The provider recalls the whole document as one message with a
stable ID, so an updated or emptied document replaces the earlier recalled copy
rather than accumulating beside it.

The provider rejects writes that exceed its limits instead of truncating or
evicting older entries:

| Limit            | Value                                            |
| ---------------- | ------------------------------------------------ |
| Recalled message | `maxCharacters`, default 4,000                   |
| One entry        | 2,048 UTF-8 bytes after whitespace normalization |
| Stored document  | 65,536 bytes                                     |

`maxCharacters` caps the exact recalled message, including its heading and
removal guidance:

```ts
provider: fileMemory({ maxCharacters: 8_000 });
```

Saving text identical to an existing entry is a no-op. Concurrent writes to the
same document use optimistic versioning and retry on conflict.

## Storage backends

The document lives in a backend, not in the agent's sandbox filesystem. With no
`backend` option, `fileMemory()` selects one lazily on first use:

| Environment                                                       | Backend                                                                      |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Vercel with Blob credentials (token, or attached store with OIDC) | Private Vercel Blob                                                          |
| Vercel without Blob configuration                                 | Error recommending `/add memory/file` or `eve integration setup file-memory` |
| `eve dev`                                                         | Shared process-local in-memory storage                                       |
| Every other environment                                           | Error asking you for an explicit backend                                     |

`NODE_ENV=development` alone does not select in-memory storage, and a Blob
token outside Vercel does not select Blob.

### In-memory

Pass a fresh in-memory backend for tests or throwaway environments. It loses
its contents when the backend instance or process is replaced:

```ts
import { fileMemory, inMemory } from "eve/memory/file";

provider: fileMemory({ backend: inMemory() });
```

### Vercel Blob

Provisioned bindings use the `EVE_MEMORY_BLOB_*` namespace so file memory does
not take over an application's own Blob store. Vercel supplies the OIDC token;
the Blob SDK resolves the current token for each operation and handles refresh.
File-memory reads and writes need the store ID. The webhook public key is for upload callbacks
and is not used by file memory.

`fileMemory()` checks Vercel configuration in this order:

1. `EVE_MEMORY_BLOB_STORE_ID` with Vercel OIDC from the environment or request context
2. `EVE_MEMORY_BLOB_READ_WRITE_TOKEN`
3. `BLOB_STORE_ID` with Vercel OIDC from the environment or request context
4. `BLOB_READ_WRITE_TOKEN`

Prefer OIDC on Vercel. You do not need to set a read-write token or copy
`VERCEL_OIDC_TOKEN` into your configuration. Redeploy after connecting the
store: changes to project environment variables apply to new deployments.

Generic `BLOB_*` variables remain supported for a store you attach manually.
Run setup again without reinstalling the memory definition when a previous
attempt stopped after creating or connecting the store:

```bash
eve integration setup file-memory
```

Setup repairs the deterministic unconnected private store left by a partial
run and reuses a complete `EVE_MEMORY_BLOB` connection. If an earlier setup
created an `EVE_MEMORY_` connection, reconnect that same store with the
`EVE_MEMORY_BLOB` prefix and OIDC in Vercel, then redeploy. Keep the existing
store to preserve its memory documents. Setup does not adopt an arbitrary
application store, change a `BLOB_*` connection, or replace a public
or incompatible store. If the linked project later moves to another primary
region, setup preserves the existing memory store and warns about the drift
instead of risking data loss.

Use `vercelBlob()` from `eve/memory/file/vercel` to configure credentials or an
object prefix explicitly instead of relying on environment detection:

```ts
import { fileMemory } from "eve/memory/file";
import { vercelBlob } from "eve/memory/file/vercel";

provider: fileMemory({
  backend: vercelBlob({ prefix: "eve/memory/support-agent" }),
});
```

`vercelBlob()` accepts `token`, `oidcToken`, `storeId`, and `prefix`. The
default prefix is `eve/memory/file`; documents are stored privately under
`<prefix>/<scope key>/MEMORY.md`. Passing these options continues to override
the generic environment defaults directly. Leave `oidcToken` unset on Vercel
so the Blob SDK can manage token refresh.

### Custom backend

Implement `MemoryDocumentBackend` from `eve/memory/file` to keep the document in
another store:

```ts
import { MemoryDocumentConflictError, type MemoryDocumentBackend } from "eve/memory/file";

export function kvBackend(store: KvStore): MemoryDocumentBackend {
  return {
    async read({ key }) {
      const row = await store.get(key);
      return row ? { content: row.content, version: row.version } : null;
    },
    async write({ key, content, expectedVersion }) {
      const ok = await store.compareAndSet(key, content, expectedVersion);
      if (!ok) throw new MemoryDocumentConflictError(key);
      return { content, version: await store.version(key) };
    },
  };
}
```

`write()` replaces the complete document and must throw
`MemoryDocumentConflictError` when `expectedVersion` no longer matches. An
`expectedVersion` of `null` means the document must not exist yet.

A backend changes only where the document is stored. It does not change file
memory's recall format or tools. When you need different retrieval, capture, or
tools, [build a memory provider](./custom-provider) instead.
