/**
 * OpenTelemetry plumbing for hosts that run their own spans beside agent
 * tracing: active-operation lookup, capture context, content bounds, and MCP
 * enrichment. Agent tracing itself needs only the package root.
 */
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
