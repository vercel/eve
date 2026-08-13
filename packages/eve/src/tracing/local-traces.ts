import type { SpanProcessor } from "#compiled/@vercel/otel/index.js";

import { AgentTraceSpanProcessor } from "#tracing/agent-trace-span-processor.js";
import { LocalTraceSpanProcessor } from "#tracing/local-trace-span-processor.js";
import {
  requestLocalTraceStorePrune,
  resolveLocalTraceRetentionSettings,
} from "#tracing/local-trace-retention.js";

/**
 * The local spool, as a span processor.
 *
 * Session liveness and retention live in here rather than in the runtime that
 * installs it, so nothing an author puts in the same `spanProcessors` list can
 * see them — and eve's accept filter never reaches an author's exporters.
 */
export interface LocalTracesProcessor extends SpanProcessor {
  /**
   * Settles pending writes and drops one root session's liveness, then bounds
   * the store. A subagent child owns no traces, so releasing one is a no-op
   * and leaves the shared trace pinned until its root finishes.
   */
  releaseSession(sessionId: string): Promise<boolean>;
}

/**
 * Reports whether a processor tracks which session owns which trace, so eve can
 * tell it when that session is done.
 *
 * Anything standing between eve and the spool has to answer for the spool, so
 * this is the check a wrapper uses to decide whether it must forward the call.
 *
 * @internal
 */
export function hasSessionRelease(processor: SpanProcessor): processor is LocalTracesProcessor {
  return typeof (processor as Partial<LocalTracesProcessor>).releaseSession === "function";
}

/**
 * Writes the OTLP/JSON spool under `.eve/traces/v1`.
 *
 * `EVE_TRACES=off` removes the writer but keeps the processor: eve still has
 * to observe spans to track which session owns which trace.
 *
 * Internal because of `releaseSession`, which eve's runtime drives off session
 * lifecycle. The authored surface is `localTraces()`, which wraps this in an
 * `OtelIntegration`.
 */
export function createLocalTracesProcessor(
  input: { readonly appRoot?: string } = {},
): LocalTracesProcessor {
  const appRoot = input.appRoot ?? process.env["EVE_DEV_WORKER_APP_ROOT"];
  if (appRoot === undefined) return inertLocalTracesProcessor();

  const retention = resolveLocalTraceRetentionSettings();
  const processor = new AgentTraceSpanProcessor(
    retention.enabled ? [new LocalTraceSpanProcessor(appRoot)] : [],
  );

  const requestPrune = (): void => {
    if (!retention.enabled) return;
    requestLocalTraceStorePrune({
      activeTraceIds: processor.activeTraceIds(),
      appRoot,
      maxAgeMs: retention.maxAgeMs,
      maxTotalBytes: retention.maxTotalBytes,
      retainCount: retention.retainCount,
    });
  };

  // Startup sweep: a store left oversized by a killed dev server is bounded
  // before this worker adds to it.
  requestPrune();

  return {
    forceFlush: () => processor.forceFlush(),
    onEnd: (span) => processor.onEnd(span),
    onStart: (span, parentContext) => processor.onStart(span, parentContext),
    async releaseSession(sessionId) {
      // Settle pending segment writes before dropping liveness: a sweep already
      // running reads the same live set, so releasing first would expose the
      // trace to eviction while it is still being written.
      await processor.forceFlush();
      if (!processor.releaseSession(sessionId)) return false;
      requestPrune();
      return true;
    },
    shutdown: () => processor.shutdown(),
  };
}

/**
 * The local spool's content policy: its options, intersected with
 * `EVE_TRACES_CONTENT`.
 *
 * The variable applies to this destination only. `on` opts the zero-config
 * spool into content, while `off` overrides authored local options without
 * changing what a hosted backend beside it receives.
 *
 * @internal
 */
export function resolveLocalTracesContent(
  options: {
    readonly recordInputs?: boolean;
    readonly recordOutputs?: boolean;
  } = {},
): { readonly recordInputs: boolean; readonly recordOutputs: boolean } {
  const environmentDefault = process.env.EVE_TRACES_CONTENT === "on";
  const enabled = process.env.EVE_TRACES_CONTENT !== "off";
  return {
    recordInputs: enabled && (options.recordInputs ?? environmentDefault),
    recordOutputs: enabled && (options.recordOutputs ?? environmentDefault),
  };
}

/** A production-authored `localTraces()` has no local development store. */
function inertLocalTracesProcessor(): LocalTracesProcessor {
  return {
    forceFlush: async () => undefined,
    onEnd: () => undefined,
    onStart: () => undefined,
    releaseSession: async () => false,
    shutdown: async () => undefined,
  };
}
