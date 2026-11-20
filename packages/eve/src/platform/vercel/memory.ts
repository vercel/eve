import { isVercelEnvironment } from "#platform/vercel/environment.js";
import type { MemoryDocumentBackend } from "#public/memory/file/backend.js";

interface VercelBlobCredentials {
  readonly storeId?: string;
  readonly token?: string;
}

const BLOB_REQUIRED_MESSAGE =
  "fileMemory() requires Vercel Blob storage. Set up EVE_MEMORY_BLOB_STORE_ID with `/add memory/file` in eve dev or `eve integration setup file-memory`, then redeploy. Alternatively, pass fileMemory({ backend }).";

export function vercelDefaultDocumentBackend(): MemoryDocumentBackend | undefined {
  if (!isVercelEnvironment()) return undefined;
  const credentials =
    credentialsFromEnvironment("EVE_MEMORY_BLOB") ?? credentialsFromEnvironment("BLOB");
  if (credentials === undefined) throw new Error(BLOB_REQUIRED_MESSAGE);
  return deferredBackend(async () => {
    const { vercelBlob } = await import("#platform/vercel/blob.js");
    return vercelBlob(credentials);
  });
}

function deferredBackend(load: () => Promise<MemoryDocumentBackend>): MemoryDocumentBackend {
  let backend: Promise<MemoryDocumentBackend> | undefined;
  const get = () => (backend ??= load());
  return {
    read: async (input) => (await get()).read(input),
    write: async (input) => (await get()).write(input),
  };
}

function credentialsFromEnvironment(
  prefix: "BLOB" | "EVE_MEMORY_BLOB",
): VercelBlobCredentials | undefined {
  const storeId = environmentValue(`${prefix}_STORE_ID`);
  if (storeId !== undefined) return { storeId };

  const token = environmentValue(`${prefix}_READ_WRITE_TOKEN`);
  return token === undefined ? undefined : { token };
}

function environmentValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === "" ? undefined : value;
}
