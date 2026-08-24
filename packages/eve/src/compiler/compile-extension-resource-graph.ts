import type { CompiledAgentResources } from "#compiler/manifest.js";
import type { CompiledExternalDependencyPlanSession } from "#compiler/external-dependency-plan.js";
import { externalDependencyPlanPackageNames } from "#compiler/external-dependency-package-names.js";
import { createAgentModuleNamespaceLoader } from "#compiler/module-namespace-loader.js";
import { createCompiledRuntimeModelCatalogLoader } from "#compiler/model-catalog.js";
import { compileAgentResources } from "#compiler/normalize-manifest.js";
import type { ManifestCompileContext } from "#compiler/normalize-helpers.js";
import {
  isEffectiveModuleSource,
  prepareAgentConfigPhase,
  type AgentNodeSourceOrigin,
} from "#compiler/effective-agent-source-graph.js";
import { createCompiledSubagentNodeId } from "#compiler/manifest.js";
import type { AgentSourceManifest } from "#discover/manifest.js";
import { frameworkAgentSourceRegistry } from "#framework-sources/registry.js";

/** Compiles an extension tree through the same source graph used by mounted agents. */
export async function compileExtensionResourceGraph(input: {
  readonly externalDependencyPlanSession: CompiledExternalDependencyPlanSession;
  readonly extensionScope: { readonly namespace: string; readonly sourceRoot: string };
  readonly manifest: AgentSourceManifest;
  readonly namespace: string;
  readonly packageName: string;
  readonly runtimeDependencies: readonly string[];
}): Promise<readonly CompiledAgentResources[]> {
  const registry = frameworkAgentSourceRegistry;
  const context: ManifestCompileContext = {
    diagnostics: [],
    externalDependencyPlanSession: input.externalDependencyPlanSession,
    modelCatalog: createCompiledRuntimeModelCatalogLoader(input.manifest.appRoot),
    moduleLoader: createAgentModuleNamespaceLoader({
      externalDependencyPlanSession: input.externalDependencyPlanSession,
      registry,
    }),
    registry,
  };
  const origin: AgentNodeSourceOrigin = {
    extensionScope: input.extensionScope,
    layer: "extension-package",
    owner: {
      kind: "extension",
      namespace: input.namespace,
      packageName: input.packageName,
    },
  };
  const plannedRuntimeDependencies = externalDependencyPlanPackageNames(input.runtimeDependencies);

  const compileNode = async (
    manifest: AgentSourceManifest,
    nodeId: string,
    isExtensionRoot: boolean,
  ): Promise<CompiledAgentResources[]> => {
    await input.externalDependencyPlanSession.register(
      plannedRuntimeDependencies.map((packageName) => ({
        packageName,
        scope: {
          kind: "extension",
          namespace: input.namespace,
          nodeId,
          packageName: input.packageName,
          sourceRoot: input.extensionScope.sourceRoot,
        },
      })),
    );
    // Analyze the package root as a potential root-agent mount so root-only
    // contributions enter the graph, while contributed descendants stay non-root.
    const preparedConfig = await prepareAgentConfigPhase({
      context,
      externalDependencies: input.runtimeDependencies,
      isRoot: isExtensionRoot,
      manifest,
      nodeId,
      origin,
    });
    if (!isEffectiveModuleSource(preparedConfig.candidate.source)) {
      throw new Error(
        `Extension config source "${preparedConfig.candidate.descriptor.sourceId}" must be module-backed.`,
      );
    }
    const compilation = await compileAgentResources(manifest, context, {
      additionalConfigReference: preparedConfig.candidate.source,
      configGraph: preparedConfig.graph,
      declaredExternalDependencies: input.runtimeDependencies,
      externalDependencies: input.runtimeDependencies,
      instrumentationProvidersEnabled:
        isExtensionRoot && manifest.instrumentation.providers.length > 0,
      isRoot: isExtensionRoot,
      nodeId,
      origin,
    });
    const descendants = await Promise.all(
      compilation.subagents.map((subagent) =>
        compileNode(
          subagent.source.manifest,
          createCompiledSubagentNodeId(nodeId, subagent.source.sourceId),
          false,
        ),
      ),
    );
    return [compilation.resources, ...descendants.flat()];
  };

  return await compileNode(input.manifest, input.manifest.agentId, true);
}
