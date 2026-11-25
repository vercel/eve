import type { Entities } from "#platform/entities.js";
import type { MemoryDocumentBackend } from "#public/memory/file/backend.js";

export function defaultDocumentBackend(platform: Entities): MemoryDocumentBackend | undefined {
  return platform.storage.documents;
}
