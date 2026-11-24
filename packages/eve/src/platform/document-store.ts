import { installedPlatform } from "#platform/context.js";
import { vercelDefaultDocumentBackend } from "#platform/vercel/memory.js";
import type { MemoryDocumentBackend } from "#public/memory/file/backend.js";

export function defaultDocumentBackend(): MemoryDocumentBackend | undefined {
  const platform = installedPlatform();
  return platform === undefined ? vercelDefaultDocumentBackend() : platform.storage.documents;
}
