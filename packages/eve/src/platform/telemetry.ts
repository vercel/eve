import { currentPlatform } from "#platform/current.js";
import type { PlatformTelemetry, PlatformTarget } from "#platform/types.js";
import { vercelTelemetry } from "#platform/vercel/telemetry.js";

const IMPLEMENTATIONS: Record<PlatformTarget, PlatformTelemetry> = { vercel: vercelTelemetry };

export function platformTelemetry(): PlatformTelemetry {
  return IMPLEMENTATIONS[currentPlatform().target];
}
