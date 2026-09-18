import {
  getInstrumentationRuntime,
  type InstrumentationRuntime,
} from "#instrumentation/runtime.js";
import { installInstrumentationRuntime } from "#tracing/install-instrumentation-runtime.js";
import {
  createLocalTracesProcessor,
  resolveLocalTracesExportPolicy,
} from "#tracing/local-traces.js";
import {
  collectOtelPipeline,
  managedOtelIntegration,
  otel,
  type TraceCapturePolicy,
} from "#tracing/otel-declaration.js";

/** Zero-config local tracing admits every session in the development worker. @internal */
export const localTracePolicy: TraceCapturePolicy = () => true;

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
        exportPolicy: resolveLocalTracesExportPolicy(),
        spanProcessors: [spool],
      }),
    ]),
    frameworkVersion: input.frameworkVersion,
    providers: [],
    serviceName: input.serviceName,
  });
}
