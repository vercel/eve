import type { Entities } from "#platform/entities.js";
import { vercelDefaultDocumentBackend } from "#platform/vercel/memory.js";
import type { MemoryDocumentBackend } from "#public/memory/file/backend.js";

export function defaultDocumentBackend(
  platform: Entities | undefined,
): MemoryDocumentBackend | undefined {
  return platform === undefined ? vercelDefaultDocumentBackend() : platform.storage.documents;
}
