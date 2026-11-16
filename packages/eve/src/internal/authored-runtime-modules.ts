import type { AuthoredWorkflowModules } from "#internal/workflow-bundle/builder-support.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";
import {
  bundleAuthoredModuleForGeneration,
  bundleAuthoredModuleMapForGeneration,
} from "#internal/authored-module-loader.js";
import { collectHostTracedDependencies } from "#internal/host-traced-dependencies.js";
import { resolveInstrumentationLayout } from "#internal/instrumentation-layout.js";
import { mapConcurrent } from "#shared/map-concurrent.js";

interface PreparedAuthoredRuntimeInstrumentation {
  readonly kind: "directory";
  readonly moduleCodeBySlot: Readonly<Record<string, string>>;
}

export interface PreparedAuthoredRuntimeModules {
  readonly authoredWorkflowModules: AuthoredWorkflowModules;
  readonly instrumentation: PreparedAuthoredRuntimeInstrumentation;
  readonly moduleMapCode: string;
  /** Installed packages the generated modules import and the host bundles. */
  readonly hostBundledPackageRoots: readonly string[];
  readonly sourceModules: readonly string[];
  /** Identity of authored sources shared by the workflow driver and step registrations. */
  readonly workflowSourceFingerprint: string | undefined;
}

/** Builds the authored runtime graph before a development or production host packages it. */
export async function prepareAuthoredRuntimeModules(input: {
  readonly appRoot: string;
  readonly manifest: CompiledAgentManifest;
  readonly moduleMapPath: string;
  /** Whether the host bundles the prepared modules again, as hosted builds do. */
  readonly hostBundled?: boolean;
}): Promise<PreparedAuthoredRuntimeModules> {
  const hostBundle =
    input.hostBundled === true
      ? {
          tracedDependencies: collectHostTracedDependencies(input.manifest),
          externalPackageRoots: new Set<string>(),
        }
      : undefined;
  const {
    authoredWorkflowModules,
    code: moduleMapCode,
    sourceModules,
    workflowSourceFingerprint,
  } = await bundleAuthoredModuleMapForGeneration({
    appRoot: input.appRoot,
    manifest: input.manifest,
    moduleMapPath: input.moduleMapPath,
    hostBundle,
  });
  const layout = resolveInstrumentationLayout({ agentRoot: input.manifest.agentRoot });
  const externalDependencies = input.manifest.config.build?.externalDependencies ?? [];
  const bundleInstrumentationModule = async (sourcePath: string): Promise<string> =>
    await bundleAuthoredModuleForGeneration(sourcePath, { externalDependencies, hostBundle });
  const moduleCodeBySlot = Object.fromEntries(
    await mapConcurrent(Object.entries(layout.modulePathsBySlot), async ([slot, sourcePath]) => [
      slot,
      await bundleInstrumentationModule(sourcePath),
    ]),
  );
  const instrumentation = { kind: "directory", moduleCodeBySlot } as const;

  return {
    authoredWorkflowModules,
    hostBundledPackageRoots: [...(hostBundle?.externalPackageRoots ?? [])].sort(),
    instrumentation,
    moduleMapCode,
    sourceModules,
    workflowSourceFingerprint,
  };
}
