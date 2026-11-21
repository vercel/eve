import { platformContext, type PlatformTarget } from "#platform/context.js";
import type { MemoryDocumentBackend } from "#public/memory/file/backend.js";
import { vercelDefaultDocumentBackend } from "#platform/vercel/memory.js";

const IMPLEMENTATIONS: Record<PlatformTarget, () => MemoryDocumentBackend | undefined> = {
  vercel: vercelDefaultDocumentBackend,
};

export function defaultDocumentBackend(): MemoryDocumentBackend | undefined {
  return IMPLEMENTATIONS[platformContext().target]();
}
