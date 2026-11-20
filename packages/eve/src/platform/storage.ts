import type { PlatformStorage } from "#platform/types.js";
import { vercelStorage } from "#platform/vercel/storage.js";

export function platformStorage(): PlatformStorage {
  return vercelStorage;
}
