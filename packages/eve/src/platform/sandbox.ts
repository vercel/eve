import type { PlatformSandboxes } from "#platform/types.js";
import { vercelSandboxes } from "#platform/vercel/sandbox.js";

export function platformSandboxes(): PlatformSandboxes {
  return vercelSandboxes;
}
