import type { SpanProcessor } from "#compiled/@vercel/otel/index.js";

import { AgentTraceSpanProcessor } from "#tracing/local/agent-trace-span-processor.js";
import { LocalTraceSpanProcessor } from "#tracing/local/trace-span-processor.js";
import {
  requestLocalTraceStorePrune,
  resolveLocalTraceRetentionSettings,
} from "#tracing/local/trace-retention.js";
import {
  normalizeSpanExportPolicies,
  type SpanExportPolicy,
} from "#tracing/eve/span-export-policy.js";

export interface LocalTracesProcessor extends SpanProcessor {
  releaseConversation(conversationId: string): Promise<boolean>;
}

export function hasConversationRelease(
  processor: SpanProcessor,
): processor is LocalTracesProcessor {
  return typeof (processor as Partial<LocalTracesProcessor>).releaseConversation === "function";
}

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

  requestPrune();

  const forceFlush = async (): Promise<void> => {
    await processor.forceFlush();
    if (processor.releaseCompletedTraces()) requestPrune();
  };
  return {
    forceFlush,
    onEnd: (span) => processor.onEnd(span),
    onStart: (span, parentContext) => processor.onStart(span, parentContext),
    async releaseConversation(conversationId) {
      await forceFlush();
      if (!processor.releaseConversation(conversationId)) return false;
      requestPrune();
      return true;
    },
    shutdown: () => processor.shutdown(),
  };
}

export function resolveLocalTracesExportPolicy(
  exportPolicy?: SpanExportPolicy | readonly SpanExportPolicy[],
): SpanExportPolicy | readonly SpanExportPolicy[] | undefined {
  if (process.env.EVE_TRACES_CONTENT !== "off") return exportPolicy;
  return [
    { span: () => ({ redact: true, inputs: true, outputs: true }) },
    ...normalizeSpanExportPolicies(exportPolicy),
  ];
}

function inertLocalTracesProcessor(): LocalTracesProcessor {
  return {
    forceFlush: async () => undefined,
    onEnd: () => undefined,
    onStart: () => undefined,
    releaseConversation: async () => false,
    shutdown: async () => undefined,
  };
}
