import {
  getInstrumentationRuntime,
  type InstrumentationRuntime,
} from "#instrumentation/runtime.js";
import { installInstrumentationRuntime } from "#tracing/install-instrumentation-runtime.js";
import { createLocalTracesProcessor, resolveLocalTracesContent } from "#tracing/local-traces.js";
import {
  collectOtelPipeline,
  managedOtelIntegration,
  otel,
  type TraceCapturePolicy,
} from "#tracing/otel-declaration.js";

/** Local traces are a local debugging surface, so every conversation is public here. @internal */
export const localTracePolicy: TraceCapturePolicy = () => ({
  emit: true,
  recordInputs: true,
  recordOutputs: true,
});

/** Installs the zero-config local OTel runtime once in an `eve dev` worker. */
export function installLocalInstrumentationRuntime(input: {
  readonly appRoot: string;
  readonly frameworkVersion: string;
  readonly serviceName: string;
}): InstrumentationRuntime {
  const existing = getInstrumentationRuntime();
  if (existing !== undefined) return existing;

  const spool = createLocalTracesProcessor({ appRoot: input.appRoot });
  return installInstrumentationRuntime({
    collected: collectOtelPipeline([
      otel({ tracePolicy: localTracePolicy }),
      managedOtelIntegration({
        ...resolveLocalTracesContent(),
        spanProcessors: [spool],
      }),
    ]),
    frameworkVersion: input.frameworkVersion,
    providers: [],
    serviceName: input.serviceName,
  });
}
