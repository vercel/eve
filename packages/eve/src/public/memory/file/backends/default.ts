import type { MemoryDocumentBackend } from "#public/memory/file/backend.js";
import { inMemory } from "#public/memory/file/backends/in-memory.js";
import { lazyBackend } from "#public/memory/file/backends/lazy.js";
import { vercelBlob } from "#public/memory/file/backends/vercel-blob.js";

/** Environment probe behind the default backend selection. */
interface DefaultFileMemoryBackendProbes {
  readonly hasVercelBlobStore: () => boolean;
  readonly isDeployedOnVercel: () => boolean;
  readonly isProduction: () => boolean;
}

const PRODUCTION_PROBES: DefaultFileMemoryBackendProbes = {
  hasVercelBlobStore: () =>
    hasEnvironmentValue("BLOB_STORE_ID") || hasEnvironmentValue("BLOB_READ_WRITE_TOKEN"),
  isDeployedOnVercel: () => hasEnvironmentValue("VERCEL"),
  isProduction: () => process.env.NODE_ENV === "production",
};

/**
 * Selects private Vercel Blob storage when a Vercel deployment has an attached
 * store, and process-local storage outside Vercel in development. Other
 * production configurations must provide a backend. Selection is deferred and
 * cached for the process lifetime.
 */
export function defaultFileMemoryBackend(): MemoryDocumentBackend {
  return lazyBackend(() => selectDefaultFileMemoryBackend(PRODUCTION_PROBES));
}

/** @internal Selection primitive with injectable environment probes for tests. */
function selectDefaultFileMemoryBackend(
  probes: DefaultFileMemoryBackendProbes,
): MemoryDocumentBackend {
  if (probes.isDeployedOnVercel()) {
    if (probes.hasVercelBlobStore()) return vercelBlob();
    throw new Error(
      "fileMemory() requires an attached Vercel Blob store on Vercel. Attach a Blob store or pass fileMemory({ backend }).",
    );
  }
  if (probes.isProduction()) {
    throw new Error(
      "fileMemory() requires an explicit backend outside Vercel in production. Pass fileMemory({ backend }).",
    );
  }
  return inMemory();
}

function hasEnvironmentValue(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}
