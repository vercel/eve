import type { PlatformTelemetry } from "#platform/types.js";
import { vercelRuntimeSpanProcessor } from "#platform/vercel/runtime-span-exporter.js";

export const vercelTelemetry: PlatformTelemetry = {
  traceSessionAttribute: () =>
    process.env.VERCEL_ENV === undefined ? undefined : "vercel.session_id",
  runtimeSpanProcessor: () => vercelRuntimeSpanProcessor(),
};
