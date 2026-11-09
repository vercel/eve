import type { UploadPolicy } from "#public/channels/upload-policy.js";

/** The byte cap an upload policy sets; a disabled policy accepts nothing. */
export function maxBytesOf(policy: UploadPolicy): number {
  return policy === "disabled" ? 0 : policy.maxBytes;
}
