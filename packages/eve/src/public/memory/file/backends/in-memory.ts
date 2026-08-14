import { randomUUID } from "node:crypto";

import {
  MemoryDocumentConflictError,
  type MemoryDocument,
  type MemoryDocumentBackend,
} from "#public/memory/file/backend.js";

/** Optional shared storage for {@link inMemory}. */
interface InMemoryBackendOptions {
  readonly store?: Map<string, MemoryDocument>;
}

/**
 * Creates a process-local document backend for development and tests.
 * Contents disappear when the process or backend instance is replaced.
 */
export function inMemory(options: InMemoryBackendOptions = {}): MemoryDocumentBackend {
  const store = options.store ?? new Map<string, MemoryDocument>();
  const instanceId = randomUUID();
  let revision = 0;

  return {
    async read({ key, signal }) {
      signal.throwIfAborted();
      const document = store.get(key);
      return document === undefined ? null : { ...document };
    },
    async write({ content, expectedVersion, key, signal }) {
      signal.throwIfAborted();
      const current = store.get(key);
      if ((current?.version ?? null) !== expectedVersion) {
        throw new MemoryDocumentConflictError(key);
      }
      const document = { content, version: `mem_${instanceId}_${++revision}` };
      store.set(key, document);
      return { ...document };
    },
  };
}
