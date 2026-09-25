import { isEveDevEnvironment } from "#internal/application/dev-environment.js";
import type { MemoryDocumentBackend } from "#public/memory/file/backend.js";
import { inMemory } from "#public/memory/file/backends/in-memory.js";
import { lazyBackend } from "#public/memory/file/backends/lazy.js";
import { vercelBlob } from "#public/memory/file/backends/vercel-blob.js";

interface VercelBlobCredentials {
  readonly storeId?: string;
  readonly token?: string;
}

/** Environment probe behind the default backend selection. */
interface DefaultFileMemoryBackendProbes {
  readonly vercelBlobCredentials: () => VercelBlobCredentials | undefined;
  readonly isEveDevelopment: () => boolean;
  readonly isDeployedOnVercel: () => boolean;
}

const ENVIRONMENT_PROBES: DefaultFileMemoryBackendProbes = {
  vercelBlobCredentials: () =>
    credentialsFromEnvironment("EVE_MEMORY_BLOB") ?? credentialsFromEnvironment("BLOB"),
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
    const credentials = probes.vercelBlobCredentials();
    if (credentials !== undefined) return vercelBlob(credentials);
    throw new Error(
      "fileMemory() requires Vercel Blob storage. Set up EVE_MEMORY_BLOB_STORE_ID with `/add memory/file` in eve dev or `eve integration setup file-memory`, then redeploy. Alternatively, pass fileMemory({ backend }).",
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

function credentialsFromEnvironment(
  prefix: "BLOB" | "EVE_MEMORY_BLOB",
): VercelBlobCredentials | undefined {
  const storeId = environmentValue(`${prefix}_STORE_ID`);
  // Let the Blob SDK resolve and refresh the current environment or request-scoped OIDC token.
  if (storeId !== undefined) return { storeId };

  const token = environmentValue(`${prefix}_READ_WRITE_TOKEN`);
  return token === undefined ? undefined : { token };
}

function environmentValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === "" ? undefined : value;
}
