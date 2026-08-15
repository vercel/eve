/**
 * The OpenTelemetry authoring surface for `agent/instrumentation/`.
 *
 * Two halves, because OpenTelemetry has two: `otel()` is the settings a process
 * can only hold one of, and an integration is a destination, of which there may
 * be as many as there are files.
 *
 * Reachable only with `experimental.instrumentationProviders` on. With the flag
 * off nothing discovers that directory, so these compile but never run.
 */

import { createLocalTracesProcessor, resolveLocalTracesContent } from "#tracing/local-traces.js";
import {
  agentRunsIntegration,
  otelIntegration,
  type ContentOptions,
  type OtelIntegration,
} from "#tracing/otel-declaration.js";

export {
  isOtelDeclaration,
  isOtelIntegration,
  otel,
  otelIntegration,
  type ContentOptions,
  type OtelDeclaration,
  type OtelIntegration,
  type OtelIntegrationOptions,
  type OtelOptions,
} from "#tracing/otel-declaration.js";

export type { SpanExporter, SpanProcessor } from "#compiled/@vercel/otel/index.js";

/**
 * Vercel Agent Runs, enabled by default in production.
 *
 * Export it from `agent/instrumentation/agent-runs.ts` to configure content
 * capture, or export `disableInstrumentation()` from that file to turn it off.
 */
export function agentRuns(options: ContentOptions = {}): OtelIntegration {
  return agentRunsIntegration(options);
}

/**
 * The local trace spool `eve dev` reads, as a destination.
 *
 * Export it from `agent/instrumentation/local.ts` to keep it alongside a hosted
 * backend, or export `disableInstrumentation()` from that file to turn it off.
 * Omitting the file leaves eve's default in place.
 *
 * `EVE_TRACES_CONTENT=on` opts the default local spool into content capture.
 * `off` overrides this destination and no other, so declining content locally
 * leaves what a hosted backend receives alone.
 */
export function localTraces(options: ContentOptions = {}): OtelIntegration {
  return otelIntegration({
    ...resolveLocalTracesContent(options),
    spanProcessors: [createLocalTracesProcessor()],
  });
}
