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

## How it behaves

The provider implements recall and tools but no automatic capture. The model
decides when to call `profile__save_memory` and `profile__remove_memory`, where
`profile` is the slot name. The slot `description` is prepended to both tool
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

| Environment                                                       | Backend                                  |
| ----------------------------------------------------------------- | ---------------------------------------- |
| Vercel with Blob credentials (token, or attached store with OIDC) | Private Vercel Blob                      |
| Vercel without Blob configuration                                 | Error asking you to attach a Blob store  |
| `eve dev`                                                         | Shared process-local in-memory storage   |
| Every other environment                                           | Error asking you for an explicit backend |

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
`<prefix>/<scope key>/MEMORY.md`.

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
