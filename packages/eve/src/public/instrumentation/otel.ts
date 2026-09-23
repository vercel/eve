/**
 * The OpenTelemetry authoring surface for `agent/instrumentation/`.
 *
 * Two halves, because OpenTelemetry has two: `otel()` is the settings a process
 * can only hold one of, and an integration is a destination, of which there may
 * be as many as there are files.
 *
 * Each destination is declared in its own path-named provider file.
 */

import {
  createLocalTracesProcessor,
  resolveLocalTracesExportPolicy,
} from "#tracing/local-traces.js";
import {
  managedOtelIntegration,
  type ManagedTraceOptions,
  type OtelIntegration,
} from "#tracing/otel-declaration.js";

export {
  isOtelDeclaration,
  isOtelIntegration,
  otel,
  otelIntegration,
  type OtelDeclaration,
  type OtelIntegration,
  type OtelIntegrationOptions,
  type OtelOptions,
  type ManagedTraceOptions,
  type SpanAttributeDecision,
  type SpanExportAttributeValue,
  type SpanExportContext,
  type SpanExportDecision,
  type SpanExportPolicy,
  type TraceCaptureContext,
  type TraceCapturePolicy,
  type TracePolicyDecision,
} from "#tracing/otel-declaration.js";

export type { SpanExporter, SpanProcessor } from "#compiled/@vercel/otel/index.js";

/**
 * The local trace spool `eve dev` reads, as a destination.
 *
 * Export it from `agent/instrumentation/local.ts` to keep it alongside a hosted
 * backend, or export `disableInstrumentation()` from that file to turn it off.
 * Omitting the file leaves eve's default in place.
 */
export function localTraces(options: ManagedTraceOptions = {}): OtelIntegration {
  return managedOtelIntegration({
    ...options,
    exportPolicy: resolveLocalTracesExportPolicy(options.exportPolicy),
    spanProcessors: [createLocalTracesProcessor()],
  });
}
