---
title: "File Memory"
description: "Configure the built-in fileMemory() provider: a bounded, model-maintained document per scope with save and remove tools."
---

`fileMemory()` from `eve/memory/file` is the memory provider built into eve. It
keeps one small document for each scope, such as each signed-in user, and gives
the model tools to edit it. Use it for a short list of facts and preferences
that later sessions need. For search over many records or automatic capture, use
[another provider](/docs/memory#choose-a-provider).

```text
agent/
  memory/
    file.ts   # the "file" slot
```

Add file memory from an eve project:

```bash
eve add memory/file
```

The command writes:

```ts title="agent/memory/file.ts"
import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";
import { fileMemory } from "eve/memory/file";

export default defineMemory({
  // optional: prepended to the save and remove tool descriptions
  description: "Remember stable facts and preferences about the caller.",
  // omit options to use the defaults in the options table
  provider: fileMemory(),
  // required: one document for each signed-in caller
  scope: byPrincipal,
});
```

Choose **Install and set up** to provision storage. eve creates or reuses one
private Vercel Blob store for the linked project. It connects the store to
production, preview, and development using OIDC, then pulls the updated
environment. The store uses the project's first configured function region, or
`iad1`. Blob usage may incur charges.

## How it behaves

Before each turn, the provider gives the model the whole document as one
message. The model edits the document with two tools, `file__save_memory` and
`file__remove_memory`, where `file` is the slot name. The provider saves nothing
unless the model calls a tool.

- Each saved entry gets a permanent number. The model removes an entry by that
  number.
- An updated or emptied document replaces the copy the model saw earlier in the
  session.
- Saving text identical to an existing entry does nothing.
- Saves and removals that run at the same time on one document don't overwrite
  each other.

The provider rejects a save that exceeds a limit. It doesn't shorten the entry
or delete older entries:

| Limit            | Value                                            |
| ---------------- | ------------------------------------------------ |
| Recalled message | `maxCharacters` characters                       |
| One entry        | 2,048 UTF-8 bytes after whitespace normalization |
| Stored document  | 65,536 bytes                                     |

## Options

| Option          | Default                                                          | Effect                                                                           |
| --------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `maxCharacters` | `4_000`                                                          | Caps the full message the model sees, including its heading and removal guidance |
| `backend`       | Chosen by environment; see [Storage backends](#storage-backends) | Where the document is stored                                                     |

```ts
provider: fileMemory({ maxCharacters: 8_000 });
```

## Storage backends

The document lives in a backend, not in the agent's sandbox filesystem. Omit
`backend` to let `fileMemory()` select one on first use:

| Environment                                                       | Backend                                                                      |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Vercel with Blob credentials (token, or attached store with OIDC) | Private Vercel Blob                                                          |
| Vercel without Blob configuration                                 | Error recommending `/add memory/file` or `eve integration setup file-memory` |
| `eve dev`                                                         | Shared process-local in-memory storage                                       |
| Every other environment                                           | Error asking you for an explicit backend                                     |

`NODE_ENV=development` alone does not select in-memory storage. A Blob token
outside Vercel does not select Blob.

### In-memory

Pass an in-memory backend for tests or throwaway environments. It loses its
contents when the backend instance or process is replaced:

```ts
import { fileMemory, inMemory } from "eve/memory/file";

provider: fileMemory({ backend: inMemory() });
```

### Vercel Blob

Setup connects the store with the `EVE_MEMORY_BLOB` prefix, so file memory
doesn't use an application's own Blob store. The connection sets
`EVE_MEMORY_BLOB_STORE_ID` and `EVE_MEMORY_BLOB_WEBHOOK_PUBLIC_KEY` without a
read-write token. File memory needs only the store ID, because Vercel supplies
the OIDC token. File memory doesn't use the webhook public key.

`fileMemory()` checks Vercel configuration in this order:

1. `EVE_MEMORY_BLOB_STORE_ID` with Vercel OIDC from the environment or request context
2. `EVE_MEMORY_BLOB_READ_WRITE_TOKEN`
3. `BLOB_STORE_ID` with Vercel OIDC from the environment or request context
4. `BLOB_READ_WRITE_TOKEN`

Prefer OIDC on Vercel, which needs no read-write token or copied
`VERCEL_OIDC_TOKEN`. Use the generic `BLOB_*` variables for a store you attach
manually. Redeploy after you connect the store, because project environment
variable changes apply only to new deployments.

If setup stopped after it created or connected the store, run it again. This
command doesn't reinstall the memory definition:

```bash
eve integration setup file-memory
```

Setup repairs the unconnected private store that a partial run left. It reuses
a complete `EVE_MEMORY_BLOB` connection. It never adopts an arbitrary
application store, changes a `BLOB_*` connection, or replaces a public or
incompatible store. If the project moves to another primary region, setup keeps
the existing store and warns about the difference.

Use `vercelBlob()` from `eve/memory/file/vercel` to set credentials or an object
prefix in code instead of from the environment:

```ts
import { fileMemory } from "eve/memory/file";
import { vercelBlob } from "eve/memory/file/vercel";

provider: fileMemory({
  backend: vercelBlob({ prefix: "eve/memory/support-agent" }),
});
```

`vercelBlob()` accepts `token`, `oidcToken`, `storeId`, and `prefix`, which
override the environment defaults. Documents are stored privately under
`prefix`. Omit `prefix` to use `eve/memory/file`. Leave `oidcToken` unset on
Vercel so the token refreshes automatically.

### Custom backend

Implement `MemoryDocumentBackend` from `eve/memory/file` to keep the document in
another store:

```ts
import { MemoryDocumentConflictError, type MemoryDocumentBackend } from "eve/memory/file";

export function kvBackend(store: KvStore): MemoryDocumentBackend {
  return {
    async read({ key, signal }) {
      signal.throwIfAborted();
      const row = await store.get(key);
      // null means the document doesn't exist yet
      return row ? { content: row.content, version: row.version } : null;
    },
    async write({ key, content, expectedVersion, signal }) {
      signal.throwIfAborted();
      // write the complete document only if the stored version still matches
      const ok = await store.compareAndSet(key, content, expectedVersion);
      if (!ok) throw new MemoryDocumentConflictError(key);
      return { content, version: await store.version(key) };
    },
  };
}
```

`write()` replaces the complete document. It must throw
`MemoryDocumentConflictError` when the stored version doesn't match
`expectedVersion`. An `expectedVersion` of `null` means the document must not
exist yet.

Both methods receive a `signal: AbortSignal`. Check it before starting work, and
pass it to storage calls that support cancellation. Memory and tool contexts
expose the same signal as `ctx.abortSignal`.

## Troubleshooting

| What you see                                                            | What to do                                                                                                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `fileMemory() requires Vercel Blob storage.`                            | Run `eve integration setup file-memory`, then redeploy. Or pass `fileMemory({ backend })`.                                      |
| `fileMemory() requires an explicit backend outside Vercel and eve dev.` | Pass `fileMemory({ backend })`, because only Vercel and `eve dev` have a default backend.                                       |
| `Memory would exceed the configured 4,000-character limit.`             | Have the model remove outdated entries, or raise `maxCharacters`.                                                               |
| Setup reports that a store has an incompatible eve file-memory prefix   | Reconnect the store in Vercel with the `EVE_MEMORY_BLOB` prefix and OIDC, then redeploy. Keeping the store keeps its documents. |

## Choose another provider

A backend changes only where the document is stored, not the recall format or
tools. For different retrieval, capture, or tools,
[build a memory provider](./custom-provider) instead.
