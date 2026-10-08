/**
 * AI SDK integration. `aiSdkTelemetry` records `generateText`, `streamText`,
 * and AI SDK agents as turns; `modelUsage` and `modelContent` convert AI SDK
 * payloads for hosts that record model calls themselves.
 */
export { aiSdkTelemetry, type AiSdkTelemetryOptions } from "./adapters/ai-sdk-telemetry.js";
export { modelUsage, modelContent } from "./adapters/ai-sdk-payload.js";
