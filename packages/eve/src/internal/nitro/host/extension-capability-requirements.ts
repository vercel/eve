import {
  EXTENSION_CAPABILITY_VERSIONS,
  type ExtensionCapability,
  type ExtensionCapabilityRequirements,
} from "#compiler/extension-compatibility.js";
import { compileExtensionResourceGraph } from "#compiler/compile-extension-resource-graph.js";
import { createCompiledExternalDependencyPlanSession } from "#compiler/external-dependency-plan.js";
import { externalDependencyPlanPackageNames } from "#compiler/external-dependency-package-names.js";
import type { CompiledAgentResources } from "#compiler/manifest.js";
import { createAgentModuleNamespaceLoader } from "#compiler/module-namespace-loader.js";
import type { AgentSourceManifest } from "#discover/manifest.js";
import type { ExtensionDeclarationBinding } from "#internal/nitro/host/extension-declaration-binding.js";
import { extensionUsesState } from "#internal/nitro/host/extension-state-usage.js";

/** Derives only the extension-facing contracts used by one authored tree. */
export async function deriveExtensionCapabilityRequirements(input: {
  readonly declarationBinding: ExtensionDeclarationBinding;
  readonly declarationExportName?: string;
  readonly manifest: AgentSourceManifest;
}): Promise<ExtensionCapabilityRequirements> {
  const required = new Set<ExtensionCapability>(["extension"]);
  const { backing, owner } = input.declarationBinding;
  const externalDependencyPlanSession = createCompiledExternalDependencyPlanSession();
  const plannedExternalDependencies = externalDependencyPlanPackageNames(
    backing.externalDependencies,
  );
  await externalDependencyPlanSession.register(
    plannedExternalDependencies.map((packageName) => ({
      packageName,
      scope: {
        kind: "extension",
        namespace: owner.namespace,
        nodeId: input.manifest.agentId,
        packageName: owner.packageName,
        sourceRoot: backing.extensionScope.sourceRoot,
      },
    })),
  );
  const moduleLoader = createAgentModuleNamespaceLoader({ externalDependencyPlanSession });
  const [resources, declaration, usesState] = await Promise.all([
    compileExtensionResourceGraph({
      externalDependencyPlanSession,
      extensionScope: backing.extensionScope,
      manifest: input.manifest,
      namespace: owner.namespace,
      packageName: owner.packageName,
      runtimeDependencies: backing.externalDependencies,
    }),
    moduleLoader.load(backing),
    extensionUsesState(backing.extensionScope.sourceRoot),
  ]);
  await externalDependencyPlanSession.verify();

  const ownedSourceIds = resources.map(extensionOwnedSourceIds);
  const owns = (nodeIndex: number, sourceId: string): boolean =>
    ownedSourceIds[nodeIndex]!.has(sourceId);
  if (resources.some((node, index) => node.tools.some((entry) => owns(index, entry.sourceId)))) {
    required.add("tool");
  }
  if (
    resources.some((node, index) => node.dynamicTools.some((entry) => owns(index, entry.sourceId)))
  ) {
    required.add("tool");
    required.add("dynamicTool");
  }
  if (
    resources.some((node, index) =>
      node.channelRoutes.effective.some((entry) => owns(index, entry.sourceId)),
    )
  ) {
    required.add("channel");
  }
  if (
    resources.some((node, index) => node.connections.some((entry) => owns(index, entry.sourceId)))
  ) {
    required.add("connection");
  }
  if (resources.some((node, index) => node.hooks.some((entry) => owns(index, entry.sourceId)))) {
    required.add("hook");
  }
  if (
    resources.some((node, index) => node.schedules.some((entry) => owns(index, entry.sourceId)))
  ) {
    required.add("schedule");
  }
  if (collectSubagentManifests(input.manifest).some((manifest) => manifest.subagents.length > 0)) {
    required.add("subagent");
  }
  if (resources.some((node, index) => node.skills.some((entry) => owns(index, entry.sourceId)))) {
    required.add("skill");
  }
  if (
    resources.some((node, index) => node.dynamicSkills.some((entry) => owns(index, entry.sourceId)))
  ) {
    required.add("skill");
    required.add("dynamicSkill");
  }
  if (
    resources.some((node, index) => node.instructions.some((entry) => owns(index, entry.sourceId)))
  ) {
    required.add("instructions");
  }
  if (
    resources.some((node, index) =>
      node.dynamicInstructions.some((entry) => owns(index, entry.sourceId)),
    )
  ) {
    required.add("instructions");
    required.add("dynamicInstructions");
  }
  if (resources.some((node, index) => ownsInstrumentation(node, ownedSourceIds[index]!))) {
    required.add("instrumentation");
  }
  const declarationExport = declaration[input.declarationExportName ?? "default"];
  if (
    (typeof declarationExport === "function" ||
      (typeof declarationExport === "object" && declarationExport !== null)) &&
    "schema" in declarationExport &&
    declarationExport.schema !== undefined
  ) {
    required.add("config");
  }
  if (usesState) required.add("state");

  return Object.fromEntries(
    (Object.keys(EXTENSION_CAPABILITY_VERSIONS) as ExtensionCapability[])
      .filter((capability) => required.has(capability))
      .map((capability) => [capability, EXTENSION_CAPABILITY_VERSIONS[capability]]),
  );
}

function ownsInstrumentation(
  resources: CompiledAgentResources,
  ownedSourceIds: ReadonlySet<string>,
): boolean {
  if (resources.instrumentation.kind === "none") return false;
  if (resources.instrumentation.kind === "file") {
    return ownedSourceIds.has(resources.instrumentation.entry.source.sourceId);
  }
  return resources.instrumentation.entries.some((entry) =>
    ownedSourceIds.has(entry.source.sourceId),
  );
}

function extensionOwnedSourceIds(resources: CompiledAgentResources): ReadonlySet<string> {
  const sourceIds = new Set(
    Object.entries(resources.bindings)
      .filter(([, binding]) => binding.owner.kind === "extension")
      .map(([sourceId]) => sourceId),
  );
  for (const entry of resources.sourceComposition.selected) {
    if (entry.sourceKind === "non-module" && entry.source.owner.kind === "extension") {
      sourceIds.add(entry.source.sourceId);
    }
  }
  return sourceIds;
}

function collectSubagentManifests(manifest: AgentSourceManifest): AgentSourceManifest[] {
  return [
    manifest,
    ...manifest.subagents.flatMap((subagent) => collectSubagentManifests(subagent.manifest)),
  ];
}
