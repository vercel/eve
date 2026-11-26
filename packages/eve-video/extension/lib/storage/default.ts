import { localDisk } from "./local-disk.ts";
import type { VideoStorage } from "./types.ts";
import { vercelBlob } from "./vercel-blob.ts";

export function resolveConfiguredStorage(
  storage: VideoStorage | false | undefined,
): VideoStorage | undefined {
  if (storage === false) return undefined;
  if (storage) return storage;
  const env = (k: string) => Boolean(process.env[k]?.trim());
  if (
    env("EVE_VIDEO_BLOB_STORE_ID") ||
    env("EVE_VIDEO_BLOB_READ_WRITE_TOKEN") ||
    (env("VERCEL") && (env("BLOB_STORE_ID") || env("BLOB_READ_WRITE_TOKEN")))
  ) {
    return vercelBlob();
  }
  return process.env.EVE_DEV === "1" ? localDisk() : undefined;
}
