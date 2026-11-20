import { currentPlatform } from "#platform/current.js";
import type { PlatformSandboxes, PlatformTarget } from "#platform/types.js";
import { vercelSandboxes } from "#platform/vercel/sandbox.js";

const IMPLEMENTATIONS: Record<PlatformTarget, PlatformSandboxes> = { vercel: vercelSandboxes };

export function platformSandboxes(): PlatformSandboxes {
  return IMPLEMENTATIONS[currentPlatform().target];
}
