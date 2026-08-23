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

const INSTRUMENTATION_RUNTIME_KEY = Symbol.for("eve.instrumentation-runtime");

/** Process-wide runtime consumed by every harness execution surface. */
export interface InstrumentationRuntime {
  readonly forceFlush: () => Promise<void>;
  readonly hooks: InstrumentationHooks;
  readonly resolveControls: (context: TraceCaptureContext) => InstrumentationControls;
  readonly prepareSessionTrace?: (
    event: InstrumentationSessionStartedEvent,
  ) => Promise<InstrumentationTraceContext>;
  readonly prepareTurnTrace?: (
    event: InstrumentationTurnStartedEvent,
  ) => Promise<InstrumentationTraceContext>;
  otelSettings: OtelRuntimeSettings | undefined;
  /** Provider `runtimeContext` resolvers, collected at install time. */
  readonly runtimeContextResolvers?: readonly RuntimeContextResolver[];
  readonly runInContext: InstrumentationContextRunner;
  readonly runWithTracingSuppressed: <T>(execute: () => PromiseLike<T>) => PromiseLike<T>;
  readonly shutdown: () => Promise<void>;
}

/** Instrumentation capabilities consumed inside one harness execution. */
export type HarnessInstrumentation = Partial<
  Pick<
    InstrumentationRuntime,
    | "forceFlush"
    | "hooks"
    | "prepareSessionTrace"
    | "prepareTurnTrace"
    | "runtimeContextResolvers"
    | "runInContext"
    | "runWithTracingSuppressed"
  >
> & { readonly otelSettings?: OtelHarnessSettings };

type BoundHarnessInstrumentation = HarnessInstrumentation &
  Pick<InstrumentationRuntime, "forceFlush" | "hooks" | "runInContext">;

/** Binds process instrumentation to one delivery without exposing its audience. */
export function bindInstrumentationRuntime(
  runtime: InstrumentationRuntime,
  controls: InstrumentationControls,
): BoundHarnessInstrumentation {
  const hooks: InstrumentationHooks = {
    capturesContent:
      runtime.hooks.capturesContent && (controls.recordInputs || controls.recordOutputs),
    publish: async (event) => {
      const publish = () => runtime.hooks.publish(withInstrumentationControls(event, controls));
      await (controls.action === "drop" ? runtime.runWithTracingSuppressed(publish) : publish());
    },
  };
  const otelSettings = (() => {
    if (runtime.otelSettings === undefined) return undefined;
    const { tracePolicy: _tracePolicy, ...settings } = runtime.otelSettings;
    return {
      ...settings,
      enabled: controls.action === "record",
      recordInputs:
        controls.action === "record" && runtime.otelSettings.recordInputs === true
          ? controls.recordInputs
          : false,
      recordOutputs:
        controls.action === "record" && runtime.otelSettings.recordOutputs === true
          ? controls.recordOutputs
          : false,
    };
  })();

  return {
    forceFlush: runtime.forceFlush,
    hooks,
    otelSettings,
    prepareSessionTrace: controls.action === "record" ? runtime.prepareSessionTrace : undefined,
    prepareTurnTrace: controls.action === "record" ? runtime.prepareTurnTrace : undefined,
    runtimeContextResolvers:
      controls.action === "record" ? runtime.runtimeContextResolvers : undefined,
    runInContext:
      controls.action === "record"
        ? runtime.runInContext
        : (_operation, execute) => runtime.runWithTracingSuppressed(execute),
    runWithTracingSuppressed:
      controls.action === "drop" ? runtime.runWithTracingSuppressed : undefined,
  };
}

type InstrumentationGlobal = typeof globalThis & {
  [INSTRUMENTATION_RUNTIME_KEY]?: InstrumentationRuntime;
};

const globalRuntime = globalThis as InstrumentationGlobal;

/** Registers the process instrumentation runtime before agent execution begins. */
export function registerInstrumentationRuntime(
  runtime: InstrumentationRuntime,
): InstrumentationRuntime {
  const existing = globalRuntime[INSTRUMENTATION_RUNTIME_KEY];
  if (existing !== undefined) {
    // A legacy config may reload without taking ownership from the installed runtime.
    existing.otelSettings = runtime.otelSettings;
    return existing;
  }
  globalRuntime[INSTRUMENTATION_RUNTIME_KEY] = runtime;
  return runtime;
}

/** Returns the process instrumentation runtime, when one was installed. */
export function getInstrumentationRuntime(): InstrumentationRuntime | undefined {
  return globalRuntime[INSTRUMENTATION_RUNTIME_KEY];
}
