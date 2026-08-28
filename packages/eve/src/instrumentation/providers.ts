import type { InstrumentationProviderDefinition } from "#instrumentation/lifecycle.js";
import {
  getInstrumentationRuntime,
  type InstrumentationRuntime,
} from "#instrumentation/runtime.js";
import { createInstrumentationSetupContext } from "#instrumentation/setup-context.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { DEVELOPMENT_WORKER_APP_ROOT_ENV } from "#internal/workflow/development-world-protocol.js";
import { agentRuns, localTraces } from "#public/instrumentation/otel.js";
import { installInstrumentationRuntime } from "#tracing/install-instrumentation-runtime.js";
import { collectOtelPipeline } from "#tracing/otel-declaration.js";
import {
  isInstrumentationDisabled,
  isInstrumentationProvider,
  type InstrumentationProvider,
} from "#public/instrumentation/provider.js";

/**
 * Process-global registry of the providers authored under
 * `agent/instrumentation/`.
 *
 * Rooted on `globalThis` for the same reason the single-config store is: the
 * generated Nitro plugin stays external by `file://` URL while the harness
 * chunk is inlined, so the two resolve to distinct ESM module instances and
 * need one shared source of truth.
 */
const INSTRUMENTATION_PROVIDERS_GLOBAL_KEY = Symbol.for("eve.harness-instrumentation-providers");

/** One provider and the `instrumentation/<slot>.ts` file it came from. */
export interface RegisteredInstrumentationProvider {
  readonly provider: InstrumentationProvider;
  readonly slot: string;
}

interface InstrumentationProvidersGlobal {
  [INSTRUMENTATION_PROVIDERS_GLOBAL_KEY]?: Map<string, InstrumentationProvider>;
}

const globalContainer = globalThis as typeof globalThis & InstrumentationProvidersGlobal;

function providerRegistry(): Map<string, InstrumentationProvider> {
  const existing = globalContainer[INSTRUMENTATION_PROVIDERS_GLOBAL_KEY];
  if (existing !== undefined) {
    return existing;
  }

  const created = new Map<string, InstrumentationProvider>();
  globalContainer[INSTRUMENTATION_PROVIDERS_GLOBAL_KEY] = created;
  return created;
}

/** Fills reserved slots before authored files may reconfigure or disable them. */
export function seedInstrumentationProviders(): void {
  const registry = providerRegistry();
  if (process.env.VERCEL_ENV === "production") registry.set("agent-runs", agentRuns());
  if (process.env[DEVELOPMENT_WORKER_APP_ROOT_ENV] !== undefined) {
    registry.set("local", localTraces());
  }
}

/**
 * Registers one authored provider and awaits its `setup`.
 *
 * Called once per `instrumentation/<slot>.ts` by the generated Nitro plugin at
 * server startup, before any event is published. A default export that is not
 * a `defineInstrumentation` result throws rather than being skipped: a slot
 * that registers nothing is telemetry that silently does nothing, which is the
 * failure this surface exists to prevent.
 *
 * @internal — not part of the public API.
 */
export async function registerInstrumentationProvider(input: {
  readonly agentName: string;
  readonly slot: string;
  readonly value: unknown;
}): Promise<void> {
  if (isInstrumentationDisabled(input.value)) {
    providerRegistry().delete(input.slot);
    return;
  }

  if (!isInstrumentationProvider(input.value)) {
    throw new Error(
      `The default export of "instrumentation/${input.slot}" is not an instrumentation provider. Return the result of \`defineInstrumentation\` or \`disableInstrumentation\` from it.`,
    );
  }

  providerRegistry().set(input.slot, input.value);
  await input.value.setup?.(createInstrumentationSetupContext(input.agentName));
}

/** Registered providers in slot order. @internal */
export function getInstrumentationProviders(): readonly RegisteredInstrumentationProvider[] {
  return [...providerRegistry()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([slot, provider]) => ({ provider, slot }));
}

/**
 * Installs the process instrumentation runtime from the registered providers.
 *
 * Called once by the generated Nitro plugin after every slot has registered,
 * which is also why it cannot happen inside `setup`: the OpenTelemetry pipeline
 * is the union of every destination declared in the directory, so no single
 * file knows enough to build it. A `setup` that reaches for a tracer therefore
 * gets the no-op one; declare destinations as values and let this assemble
 * them.
 *
 * A directory that declared no OpenTelemetry at all still gets a bus. Its
 * providers see every event; they just have no spans to hang them on.
 *
 * @internal — not part of the public API.
 */
export function finalizeInstrumentationProviders(input: {
  readonly serviceName: string;
}): InstrumentationRuntime {
  const registered = getInstrumentationProviders();
  const providerDefinitions = registered.map(toProviderDefinition);
  const collected = collectOtelPipeline(registered.map((entry) => entry.provider));
  return installInstrumentationRuntime({
    collected,
    frameworkVersion: resolveInstalledPackageInfo().version,
    instrumentationProviders: true,
    providers: providerDefinitions,
    runtimeContextResolvers: collected.runtimeContextResolvers,
    serviceName: input.serviceName,
  });
}

/**
 * Releases every registered provider and OTel processor from Nitro's close
 * hook, the last point a buffered exporter can still reach the network.
 */
export async function shutdownInstrumentationProviders(): Promise<void> {
  await getInstrumentationRuntime()?.shutdown();
}

/**
 * Adapts an authored provider onto the internal bus contract.
 *
 * The event maps are the same shape — the public one is derived from the
 * internal union and both handlers take `(event, ctx)` — so only the name has
 * to be supplied.
 */
function toProviderDefinition(
  entry: RegisteredInstrumentationProvider,
): InstrumentationProviderDefinition {
  return {
    capture: entry.provider.capture,
    events: entry.provider.events as InstrumentationProviderDefinition["events"],
    flush: entry.provider.flush,
    // The file the provider came from, which is the only name an author can
    // recognize in a log line about it.
    name: entry.slot,
    shutdown: entry.provider.shutdown,
    stateNamespace: `authored:${entry.slot}`,
  };
}
