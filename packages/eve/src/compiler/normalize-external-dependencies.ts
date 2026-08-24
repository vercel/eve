import type { CompiledExtensionMount } from "#compiler/manifest.js";
import type {
  AgentNodeSourceOrigin,
  EffectiveAgentNodeSourceGraph,
} from "#compiler/effective-agent-source-graph.js";
import type {
  CompiledExternalDependencyRequest,
  CompiledExternalDependencyScope,
} from "#compiler/external-dependency-plan.js";
import { externalDependencyPlanPackageNames } from "#compiler/external-dependency-package-names.js";
import { mountRefNamespace } from "#discover/extensions.js";
import type { AgentSourceManifest } from "#discover/manifest.js";
import { packageStateNamespace } from "#shared/extension-state-namespace.js";

/** Compiles selected extension mounts and their exact node-scoped dependency requests. */
export function compileNodeExternalDependencySelection(input: {
  readonly declaredExternalDependencies: readonly string[];
  readonly graph: EffectiveAgentNodeSourceGraph;
  readonly manifest: AgentSourceManifest;
  readonly nodeId: string;
  readonly origin?: AgentNodeSourceOrigin;
}): {
  readonly extensionMounts: CompiledExtensionMount[];
  readonly requests: CompiledExternalDependencyRequest[];
} {
  const extensionMounts = compileExtensionMounts(input.manifest, input.graph);
  const dependencyScope = createCompileNodeExternalDependencyScope(
    input.manifest,
    input.nodeId,
    input.origin,
  );
  return {
    extensionMounts,
    requests: [
      ...externalDependencyPlanPackageNames(input.declaredExternalDependencies).map(
        (packageName) => ({
          packageName,
          scope: dependencyScope,
        }),
      ),
      ...extensionMounts.flatMap((mount) =>
        externalDependencyPlanPackageNames(mount.externalDependencies).map((packageName) => ({
          packageName,
          scope: {
            kind: "extension" as const,
            namespace: mount.namespace,
            nodeId: input.nodeId,
            packageName: mount.packageName,
            sourceRoot: mount.sourceRoot,
          },
        })),
      ),
    ],
  };
}

function compileExtensionMounts(
  manifest: AgentSourceManifest,
  graph: EffectiveAgentNodeSourceGraph,
): CompiledExtensionMount[] {
  const selected = new Set(
    graph.winners
      .filter((candidate) => candidate.kind === "extension-mount")
      .map((candidate) => candidate.descriptor.sourceId),
  );
  return manifest.resolvedExtensions.flatMap((mount) => {
    const mountRef = manifest.extensions.find(
      (entry) => mountRefNamespace(entry.logicalPath) === mount.namespace,
    );
    if (mountRef === undefined || !selected.has(mountRef.sourceId)) return [];
    return [
      {
        externalDependencies: [...mount.externalDependencies],
        namespace: mount.namespace,
        packageName: mount.packageName,
        packageNamespace: packageStateNamespace(mount.packageName),
        sourceRoot: mount.sourceRoot,
        mountSourceId: mountRef.sourceId,
        mountLogicalPath: mountRef.logicalPath,
      },
    ];
  });
}

function createCompileNodeExternalDependencyScope(
  manifest: AgentSourceManifest,
  nodeId: string,
  origin: AgentNodeSourceOrigin | undefined,
): CompiledExternalDependencyScope {
  if (origin?.owner.kind === "extension") {
    const sourceRoot = origin.extensionScope?.sourceRoot;
    if (sourceRoot === undefined) {
      throw new Error(
        `Extension-owned node "${nodeId}" is missing its external dependency source root.`,
      );
    }
    return {
      kind: "extension",
      namespace: origin.owner.namespace,
      nodeId,
      packageName: origin.owner.packageName,
      sourceRoot,
    };
  }
  return { kind: "application", nodeId, sourceRoot: manifest.appRoot };
}
