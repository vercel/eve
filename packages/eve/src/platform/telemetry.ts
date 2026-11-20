import type { PlatformTelemetry } from "#platform/types.js";
import { vercelTelemetry } from "#platform/vercel/telemetry.js";

export function platformTelemetry(): PlatformTelemetry {
  return vercelTelemetry;
}
