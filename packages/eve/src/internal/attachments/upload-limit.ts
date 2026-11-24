import type { UploadPolicy } from "#public/channels/upload-policy.js";

export function maxBytesOf(policy: UploadPolicy): number {
  return policy === "disabled" ? 0 : policy.maxBytes;
}
