import { context, trace } from "#compiled/@opentelemetry/api/index.js";
import { registerOTel } from "#compiled/@vercel/otel/index.js";

import { ContextAgentTraceStateStore } from "#harness/agent-trace-context-store.js";
import { createAgentOtelInstrumentation } from "#harness/agent-otel-provider.js";
import { AgentTraceSpanProcessor } from "#harness/agent-trace-span-processor.js";
import {
  createInstrumentationHooks,
  type InstrumentationProviderDefinition,
} from "#harness/instrumentation-lifecycle.js";
import {
  getInstrumentationRuntime,
  registerInstrumentationRuntime,
  type InstrumentationRuntime,
} from "#harness/instrumentation-runtime.js";
import {
  requestLocalTraceStorePrune,
  resolveLocalTraceRetentionSettings,
} from "#harness/local-trace-retention.js";
import { LocalTraceSpanProcessor } from "#harness/local-trace-span-processor.js";

/** Installs the zero-config local OTel runtime once in an `eve dev` worker. */
export function installLocalInstrumentationRuntime(input: {
  readonly appRoot: string;
  readonly frameworkVersion: string;
  readonly serviceName: string;
}): InstrumentationRuntime {
  const existing = getInstrumentationRuntime();
  if (existing !== undefined) return existing;

  const retention = resolveLocalTraceRetentionSettings();
  // `EVE_TRACES=off` removes the writer but keeps the runtime: agent context
  // still has to propagate so AI SDK and user spans nest correctly.
  const processor = new AgentTraceSpanProcessor(
    retention.enabled ? [new LocalTraceSpanProcessor(input.appRoot)] : [],
  );
  registerOTel({
    autoDetectResources: false,
    instrumentations: [],
    propagators: ["none"],
    serviceName: input.serviceName,
    spanProcessors: [processor],
  });
  const probe = trace.getTracer("eve.registration").startSpan("eve.otel.registration");
  const activeContext = trace.setSpan(context.active(), probe);
  const contextAttached = context.with(activeContext, () => trace.getActiveSpan() === probe);
  probe.end();
  if (!processor.isAttached() || !contextAttached) {
    throw new Error("eve could not register OpenTelemetry because another runtime already exists.");
  }
  const agentOtel = createAgentOtelInstrumentation({
    frameworkVersion: input.frameworkVersion,
    stateStore: new ContextAgentTraceStateStore(),
    tracer: trace.getTracer("eve.agent", input.frameworkVersion),
  });
  const releaseTrace: InstrumentationProviderDefinition = {
    events: {
      "session.completed": releaseSessionTrace,
      "session.failed": releaseSessionTrace,
    },
  };
  // Startup sweep: a store left oversized by a killed dev server is bounded
  // before this worker adds to it.
  requestPrune();

  return registerInstrumentationRuntime({
    forceFlush: () => processor.forceFlush(),
    hooks: createInstrumentationHooks([agentOtel.hook, releaseTrace]),
    runInContext: agentOtel.runInContext,
  });

  async function releaseSessionTrace(event: { readonly sessionId: string }): Promise<void> {
    // Settle pending segment writes before dropping liveness: a sweep already
    // running reads the same live set, so releasing first would expose the
    // trace to eviction while it is still being written.
    await processor.forceFlush();
    if (!processor.releaseSession(event.sessionId)) return;
    requestPrune();
  }

  function requestPrune(): void {
    if (!retention.enabled) return;
    requestLocalTraceStorePrune({
      activeTraceIds: processor.activeTraceIds(),
      appRoot: input.appRoot,
      maxAgeMs: retention.maxAgeMs,
      maxTotalBytes: retention.maxTotalBytes,
      retainCount: retention.retainCount,
    });
  }
}
