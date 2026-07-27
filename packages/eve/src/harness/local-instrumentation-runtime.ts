import { context, trace } from "#compiled/@opentelemetry/api/index.js";
import { registerOTel } from "#compiled/@vercel/otel/index.js";

import { ContextAgentTraceStateStore } from "#harness/agent-trace-context-store.js";
import { createAgentOtelInstrumentation } from "#harness/agent-otel-provider.js";
import {
  createInstrumentationHooks,
  type InstrumentationProviderDefinition,
} from "#harness/instrumentation-lifecycle.js";
import {
  getInstrumentationRuntime,
  registerInstrumentationRuntime,
  type InstrumentationRuntime,
} from "#harness/instrumentation-runtime.js";
import { LocalTraceSpanProcessor } from "#harness/local-trace-span-processor.js";

/** Installs the zero-config local OTel runtime once in an `eve dev` worker. */
export function installLocalInstrumentationRuntime(input: {
  readonly appRoot: string;
  readonly frameworkVersion: string;
  readonly serviceName: string;
}): InstrumentationRuntime {
  const existing = getInstrumentationRuntime();
  if (existing !== undefined) return existing;

  const processor = new LocalTraceSpanProcessor(input.appRoot);
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
  return registerInstrumentationRuntime({
    forceFlush: () => processor.forceFlush(),
    hooks: createInstrumentationHooks([agentOtel.hook, releaseTrace]),
    runInContext: agentOtel.runInContext,
  });

  function releaseSessionTrace(event: { readonly sessionId: string }): void {
    processor.releaseSession(event.sessionId);
  }
}
