import type { Telemetry } from "ai";

import { getRegisteredTelemetryIntegrations } from "#harness/ai-sdk-telemetry.js";
import { withInstrumentationDecision } from "#harness/instrumentation/content.js";
import type {
  InstrumentationContextRunner,
  InstrumentationHooks,
  InstrumentationSessionStartedEvent,
  InstrumentationTraceContext,
  InstrumentationTurnStartedEvent,
} from "#harness/instrumentation/lifecycle.js";
import type { InstrumentationDefinition } from "#public/instrumentation/index.js";
import type { InstrumentationDecision } from "#shared/instrumentation-decision.js";
import type {
  OtelHarnessSettings,
  OtelRuntimeSettings,
  RuntimeContextResolver,
  TraceCaptureContext,
} from "#tracing/otel-declaration.js";

const INSTRUMENTATION_RUNTIME_KEY = Symbol.for("eve.instrumentation-runtime");
const UPDATE_OTEL_SETTINGS = Symbol.for("eve.instrumentation-runtime.update-otel-settings");

export interface HarnessInstrumentation {
  readonly authoredConfig?: InstrumentationDefinition;
  readonly forceFlush?: () => Promise<void>;
  readonly hooks?: InstrumentationHooks;
  readonly otelSettings?: OtelHarnessSettings;
  readonly prepareSessionTrace?: (
    event: InstrumentationSessionStartedEvent,
  ) => Promise<InstrumentationTraceContext>;
  readonly prepareTurnTrace?: (
    event: InstrumentationTurnStartedEvent,
  ) => Promise<InstrumentationTraceContext>;
  readonly runtimeContextResolvers?: readonly RuntimeContextResolver[];
  readonly runInContext?: InstrumentationContextRunner;
  readonly telemetryIntegrations?: readonly Telemetry[];
}

export interface ConstructedInstrumentation {
  readonly harness?: HarnessInstrumentation;
  run<T>(execute: () => PromiseLike<T>): PromiseLike<T>;
}

/** Process runtime that can only resolve and construct scoped instrumentation. */
export interface InstrumentationRuntime {
  readonly [UPDATE_OTEL_SETTINGS]: (settings: OtelRuntimeSettings | undefined) => void;
  readonly construct: (decision: InstrumentationDecision) => ConstructedInstrumentation;
  readonly forceFlush: () => Promise<void>;
  readonly resolveDecision: (context: TraceCaptureContext) => InstrumentationDecision;
  readonly shutdown: () => Promise<void>;
  readonly traceChannelRequests: boolean;
}

interface InstrumentationConstructionInput {
  readonly authoredConfig?: InstrumentationDefinition;
  readonly forceFlush: () => Promise<void>;
  readonly hooks: InstrumentationHooks;
  readonly otelSettings: OtelRuntimeSettings | undefined;
  readonly prepareSessionTrace?: HarnessInstrumentation["prepareSessionTrace"];
  readonly prepareTurnTrace?: HarnessInstrumentation["prepareTurnTrace"];
  readonly resolveDecision: InstrumentationRuntime["resolveDecision"];
  readonly runtimeContextResolvers?: readonly RuntimeContextResolver[];
  readonly runInContext: InstrumentationContextRunner;
  readonly runWithTracingSuppressed: <T>(execute: () => PromiseLike<T>) => PromiseLike<T>;
  readonly shutdown: () => Promise<void>;
}

export function createInstrumentationRuntime(
  input: InstrumentationConstructionInput,
): InstrumentationRuntime {
  let runtimeSettings = input.otelSettings;
  return {
    [UPDATE_OTEL_SETTINGS]: (settings) => {
      runtimeSettings = settings;
    },
    construct: (decision) => construct(input, runtimeSettings, decision),
    forceFlush: input.forceFlush,
    resolveDecision: input.resolveDecision,
    shutdown: input.shutdown,
    get traceChannelRequests() {
      return runtimeSettings?.traceChannelRequests === true;
    },
  };
}

function construct(
  input: InstrumentationConstructionInput,
  runtimeSettings: OtelRuntimeSettings | undefined,
  decision: InstrumentationDecision,
): ConstructedInstrumentation {
  if (decision.action === "drop") {
    return {
      harness: {
        forceFlush: input.forceFlush,
        runInContext: (_operation, execute) => input.runWithTracingSuppressed(execute),
      },
      run: input.runWithTracingSuppressed,
    };
  }

  const hooks: InstrumentationHooks = {
    capturesContent:
      input.hooks.capturesContent && (decision.recordInputs || decision.recordOutputs),
    publish: (event) => input.hooks.publish(withInstrumentationDecision(event, decision)),
  };
  const otelSettings =
    runtimeSettings === undefined
      ? undefined
      : {
          functionId: runtimeSettings.functionId,
          recordInputs: runtimeSettings.recordInputs === true && decision.recordInputs,
          recordOutputs: runtimeSettings.recordOutputs === true && decision.recordOutputs,
          traceChannelRequests: runtimeSettings.traceChannelRequests,
        };
  return {
    harness: {
      authoredConfig: input.authoredConfig,
      forceFlush: input.forceFlush,
      hooks,
      otelSettings,
      prepareSessionTrace: input.prepareSessionTrace,
      prepareTurnTrace: input.prepareTurnTrace,
      runtimeContextResolvers: input.runtimeContextResolvers,
      runInContext: input.runInContext,
      telemetryIntegrations:
        decision.recordInputs && decision.recordOutputs ? getRegisteredTelemetryIntegrations() : [],
    },
    run: (execute) => execute(),
  };
}

type InstrumentationGlobal = typeof globalThis & {
  [INSTRUMENTATION_RUNTIME_KEY]?: InstrumentationRuntime;
};

const globalRuntime = globalThis as InstrumentationGlobal;

export function registerInstrumentationRuntime(
  runtime: InstrumentationRuntime,
  otelSettings: OtelRuntimeSettings | undefined,
): InstrumentationRuntime {
  const existing = globalRuntime[INSTRUMENTATION_RUNTIME_KEY];
  if (existing !== undefined) {
    existing[UPDATE_OTEL_SETTINGS](otelSettings);
    return existing;
  }
  globalRuntime[INSTRUMENTATION_RUNTIME_KEY] = runtime;
  return runtime;
}

export function getInstrumentationRuntime(): InstrumentationRuntime | undefined {
  return globalRuntime[INSTRUMENTATION_RUNTIME_KEY];
}
