import { basename } from "node:path";

import {
  isCompiledInstrumentationActivationActive,
  type CompiledInstrumentationRuntimeMode,
} from "#compiler/instrumentation-plan-activation.js";
import type { CompiledInstrumentationPlan } from "#compiler/manifest.js";
import { registerInstrumentationConfig } from "#harness/instrumentation/config.js";
import {
  finalizeInstrumentationProviders,
  registerInstrumentationProvider,
  shutdownInstrumentationProviders,
} from "#harness/instrumentation/providers.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import type { InstrumentationDefinition } from "#public/instrumentation/index.js";
import { installLocalInstrumentationRuntime } from "#tracing/local-instrumentation-runtime.js";

export type { CompiledInstrumentationRuntimeMode } from "#compiler/instrumentation-plan-activation.js";

/** Installs exactly the active entries from the compiler-owned instrumentation plan. */
export async function installCompiledInstrumentationPlan(input: {
  readonly appRoot: string;
  readonly loadModule: (sourceId: string) => Promise<Readonly<Record<string, unknown>>>;
  readonly mode: CompiledInstrumentationRuntimeMode;
  readonly plan: CompiledInstrumentationPlan;
  readonly serviceName: string;
}): Promise<() => Promise<void>> {
  if (input.plan.kind === "none") return async () => undefined;

  if (input.plan.kind === "file") {
    const entry = input.plan.entry;
    if (!isCompiledInstrumentationActivationActive(entry.activation, input.mode)) {
      return async () => undefined;
    }
    if (entry.implementation === "local-tracing") {
      const runtime = installLocalInstrumentationRuntime({
        appRoot: input.appRoot,
        frameworkVersion: resolveInstalledPackageInfo().version,
        serviceName: basename(input.appRoot),
      });
      return async () => await runtime.shutdown();
    }
    const namespace = await input.loadModule(entry.source.sourceId);
    if (namespace.default !== null && namespace.default !== undefined) {
      await registerInstrumentationConfig(namespace.default as InstrumentationDefinition, {
        agentName: input.serviceName,
      });
    }
    return async () => undefined;
  }

  for (const entry of input.plan.entries) {
    if (!isCompiledInstrumentationActivationActive(entry.activation, input.mode)) continue;
    const namespace = await input.loadModule(entry.source.sourceId);
    await registerInstrumentationProvider({
      agentName: input.serviceName,
      slot: entry.slot,
      value: namespace.default,
    });
  }
  finalizeInstrumentationProviders({ serviceName: input.serviceName });
  return shutdownInstrumentationProviders;
}
