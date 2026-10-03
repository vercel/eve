export { createTraceRecorder } from "./core/scopes.js";
export { snapshotReference } from "./core/snapshot.js";
export { currentCapture, withCapture } from "./capture.js";
export { currentAgentHandoff, withAgentHandoff, type AgentHandoff } from "./core/delegation.js";
export { activeOperation, intersectCapture } from "./core/activation.js";
export { runTraceContext } from "./core/context.js";
export { withoutDeclinedContent, type ResolvedContentOptions } from "./core/content-policy.js";
export { mcpLifecycle, type McpLifecycle, type McpUpdate } from "./core/mcp.js";
export { invocationName } from "./core/span-kinds.js";
export { USAGE_FIELDS } from "./core/attributes.js";
export type {
  AttributeValue,
  Attributes,
  TraceJson,
  TraceSnapshot,
  SpanType,
  SpanKind,
  ExecutionContext,
  TraceReference,
  CaptureDecision,
  TraceErrorContext,
  TraceErrorHandler,
  TraceLink,
  PreparedSpan,
  SpanWriter,
  TraceBackend,
  ActiveOperation,
  MappingContext,
  OutputMapping,
  RunIdentity,
  FrameworkIdentity,
  Usage,
  ActionKind,
  ContentPart,
  ContentSerializer,
  Operation,
  OperationFacts,
  TurnMetadata,
} from "./core/types.js";
export type DurableTraceRuntime = ReturnType<typeof import("./core/scopes.js").createTraceRecorder>;
