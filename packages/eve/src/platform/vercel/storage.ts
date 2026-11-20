import type { PlatformStorage } from "#platform/types.js";
import { vercelBlob } from "#platform/vercel/blob.js";

export const vercelStorage: PlatformStorage = {
  hostedDocumentBackend: vercelBlob,
};
