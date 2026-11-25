import type { Entities } from "#platform/entities.js";
import {
  getInstrumentationRuntime,
  type InstrumentationRuntime,
} from "#instrumentation/runtime.js";
import { installInstrumentationRuntime } from "#tracing/eve/install-instrumentation-runtime.js";
import {
  createLocalTracesProcessor,
  resolveLocalTracesExportPolicy,
} from "#tracing/local/traces.js";
import {
  collectOtelPipeline,
  managedOtelIntegration,
  otel,
  type TraceCapturePolicy,
} from "#tracing/eve/otel-declaration.js";

/** @internal */
export const localTracePolicy: TraceCapturePolicy = () => true;

export function installLocalInstrumentationRuntime(input: {
  readonly appRoot: string;
  readonly frameworkVersion: string;
  readonly platform: Entities;
  readonly serviceName: string;
}): InstrumentationRuntime {
  const existing = getInstrumentationRuntime();
  if (existing !== undefined) return existing;

  const spool = createLocalTracesProcessor({ appRoot: input.appRoot });
  return installInstrumentationRuntime({
    collected: collectOtelPipeline(
      [
        otel({ tracePolicy: localTracePolicy }),
        managedOtelIntegration({
          exportPolicy: resolveLocalTracesExportPolicy(),
          spanProcessors: [spool],
        }),
      ],
      input.platform,
    ),
    frameworkVersion: input.frameworkVersion,
    platform: input.platform,
    providers: [],
    serviceName: input.serviceName,
  });
}
