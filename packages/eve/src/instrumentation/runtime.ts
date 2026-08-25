import type {
  InstrumentationContextRunner,
  InstrumentationHooks,
  InstrumentationSessionStartedEvent,
  InstrumentationTraceContext,
  InstrumentationTurnStartedEvent,
} from "#instrumentation/lifecycle.js";
import type { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import type { OtelHarnessSettings, RuntimeContextResolver } from "#tracing/otel-declaration.js";

const INSTRUMENTATION_RUNTIME_KEY = Symbol.for("eve.instrumentation-runtime");

/** Process-wide runtime consumed by every harness execution surface. */
export interface InstrumentationRuntime {
  readonly forceFlush: () => Promise<void>;
  readonly hooks: InstrumentationHooks;
  readonly idGenerator?: AgentSpanIdGenerator;
  readonly prepareSessionTrace?: (
    event: InstrumentationSessionStartedEvent,
  ) => Promise<InstrumentationTraceContext>;
  readonly prepareTurnTrace?: (
    event: InstrumentationTurnStartedEvent,
  ) => Promise<InstrumentationTraceContext>;
  otelSettings: OtelHarnessSettings | undefined;
  readonly runtimeContextResolvers?: readonly RuntimeContextResolver[];
  readonly runInContext: InstrumentationContextRunner;
  readonly shutdown: () => Promise<void>;
}

/** Instrumentation capabilities consumed inside one harness execution. */
export type HarnessInstrumentation = Pick<
  InstrumentationRuntime,
  "hooks" | "prepareSessionTrace" | "prepareTurnTrace" | "runInContext"
>;

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
