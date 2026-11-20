export { activeTraceOperation, withErrorContent } from "./adapters/otel.js";
export { withCapture } from "./capture.js";
export {
  boundedPrincipalId,
  contentAttribute,
  telemetryByteLength,
  truncateTelemetryText,
  CONTENT_ATTRIBUTE_LIMIT,
} from "./adapters/serialization.js";
export { withoutDeclinedContent, type ResolvedContentOptions } from "./core/content-policy.js";
export { mcpLifecycle, type McpLifecycle, type McpUpdate } from "./core/mcp.js";
export { invocationName } from "./core/span-kinds.js";
export { USAGE_FIELDS } from "./core/attributes.js";
