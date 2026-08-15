import {
  getInstrumentationRuntime,
  type InstrumentationRuntime,
} from "#harness/instrumentation/runtime.js";
import { installInstrumentationRuntime } from "#tracing/install-instrumentation-runtime.js";
import { createLocalTracesProcessor, resolveLocalTracesContent } from "#tracing/local-traces.js";
import { collectOtelPipeline, otel, otelIntegration } from "#tracing/otel-declaration.js";

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
      otel(),
      otelIntegration({ ...resolveLocalTracesContent(), spanProcessors: [spool] }),
    ]),
    frameworkVersion: input.frameworkVersion,
    providers: [],
    serviceName: input.serviceName,
  });
}
