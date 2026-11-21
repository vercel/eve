import { platformContext } from "#platform/context.js";
import { hostService } from "#platform/services.js";
import { vercelDefaultDocumentBackend } from "#platform/vercel/memory.js";
import type { MemoryDocumentBackend } from "#public/memory/file/backend.js";

export function defaultDocumentBackend(): MemoryDocumentBackend | undefined {
  return hostService(platformContext(), "documentStore", vercelDefaultDocumentBackend);
}
