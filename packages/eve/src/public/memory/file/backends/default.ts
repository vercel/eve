import { isEveDevEnvironment } from "#internal/application/dev-environment.js";
import type { MemoryDocumentBackend } from "#public/memory/file/backend.js";
import { inMemory } from "#public/memory/file/backends/in-memory.js";
import { lazyBackend } from "#public/memory/file/backends/lazy.js";
import { vercelBlob } from "#public/memory/file/backends/vercel-blob.js";

/** Environment probe behind the default backend selection. */
interface DefaultFileMemoryBackendProbes {
  readonly hasVercelBlobStore: () => boolean;
  readonly isEveDevelopment: () => boolean;
  readonly isDeployedOnVercel: () => boolean;
}

const ENVIRONMENT_PROBES: DefaultFileMemoryBackendProbes = {
  hasVercelBlobStore: () =>
    hasEnvironmentValue("BLOB_READ_WRITE_TOKEN") ||
    (hasEnvironmentValue("BLOB_STORE_ID") && hasEnvironmentValue("VERCEL_OIDC_TOKEN")),
  isEveDevelopment: isEveDevEnvironment,
  isDeployedOnVercel: () => hasEnvironmentValue("VERCEL"),
};
const DEVELOPMENT_BACKEND = inMemory();

/**
 * Selects private Vercel Blob storage on configured Vercel deployments and a
 * shared process-local backend during `eve dev`. All other environments must
 * provide a backend. Selection is deferred and cached per provider instance.
 */
export function defaultFileMemoryBackend(): MemoryDocumentBackend {
  return lazyBackend(() => selectDefaultFileMemoryBackend(ENVIRONMENT_PROBES));
}

function selectDefaultFileMemoryBackend(
  probes: DefaultFileMemoryBackendProbes,
): MemoryDocumentBackend {
  if (probes.isDeployedOnVercel()) {
    if (probes.hasVercelBlobStore()) return vercelBlob();
    throw new Error(
      "fileMemory() requires an attached Vercel Blob store on Vercel. Attach a Blob store or pass fileMemory({ backend }).",
    );
  }
  if (probes.isEveDevelopment()) return DEVELOPMENT_BACKEND;
  throw new Error(
    "fileMemory() requires an explicit backend outside Vercel and eve dev. Pass fileMemory({ backend }).",
  );
}

function hasEnvironmentValue(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}
