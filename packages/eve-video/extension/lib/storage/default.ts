import { localDisk } from "./local-disk.ts";
import type { VideoStorage } from "./types.ts";
import { vercelBlob } from "./vercel-blob.ts";

function hasEnv(name: string): boolean {
  const value = process.env[name]?.trim();
  return value !== undefined && value.length > 0;
}

export function resolveConfiguredStorage(
  storage: VideoStorage | false | undefined,
): VideoStorage | undefined {
  if (storage === false) return undefined;
  if (storage !== undefined) return storage;

  if (hasEnv("EVE_VIDEO_BLOB_STORE_ID") || hasEnv("EVE_VIDEO_BLOB_READ_WRITE_TOKEN")) {
    return vercelBlob();
  }
  if (hasEnv("VERCEL") && (hasEnv("BLOB_STORE_ID") || hasEnv("BLOB_READ_WRITE_TOKEN"))) {
    return vercelBlob();
  }
  if (process.env.EVE_DEV === "1") {
    return localDisk();
  }

  return undefined;
}
