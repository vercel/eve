import type { InstrumentationProviderDefinition } from "#instrumentation/lifecycle.js";
import {
  getInstrumentationRuntime,
  type InstrumentationRuntime,
} from "#instrumentation/runtime.js";
import { createInstrumentationSetupContext } from "#instrumentation/setup-context.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { DEVELOPMENT_WORKER_APP_ROOT_ENV } from "#internal/workflow/development-world-protocol.js";
import { agentRuns, localTraces } from "#public/instrumentation/otel.js";
import { installInstrumentationRuntime } from "#tracing/eve/install-instrumentation-runtime.js";
import { collectOtelPipeline } from "#tracing/eve/otel-declaration.js";
import {
  isInstrumentationDisabled,
  type InstrumentationProvider,
} from "#instrumentation/provider.js";

const INSTRUMENTATION_PROVIDERS_GLOBAL_KEY = Symbol.for("eve.harness-instrumentation-providers");

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

export function seedInstrumentationProviders(): void {
  const registry = providerRegistry();
  if (process.env.VERCEL_ENV === "preview" || process.env.VERCEL_ENV === "production") {
    registry.set("agent-runs", agentRuns());
  }
  if (process.env[DEVELOPMENT_WORKER_APP_ROOT_ENV] !== undefined) {
    registry.set("local", localTraces());
  }
}

/** @internal */
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

  if (Object.hasOwn(input.value, "capture")) {
    throw new Error(
      `The instrumentation provider "instrumentation/${input.slot}" no longer supports \`capture\`. Use \`tracePolicy\` to configure content capture.`,
    );
  }

  providerRegistry().set(input.slot, input.value);
  await input.value.setup?.(createInstrumentationSetupContext(input.agentName));
}

/** @internal */
export function getInstrumentationProviders(): readonly RegisteredInstrumentationProvider[] {
  return [...providerRegistry()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([slot, provider]) => ({ provider, slot }));
}

/** @internal */
export function finalizeInstrumentationProviders(input: {
  readonly serviceName: string;
}): InstrumentationRuntime {
  const registered = getInstrumentationProviders();
  const providerDefinitions = registered.map(toProviderDefinition);
  const collected = collectOtelPipeline(registered.map((entry) => entry.provider));
  return installInstrumentationRuntime({
    collected,
    frameworkVersion: resolveInstalledPackageInfo().version,
    providers: providerDefinitions,
    runtimeContextResolvers: collected.runtimeContextResolvers,
    serviceName: input.serviceName,
  });
}

export async function shutdownInstrumentationProviders(): Promise<void> {
  await getInstrumentationRuntime()?.shutdown();
}

function toProviderDefinition(
  entry: RegisteredInstrumentationProvider,
): InstrumentationProviderDefinition {
  return {
    events: entry.provider.events as InstrumentationProviderDefinition["events"],
    flush: entry.provider.flush,
    name: entry.slot,
    shutdown: entry.provider.shutdown,
    stateNamespace: `authored:${entry.slot}`,
    tracePolicy: entry.provider.tracePolicy,
  };
}

import { isInstrumentationProvider } from "#instrumentation/provider.js";
