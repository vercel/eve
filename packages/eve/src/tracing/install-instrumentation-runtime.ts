import { context, trace } from "#compiled/@opentelemetry/api/index.js";
import type { SpanProcessor } from "#compiled/@vercel/otel/index.js";

import {
  createInstrumentationHooks,
  type InstrumentationHooks,
  type InstrumentationProviderDefinition,
} from "#harness/instrumentation/lifecycle.js";
import {
  createInstrumentationRuntime,
  registerInstrumentationRuntime,
  type HarnessInstrumentation,
  type InstrumentationRuntime,
} from "#harness/instrumentation/runtime.js";
import { createLogger, formatError } from "#internal/logging.js";
import { isEveDevEnvironment } from "#internal/application/dev-environment.js";
import { ContextAgentTraceStateStore } from "#tracing/agent-trace-context-store.js";
import { createAgentOtelInstrumentation } from "#tracing/agent-otel-provider.js";
import { hasSessionRelease, type LocalTracesProcessor } from "#tracing/local-traces.js";
import type { CollectedOtel, RuntimeContextResolver } from "#tracing/otel-declaration.js";
import {
  DROP_INSTRUMENTATION,
  type InstrumentationControls,
} from "#shared/instrumentation-controls.js";
import { suppressTracing } from "#tracing/suppress-tracing.js";
import { registerOtelPipeline, type RegisteredOtelPipeline } from "#tracing/otel-registration.js";

const log = createLogger("tracing.install-instrumentation-runtime");

/**
 * Installs the process instrumentation runtime around a collected pipeline.
 *
 * Both layouts land here. `eve dev`'s zero-config default and an authored
 * `agent/instrumentation/` directory differ only in where the declared values
 * came from, so sharing the install keeps them on one runtime path.
 *
 * A directory that declared no OpenTelemetry still gets a bus: its providers
 * see every event, they just have no spans to hang them on.
 */
export function installInstrumentationRuntime(input: {
  readonly collected: CollectedOtel;
  readonly frameworkVersion: string;
  readonly providers: readonly InstrumentationProviderDefinition[];
  readonly runtimeContextResolvers?: readonly RuntimeContextResolver[];
  readonly serviceName: string;
}): InstrumentationRuntime {
  const serialBefore: InstrumentationProviderDefinition[] = [];
  const serialAfter: InstrumentationProviderDefinition[] = [];
  let otelRuntime: RegisteredOtelPipeline | undefined;
  let prepareSessionTrace: HarnessInstrumentation["prepareSessionTrace"];
  let prepareTurnTrace: HarnessInstrumentation["prepareTurnTrace"];
  let runInContext: NonNullable<HarnessInstrumentation["runInContext"]> = (_operation, execute) =>
    execute();

  if (input.collected.declared) {
    otelRuntime = registerOtelPipeline({
      pipeline: input.collected.pipeline,
      serviceName: input.serviceName,
    });
    const agentOtel = createAgentOtelInstrumentation({
      emitVercelSessionId: process.env.VERCEL_ENV !== undefined && !isEveDevEnvironment(),
      frameworkVersion: input.frameworkVersion,
      idGenerator: otelRuntime.idGenerator,
      recordInputs: input.collected.settings.recordInputs,
      recordOutputs: input.collected.settings.recordOutputs,
      stateStore: new ContextAgentTraceStateStore(),
      tracer: trace.getTracer("eve.agent", input.frameworkVersion),
    });
    // The span must exist before authored providers observe the lifecycle event.
    serialBefore.push({ ...agentOtel.hook, stateNamespace: "internal:otel" });
    prepareSessionTrace = agentOtel.prepareSessionTrace;
    prepareTurnTrace = agentOtel.prepareTurnTrace;
    runInContext = agentOtel.runInContext;

    const releasable = input.collected.pipeline.spanProcessors
      .filter(isSpanProcessor)
      .filter(hasSessionRelease);
    if (releasable.length > 0) serialAfter.push(sessionReleaseProvider(releasable));
  }

  const allProviders = [...serialBefore, ...input.providers, ...serialAfter];
  const createHooks = (controls: InstrumentationControls): InstrumentationHooks =>
    createInstrumentationHooks({
      parallel: input.providers,
      serialAfter,
      serialBefore: controls.action === "record" ? serialBefore : [],
    });
  let shutdown: Promise<void> | undefined;
  const otelSettings = input.collected.declared ? input.collected.settings : undefined;
  return registerInstrumentationRuntime(
    createInstrumentationRuntime({
      createHooks,
      forceFlush: () =>
        settleAll([
          ...(otelRuntime === undefined ? [] : [otelRuntime.forceFlush]),
          ...allProviders.map((provider) => () => provider.flush?.()),
        ]),
      otelSettings,
      prepareSessionTrace,
      prepareTurnTrace,
      runtimeContextResolvers: input.runtimeContextResolvers,
      resolveDecision: (context) => {
        if (!input.collected.declared) {
          return {
            action: "record",
            recordInputs: true,
            recordOutputs: true,
          };
        }
        try {
          const decision =
            input.collected.settings.tracePolicy?.(context) ??
            (context.audience === "public"
              ? { action: "record", recordInputs: true, recordOutputs: true }
              : { action: "drop" });
          if (decision.action === "drop") return DROP_INSTRUMENTATION;
          if (
            decision.action === "record" &&
            typeof decision.recordInputs === "boolean" &&
            typeof decision.recordOutputs === "boolean"
          ) {
            return decision;
          }
        } catch {
          // Trace policy failures fail closed.
        }
        return DROP_INSTRUMENTATION;
      },
      runInContext,
      runWithTracingSuppressed: (execute) =>
        context.with(suppressTracing(context.active()), execute),
      shutdown: () => {
        shutdown ??= settleAll([
          ...(otelRuntime === undefined ? [] : [otelRuntime.shutdown]),
          ...allProviders.map((provider) => () => provider.shutdown?.()),
        ]);
        return shutdown;
      },
    }),
    otelSettings,
  );
}

function isSpanProcessor(processor: SpanProcessor | "auto"): processor is SpanProcessor {
  return processor !== "auto";
}

function sessionReleaseProvider(
  processors: readonly LocalTracesProcessor[],
): InstrumentationProviderDefinition {
  const release = async (event: { readonly sessionId: string }): Promise<void> => {
    await Promise.all(processors.map((processor) => processor.releaseSession(event.sessionId)));
  };
  return {
    events: { "session.completed": release, "session.failed": release },
    name: "eve.session-release",
    stateNamespace: "internal:session-release",
  };
}

/** One failing drain must not take the others or the step awaiting them with it. */
async function settleAll(operations: readonly (() => void | PromiseLike<void>)[]): Promise<void> {
  const results = await Promise.allSettled(operations.map(async (run) => run()));
  for (const result of results) {
    if (result.status === "rejected") {
      log.warn("instrumentation drain failed", { error: formatError(result.reason) });
    }
  }
}
