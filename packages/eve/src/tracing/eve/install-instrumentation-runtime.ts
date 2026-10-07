import type { SpanProcessor } from "#compiled/@vercel/otel/index.js";

import { contextStorage } from "#context/container.js";
import { ConversationIdKey } from "#context/keys.js";
import {
  createInstrumentationHooks,
  type InstrumentationProviderDefinition,
} from "#instrumentation/lifecycle.js";
import {
  registerInstrumentationRuntime,
  type InstrumentationRuntime,
} from "#instrumentation/runtime.js";
import { createLogger, formatError } from "#internal/logging.js";
import { resolveInstrumentationEnvironment } from "#internal/application/dev-environment.js";
import { AgentSpanIdGenerator } from "#tracing/lib/index.js";
import { ContextAgentTraceStateStore } from "#tracing/eve/agent-trace-context-store.js";
import { createAgentOtelInstrumentation } from "#tracing/eve/agent-otel-provider.js";
import { hasConversationRelease, type LocalTracesProcessor } from "#tracing/local/traces.js";
import type { CollectedOtel, RuntimeContextResolver } from "#tracing/eve/otel-declaration.js";
import { otelTelemetry } from "#tracing/lib/index.js";
import type { RegisteredOtelPipeline } from "#tracing/eve/otel-registration.js";
import { registerOtel } from "#tracing/eve/otel-registration.js";
import { eveOutputMapping } from "#tracing/eve/profile.js";
import { readConversationId } from "#shared/conversation-identity.js";

const log = createLogger("tracing.install-instrumentation-runtime");

/**
 * Installs the process instrumentation runtime around a collected pipeline.
 *
 * `eve dev`'s zero-config default and an authored `agent/instrumentation/`
 * directory differ only in where the declared values came from.
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
  let prepareSessionTrace: InstrumentationRuntime["prepareSessionTrace"];
  let prepareTurnTrace: InstrumentationRuntime["prepareTurnTrace"];
  let runInContext: InstrumentationRuntime["runInContext"] = (_operation, execute) => execute();
  let idGenerator: AgentSpanIdGenerator;

  if (input.collected.declared) {
    otelRuntime = registerOtel({
      serviceName: input.serviceName,
      otel: input.collected.configuration,
    });
    idGenerator = otelRuntime.idGenerator;
    const agentOtel = createAgentOtelInstrumentation({
      environment: resolveInstrumentationEnvironment(),
      frameworkVersion: input.frameworkVersion,
      telemetry: otelTelemetry({
        provider: otelRuntime.provider,
        tracerName: "eve.agent",
        idGenerator,
        samplesTrace: otelRuntime.samplesTrace,
        mapping: eveOutputMapping(),
      }),
      idGenerator,
      recordInputs: input.collected.settings.recordInputs,
      recordOutputs: input.collected.settings.recordOutputs,
      stateStore: new ContextAgentTraceStateStore(),
      tracePolicy: input.collected.settings.tracePolicy,
    });
    // The span must exist before authored providers observe the lifecycle event.
    serialBefore.push({ ...agentOtel.hook, stateNamespace: "internal:otel" });
    prepareSessionTrace = agentOtel.prepareSessionTrace;
    prepareTurnTrace = agentOtel.prepareTurnTrace;
    runInContext = agentOtel.runInContext;

    const releasable = input.collected.configuration.spanProcessors
      .filter(isSpanProcessor)
      .filter(hasConversationRelease);
    if (releasable.length > 0) serialAfter.push(sessionReleaseProvider(releasable));
  } else {
    idGenerator = new AgentSpanIdGenerator();
  }

  const allProviders = [...serialBefore, ...input.providers, ...serialAfter];
  let shutdown: Promise<void> | undefined;
  return registerInstrumentationRuntime({
    forceFlush: async () => {
      await settleAll(allProviders.map((provider) => () => provider.flush?.()));
      await settleAll(otelRuntime === undefined ? [] : [otelRuntime.forceFlush]);
    },
    hooks: createInstrumentationHooks({
      parallel: input.providers,
      serialAfter,
      serialBefore,
    }),
    idGenerator,
    memoryOperations: otelRuntime !== undefined || input.providers.some(hasMemoryOperationHandler),
    otelSettings: input.collected.declared ? input.collected.settings : undefined,
    ownsAgentSpans: otelRuntime !== undefined,
    prepareSessionTrace,
    prepareTurnTrace,
    runtimeContextResolvers: input.runtimeContextResolvers,
    runInContext,
    samplesTrace: otelRuntime?.samplesTrace,
    shutdown: () => {
      shutdown ??= (async () => {
        await settleAll(allProviders.map((provider) => () => provider.shutdown?.()));
        await settleAll(otelRuntime === undefined ? [] : [otelRuntime.shutdown]);
      })();
      return shutdown;
    },
  });
}

function hasMemoryOperationHandler(provider: InstrumentationProviderDefinition): boolean {
  return (
    provider.events?.["memory.operation.started"] !== undefined ||
    provider.events?.["memory.operation.completed"] !== undefined ||
    provider.events?.["memory.operation.failed"] !== undefined
  );
}

function isSpanProcessor(processor: SpanProcessor | "auto"): processor is SpanProcessor {
  return processor !== "auto";
}

function sessionReleaseProvider(
  processors: readonly LocalTracesProcessor[],
): InstrumentationProviderDefinition {
  const release = async (event: { readonly sessionId: string }): Promise<void> => {
    const conversationId =
      readConversationId(contextStorage.getStore()?.get(ConversationIdKey)) ?? event.sessionId;
    if (conversationId !== event.sessionId) return;
    await Promise.all(processors.map((processor) => processor.releaseConversation(conversationId)));
  };
  return {
    events: { "session.completed": release, "session.failed": release },
    name: "eve.conversation-release",
    stateNamespace: "internal:conversation-release",
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
