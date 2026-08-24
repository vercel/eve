import type {
  InstrumentationContextRunner,
  InstrumentationHooks,
  InstrumentationSessionStartedEvent,
  InstrumentationTraceContext,
  InstrumentationTurnStartedEvent,
} from "#harness/instrumentation/lifecycle.js";
import { withInstrumentationControls } from "#harness/instrumentation/content.js";
import type { InstrumentationControls } from "#shared/instrumentation-controls.js";
import type {
  OtelHarnessSettings,
  OtelRuntimeSettings,
  RuntimeContextResolver,
  TraceCaptureContext,
} from "#tracing/otel-declaration.js";
import type { InstrumentationDefinition } from "#public/instrumentation/index.js";
import { getRegisteredTelemetryIntegrations } from "#harness/ai-sdk-telemetry.js";

const INSTRUMENTATION_RUNTIME_KEY = Symbol.for("eve.instrumentation-runtime");
const UPDATE_OTEL_SETTINGS = Symbol.for("eve.instrumentation-runtime.update-otel-settings");

/** Process-wide runtime consumed by every harness execution surface. */
export interface InstrumentationRuntime {
  readonly [UPDATE_OTEL_SETTINGS]: (settings: OtelRuntimeSettings | undefined) => void;
  readonly construct: (controls: InstrumentationControls) => ConstructedInstrumentation;
  readonly forceFlush: () => Promise<void>;
  readonly resolveDecision: (context: TraceCaptureContext) => InstrumentationControls;
  readonly shutdown: () => Promise<void>;
  readonly traceChannelRequests: boolean;
}

type PrepareSessionTrace = (
  event: InstrumentationSessionStartedEvent,
) => Promise<InstrumentationTraceContext>;
type PrepareTurnTrace = (
  event: InstrumentationTurnStartedEvent,
) => Promise<InstrumentationTraceContext>;
type RunWithTracingSuppressed = <T>(execute: () => PromiseLike<T>) => PromiseLike<T>;

interface InstrumentationConstructionInput {
  readonly authoredConfig?: InstrumentationDefinition;
  readonly createHooks: (controls: InstrumentationControls) => InstrumentationHooks;
  readonly forceFlush: InstrumentationRuntime["forceFlush"];
  readonly prepareSessionTrace?: PrepareSessionTrace;
  readonly prepareTurnTrace?: PrepareTurnTrace;
  readonly resolveDecision: InstrumentationRuntime["resolveDecision"];
  readonly runtimeContextResolvers?: readonly RuntimeContextResolver[];
  readonly runInContext: InstrumentationContextRunner;
  readonly runWithTracingSuppressed: RunWithTracingSuppressed;
  readonly shutdown: InstrumentationRuntime["shutdown"];
  readonly otelSettings: OtelRuntimeSettings | undefined;
}

/** Instrumentation capabilities consumed inside one harness execution. */
export interface HarnessInstrumentation {
  readonly authoredConfig?: InstrumentationDefinition;
  readonly forceFlush?: InstrumentationRuntime["forceFlush"];
  readonly hooks?: InstrumentationHooks;
  readonly otelSettings?: OtelHarnessSettings;
  readonly prepareSessionTrace?: PrepareSessionTrace;
  readonly prepareTurnTrace?: PrepareTurnTrace;
  readonly runtimeContextResolvers?: readonly RuntimeContextResolver[];
  readonly runInContext?: InstrumentationContextRunner;
  readonly telemetryIntegrations?: readonly Telemetry[];
}

type BoundHarnessInstrumentation = HarnessInstrumentation & {
  readonly forceFlush: NonNullable<HarnessInstrumentation["forceFlush"]>;
  readonly hooks: NonNullable<HarnessInstrumentation["hooks"]>;
  readonly runInContext: NonNullable<HarnessInstrumentation["runInContext"]>;
};

export interface ConstructedInstrumentation {
  readonly harness?: BoundHarnessInstrumentation;
  run<T>(execute: () => PromiseLike<T>): PromiseLike<T>;
}

/** Constructs one decision-bound instrumentation capability. */
export function constructInstrumentation(
  runtime: InstrumentationRuntime,
  controls: InstrumentationControls,
): ConstructedInstrumentation {
  return runtime.construct(controls);
}

export function createInstrumentationRuntime(
  input: InstrumentationConstructionInput,
): InstrumentationRuntime {
  let runtimeSettings = input.otelSettings;
  return {
    [UPDATE_OTEL_SETTINGS]: (settings) => {
      runtimeSettings = settings;
    },
    construct: (controls) => constructFromComponents(input, runtimeSettings, controls),
    forceFlush: input.forceFlush,
    resolveDecision: input.resolveDecision,
    shutdown: input.shutdown,
    get traceChannelRequests() {
      return runtimeSettings?.traceChannelRequests === true;
    },
  };
}

function constructFromComponents(
  input: InstrumentationConstructionInput,
  runtimeSettings: OtelRuntimeSettings | undefined,
  controls: InstrumentationControls,
): ConstructedInstrumentation {
  const runtimeHooks = input.createHooks(controls);
  const hooks: InstrumentationHooks = {
    capturesContent:
      runtimeHooks.capturesContent && (controls.recordInputs || controls.recordOutputs),
    publish: async (event) => {
      const publish = () => runtimeHooks.publish(withInstrumentationControls(event, controls));
      await (controls.action === "drop" ? input.runWithTracingSuppressed(publish) : publish());
    },
  };
  const otelSettings = (() => {
    if (runtimeSettings === undefined || controls.action === "drop") return undefined;
    const { tracePolicy: _tracePolicy, ...settings } = runtimeSettings;
    return {
      ...settings,
      recordInputs:
        controls.action === "record" && runtimeSettings.recordInputs === true
          ? controls.recordInputs
          : false,
      recordOutputs:
        controls.action === "record" && runtimeSettings.recordOutputs === true
          ? controls.recordOutputs
          : false,
    };
  })();

  const run =
    controls.action === "drop"
      ? input.runWithTracingSuppressed
      : <T>(execute: () => PromiseLike<T>): PromiseLike<T> => execute();
  return {
    harness: {
      authoredConfig: input.authoredConfig,
      forceFlush: input.forceFlush,
      hooks,
      otelSettings,
      prepareSessionTrace: controls.action === "record" ? input.prepareSessionTrace : undefined,
      prepareTurnTrace: controls.action === "record" ? input.prepareTurnTrace : undefined,
      runtimeContextResolvers:
        controls.action === "record" ? input.runtimeContextResolvers : undefined,
      runInContext:
        controls.action === "record"
          ? input.runInContext
          : (_operation, execute) => input.runWithTracingSuppressed(execute),
      telemetryIntegrations:
        controls.action === "record" && controls.recordInputs && controls.recordOutputs
          ? getRegisteredTelemetryIntegrations()
          : [],
    },
    run,
  };
}

type InstrumentationGlobal = typeof globalThis & {
  [INSTRUMENTATION_RUNTIME_KEY]?: InstrumentationRuntime;
};

const globalRuntime = globalThis as InstrumentationGlobal;

/** Registers the process instrumentation runtime before agent execution begins. */
export function registerInstrumentationRuntime(
  runtime: InstrumentationRuntime,
  otelSettings: OtelRuntimeSettings | undefined,
): InstrumentationRuntime {
  const existing = globalRuntime[INSTRUMENTATION_RUNTIME_KEY];
  if (existing !== undefined) {
    // A legacy config may reload without taking ownership from the installed runtime.
    existing[UPDATE_OTEL_SETTINGS](otelSettings);
    return existing;
  }
  globalRuntime[INSTRUMENTATION_RUNTIME_KEY] = runtime;
  return runtime;
}

/** Returns the process instrumentation runtime, when one was installed. */
export function getInstrumentationRuntime(): InstrumentationRuntime | undefined {
  return globalRuntime[INSTRUMENTATION_RUNTIME_KEY];
}
import type { Telemetry } from "ai";
