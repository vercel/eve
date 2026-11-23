import { appOf } from "#context/app.js";
import { contextStorage } from "#context/container.js";
import { isEveDevEnvironment } from "#internal/application/dev-environment.js";
import { defaultDocumentBackend } from "#platform/document-store.js";
import type { MemoryDocumentBackend } from "#public/memory/file/backend.js";
import { inMemory } from "#public/memory/file/backends/in-memory.js";
import { lazyBackend } from "#public/memory/file/backends/lazy.js";

const DEVELOPMENT_BACKEND = inMemory();

export function defaultFileMemoryBackend(): MemoryDocumentBackend {
  return lazyBackend(selectDefaultFileMemoryBackend);
}

function selectDefaultFileMemoryBackend(): MemoryDocumentBackend {
  const platformBackend = defaultDocumentBackend(appOf(contextStorage.getStore())?.platform);
  if (platformBackend !== undefined) return platformBackend;
  if (isEveDevEnvironment()) return DEVELOPMENT_BACKEND;
  throw new Error(
    "fileMemory() requires an explicit backend outside Vercel and eve dev. Pass fileMemory({ backend }).",
  );
}
