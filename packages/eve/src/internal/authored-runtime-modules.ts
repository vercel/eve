import type { CompiledAgentManifest } from "#compiler/manifest.js";
import {
  bundleAuthoredModuleForGeneration,
  bundleAuthoredModuleMapForGeneration,
} from "#internal/authored-module-loader.js";
import { resolveInstrumentationLayout } from "#internal/instrumentation-layout.js";

interface PreparedAuthoredRuntimeInstrumentation {
  readonly kind: "directory";
  readonly moduleCodeBySlot: Readonly<Record<string, string>>;
}

export interface PreparedAuthoredRuntimeModules {
  readonly instrumentation?: PreparedAuthoredRuntimeInstrumentation;
  readonly moduleMapCode: string;
  /** Identity of authored sources shared by the workflow driver and step registrations. */
  readonly workflowSourceFingerprint: string | undefined;
}

/** Builds the authored runtime graph before a development or production host packages it. */
export async function prepareAuthoredRuntimeModules(input: {
  readonly manifest: CompiledAgentManifest;
  readonly moduleMapPath: string;
}): Promise<PreparedAuthoredRuntimeModules> {
  const { code: moduleMapCode, workflowSourceFingerprint } =
    await bundleAuthoredModuleMapForGeneration(input);
  const providersEnabled = input.manifest.config.experimental?.instrumentationProviders ?? false;
  const layout = providersEnabled
    ? resolveInstrumentationLayout({ agentRoot: input.manifest.agentRoot, providersEnabled: true })
    : undefined;
  const externalDependencies = input.manifest.config.build?.externalDependencies ?? [];
  const bundleInstrumentationModule = async (sourcePath: string): Promise<string> =>
    await bundleAuthoredModuleForGeneration(sourcePath, { externalDependencies });
  let instrumentation: PreparedAuthoredRuntimeInstrumentation | undefined;

  if (layout?.kind === "directory") {
    const moduleCodeBySlot: Record<string, string> = {};
    for (const [slot, sourcePath] of Object.entries(layout.modulePathsBySlot)) {
      moduleCodeBySlot[slot] = await bundleInstrumentationModule(sourcePath);
    }
    instrumentation = { kind: "directory", moduleCodeBySlot };
  }

  return instrumentation === undefined
    ? { moduleMapCode, workflowSourceFingerprint }
    : { instrumentation, moduleMapCode, workflowSourceFingerprint };
}
