import type {
  CompiledAgentManifest,
  CompiledAgentNodeManifest,
  CompiledAgentResources,
  CompiledExtensionMount,
  CompiledSubagentNode,
} from "#compiler/manifest.js";
import {
  assertCompiledExternalDependencyPlanSemantics,
  type CompiledExternalDependencyScope,
} from "#compiler/external-dependency-plan.js";
import { externalDependencyPlanPackageNames } from "#compiler/external-dependency-package-names.js";
import { createCompiledSubagentExternalDependencyScope } from "#compiler/compiled-external-dependencies.js";
import type {
  AgentSourceOwner,
  CompiledModuleBacking,
  CompiledModuleBinding,
} from "#compiler/module-binding.js";

interface ExtensionDependencyAuthority {
  readonly dependencies: ReadonlySet<string>;
  readonly namespace: string;
  readonly packageName: string;
  readonly sourceRoot: string;
}

/** Validates plan ownership and every filesystem binding reference. */
export function assertCompiledAgentExternalDependencyPlan(manifest: CompiledAgentManifest): void {
  assertCompiledExternalDependencyPlanSemantics(manifest.externalDependencyPlan);
  const entriesById = new Map(
    manifest.externalDependencyPlan.entries.map((entry) => [entry.id, entry] as const),
  );
  const expectedScopesByEntry = new Map<string, Set<string>>();
  const nodes = [
    {
      dependencyScope: {
        kind: "application" as const,
        nodeId: "__root__",
        sourceRoot: manifest.appRoot,
      },
      nodeId: "__root__",
      resources: manifest,
    },
    ...manifest.subagents.map((subagent) => ({
      dependencyScope: createCompiledSubagentExternalDependencyScope(subagent),
      nodeId: subagent.nodeId,
      resources: subagent.agent,
    })),
  ];

  for (const { dependencyScope, nodeId, resources } of nodes) {
    const configDependencies =
      "config" in resources
        ? (resources.config.build?.externalDependencies ?? [])
        : (manifest.subagents.find((subagent) => subagent.nodeId === nodeId)?.configResolver?.build
            ?.externalDependencies ?? []);
    for (const packageName of externalDependencyPlanPackageNames(configDependencies)) {
      addExpectedExternalDependencyScope(expectedScopesByEntry, packageName, dependencyScope);
    }
    for (const mount of resources.extensionMounts) {
      for (const packageName of externalDependencyPlanPackageNames(mount.externalDependencies)) {
        addExpectedExternalDependencyScope(expectedScopesByEntry, packageName, {
          kind: "extension",
          namespace: mount.namespace,
          nodeId,
          packageName: mount.packageName,
          sourceRoot: mount.sourceRoot,
        });
      }
    }
  }

  for (const entry of manifest.externalDependencyPlan.entries) {
    const expectedScopes = expectedScopesByEntry.get(entry.id);
    if (expectedScopes === undefined) {
      throw new Error(
        `Compiled external dependency plan entry "${entry.id}" is not declared by any compiled owner.`,
      );
    }
    const actualScopes = new Set(entry.scopes.map(externalDependencyScopeKey));
    if (
      actualScopes.size !== expectedScopes.size ||
      [...expectedScopes].some((scope) => !actualScopes.has(scope))
    ) {
      throw new Error(
        `Compiled external dependency plan entry "${entry.id}" does not match its declared owner scopes.`,
      );
    }
    expectedScopesByEntry.delete(entry.id);
  }
  const missingEntry = expectedScopesByEntry.keys().next().value as string | undefined;
  if (missingEntry !== undefined) {
    throw new Error(
      `Compiled external dependency declaration "${missingEntry}" is missing its plan entry.`,
    );
  }

  assertCompiledBindingExternalDependencyScopes(manifest, entriesById);
}

function assertCompiledBindingExternalDependencyScopes(
  manifest: CompiledAgentManifest,
  entriesById: ReadonlyMap<
    string,
    CompiledAgentManifest["externalDependencyPlan"]["entries"][number]
  >,
): void {
  const nodesById = new Map(manifest.subagents.map((node) => [node.nodeId, node] as const));
  const childrenByParent = new Map<string, CompiledSubagentNode[]>();
  for (const edge of manifest.subagentEdges) {
    const child = nodesById.get(edge.childNodeId);
    if (child === undefined) continue;
    const children = childrenByParent.get(edge.parentNodeId) ?? [];
    children.push(child);
    childrenByParent.set(edge.parentNodeId, children);
  }

  const visit = (input: {
    readonly inheritedAuthority?: ExtensionDependencyAuthority;
    readonly inheritedDependencies: ReadonlySet<string>;
    readonly node?: CompiledSubagentNode;
    readonly nodeId: string;
    readonly resources: CompiledAgentNodeManifest | CompiledAgentResources;
  }): void => {
    const nodeDependencies = unionExternalDependencies(
      input.inheritedDependencies,
      configuredNodeExternalDependencies(input.resources, input.node),
    );
    // An extension-owned node may add config dependencies after its mount established
    // the inherited authority; those declarations belong to the same node authority.
    const inheritedAuthority =
      input.inheritedAuthority === undefined
        ? undefined
        : { ...input.inheritedAuthority, dependencies: nodeDependencies };
    const mountedAuthorities = input.resources.extensionMounts.map((mount) =>
      extensionMountDependencyAuthority(mount, nodeDependencies),
    );
    const authorities = [
      ...(inheritedAuthority === undefined ? [] : [inheritedAuthority]),
      ...mountedAuthorities,
    ];
    const mountDeclarations = new Set(
      input.resources.extensionMounts.map((mount) => mount.mountSourceId),
    );

    for (const [sourceId, binding] of Object.entries(input.resources.bindings)) {
      assertFilesystemDependencyClaims({
        allowedDependencies: allowedDependenciesForSource({
          // A mount cannot use its own dependency declaration to authorize the
          // module that creates that mount.
          authorities: mountDeclarations.has(sourceId)
            ? inheritedAuthority === undefined
              ? []
              : [inheritedAuthority]
            : authorities,
          binding,
          nodeDependencies,
          nodeId: input.nodeId,
          sourceId,
        }),
        backing: binding.backing,
        entriesById,
        nodeId: input.nodeId,
        sourceId,
      });
    }

    for (const remote of input.resources.remoteAgents) {
      const remoteDependencies = allowedDependenciesForSource({
        authorities,
        backing: remote.backing,
        nodeDependencies,
        nodeId: input.nodeId,
        owner: remote.owner,
        sourceId: remote.sourceId,
      });
      assertFilesystemDependencyClaims({
        allowedDependencies: remoteDependencies,
        backing: remote.backing,
        entriesById,
        nodeId: remote.nodeId,
        sourceId: remote.sourceId,
      });
      const remoteAuthority = extensionDependencyAuthorityForSource(
        remote.owner,
        remote.backing,
        remoteDependencies,
      );
      for (const [sourceId, binding] of Object.entries(remote.bindings)) {
        assertFilesystemDependencyClaims({
          allowedDependencies: allowedDependenciesForSource({
            authorities: remoteAuthority === undefined ? [] : [remoteAuthority],
            binding,
            nodeDependencies: remoteDependencies,
            nodeId: remote.nodeId,
            sourceId,
          }),
          backing: binding.backing,
          entriesById,
          nodeId: remote.nodeId,
          sourceId,
        });
      }
    }

    for (const child of childrenByParent.get(input.nodeId) ?? []) {
      const inheritedDependencies = allowedDependenciesForSource({
        authorities,
        backing: child.backing,
        nodeDependencies,
        nodeId: input.nodeId,
        owner: child.owner,
        sourceId: child.sourceId,
      });
      assertFilesystemDependencyClaims({
        allowedDependencies: inheritedDependencies,
        backing: child.backing,
        entriesById,
        nodeId: input.nodeId,
        sourceId: child.sourceId,
      });
      visit({
        inheritedAuthority: extensionDependencyAuthorityForSource(
          child.owner,
          child.backing,
          inheritedDependencies,
        ),
        inheritedDependencies,
        node: child,
        nodeId: child.nodeId,
        resources: child.agent,
      });
    }
  };

  visit({
    inheritedDependencies: new Set(),
    nodeId: "__root__",
    resources: manifest,
  });
}

function configuredNodeExternalDependencies(
  resources: CompiledAgentNodeManifest | CompiledAgentResources,
  node: CompiledSubagentNode | undefined,
): readonly string[] {
  if ("config" in resources) return resources.config.build?.externalDependencies ?? [];
  return node?.configResolver?.build?.externalDependencies ?? [];
}

function extensionMountDependencyAuthority(
  mount: CompiledExtensionMount,
  nodeDependencies: ReadonlySet<string>,
): ExtensionDependencyAuthority {
  return {
    dependencies: unionExternalDependencies(nodeDependencies, mount.externalDependencies),
    namespace: mount.namespace,
    packageName: mount.packageName,
    sourceRoot: mount.sourceRoot,
  };
}

function extensionDependencyAuthorityForSource(
  owner: AgentSourceOwner,
  backing: CompiledModuleBacking,
  dependencies: ReadonlySet<string>,
): ExtensionDependencyAuthority | undefined {
  if (owner.kind !== "extension" || backing.kind !== "filesystem") return undefined;
  const sourceRoot = backing.extensionScope?.sourceRoot;
  if (sourceRoot === undefined) return undefined;
  return {
    dependencies,
    namespace: owner.namespace,
    packageName: owner.packageName,
    sourceRoot,
  };
}

function allowedDependenciesForSource(input: {
  readonly authorities: readonly ExtensionDependencyAuthority[];
  readonly backing?: CompiledModuleBacking;
  readonly binding?: CompiledModuleBinding;
  readonly nodeDependencies: ReadonlySet<string>;
  readonly nodeId: string;
  readonly owner?: AgentSourceOwner;
  readonly sourceId: string;
}): ReadonlySet<string> {
  const backing = input.binding?.backing ?? input.backing;
  const owner = input.binding?.owner ?? input.owner;
  if (backing === undefined || owner === undefined || owner.kind !== "extension") {
    return input.nodeDependencies;
  }
  if (backing.kind !== "filesystem") return input.nodeDependencies;
  const authority = input.authorities.find(
    (candidate) =>
      candidate.namespace === owner.namespace &&
      candidate.packageName === owner.packageName &&
      candidate.sourceRoot === backing.extensionScope?.sourceRoot,
  );
  if (authority === undefined) {
    throw new Error(
      `Compiled node "${input.nodeId}" extension binding "${input.sourceId}" has no exact dependency authority.`,
    );
  }
  return authority.dependencies;
}

function assertFilesystemDependencyClaims(input: {
  readonly allowedDependencies: ReadonlySet<string>;
  readonly backing: CompiledModuleBacking;
  readonly entriesById: ReadonlyMap<
    string,
    CompiledAgentManifest["externalDependencyPlan"]["entries"][number]
  >;
  readonly nodeId: string;
  readonly sourceId: string;
}): void {
  if (input.backing.kind !== "filesystem") return;
  for (const dependencyId of externalDependencyPlanPackageNames(
    input.backing.externalDependencies,
  )) {
    if (!input.entriesById.has(dependencyId)) {
      throw new Error(
        `Compiled node "${input.nodeId}" binding "${input.sourceId}" references missing external dependency plan entry "${dependencyId}".`,
      );
    }
    if (!input.allowedDependencies.has(dependencyId)) {
      throw new Error(
        `Compiled node "${input.nodeId}" binding "${input.sourceId}" claims external dependency "${dependencyId}" outside its inherited, configured, or exact extension-mount scope.`,
      );
    }
  }
}

function unionExternalDependencies(
  ...groups: readonly (ReadonlySet<string> | readonly string[])[]
): ReadonlySet<string> {
  return new Set(groups.flatMap((group) => externalDependencyPlanPackageNames([...group])));
}

function addExpectedExternalDependencyScope(
  scopesByEntry: Map<string, Set<string>>,
  packageName: string,
  scope: CompiledExternalDependencyScope,
): void {
  const scopes = scopesByEntry.get(packageName) ?? new Set<string>();
  scopes.add(externalDependencyScopeKey(scope));
  scopesByEntry.set(packageName, scopes);
}

function externalDependencyScopeKey(scope: CompiledExternalDependencyScope): string {
  return scope.kind === "application"
    ? `application\0${scope.nodeId}\0${scope.sourceRoot}`
    : `extension\0${scope.nodeId}\0${scope.namespace}\0${scope.packageName}\0${scope.sourceRoot}`;
}
