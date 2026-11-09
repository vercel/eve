import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { createInstrumentationHooks } from "#instrumentation/lifecycle.js";
import { registerInstrumentationRuntime } from "#instrumentation/runtime-global.js";
import type { TraceCapturePolicy } from "#shared/trace-policy.js";

export function eventTracing() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);
  const runtime = registerInstrumentationRuntime({
    forceFlush: async () => provider.forceFlush(),
    hooks: createInstrumentationHooks([]),
    otelSettings: undefined,
    runInContext: (_operation, execute) => execute(),
    shutdown: async () => undefined,
  });
  return {
    exporter,
    enable(tracePolicy?: TraceCapturePolicy, requests = true) {
      runtime.otelSettings = {
        functionId: undefined,
        recordInputs: false,
        recordOutputs: false,
        tracePolicy,
        traceChannelRequests: requests,
      };
    },
    async close() {
      runtime.otelSettings = undefined;
      await provider.shutdown();
      trace.disable();
      propagation.disable();
      context.disable();
    },
  };
}
