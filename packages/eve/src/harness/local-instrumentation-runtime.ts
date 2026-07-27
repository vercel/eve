import { trace } from "#compiled/@opentelemetry/api/index.js";
import { registerOTel } from "#compiled/@vercel/otel/index.js";

import { ContextAgentTraceStateStore } from "#harness/agent-trace-context-store.js";
import { createAgentOtelInstrumentation } from "#harness/agent-otel-provider.js";
import { createInstrumentationHooks } from "#harness/instrumentation-lifecycle.js";
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
  const agentOtel = createAgentOtelInstrumentation({
    frameworkVersion: input.frameworkVersion,
    stateStore: new ContextAgentTraceStateStore(),
    tracer: trace.getTracer("eve.agent", input.frameworkVersion),
  });
  return registerInstrumentationRuntime({
    forceFlush: () => processor.forceFlush(),
    hooks: createInstrumentationHooks([agentOtel.hook]),
    runInContext: agentOtel.runInContext,
  });
}
