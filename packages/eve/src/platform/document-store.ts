import { platformHook } from "#platform/capabilities.js";
import { platformContext } from "#platform/context.js";
import { vercelDefaultDocumentBackend } from "#platform/vercel/memory.js";
import type { MemoryDocumentBackend } from "#public/memory/file/backend.js";

export function defaultDocumentBackend(): MemoryDocumentBackend | undefined {
  return platformHook(platformContext(), "documentStore", vercelDefaultDocumentBackend)?.();
}
