import {
  getInstrumentationRuntime,
  type InstrumentationRuntime,
} from "#harness/instrumentation/runtime.js";
import { installInstrumentationRuntime } from "#tracing/install-instrumentation-runtime.js";
import { createLocalTracesProcessor, resolveLocalTracesContent } from "#tracing/local-traces.js";
import {
  collectOtelPipeline,
  managedOtelIntegration,
  otel,
  type TraceCapturePolicy,
} from "#tracing/otel-declaration.js";

/** Zero-config local tracing keeps unclassified HTTP/TUI sessions observable. @internal */
export const localTracePolicy: TraceCapturePolicy = ({ audience }) =>
  audience === "public" || audience === "unknown";

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
