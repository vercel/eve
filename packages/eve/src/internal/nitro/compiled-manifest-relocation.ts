import type {
  CompiledAgentManifest,
  CompiledAgentNodeManifest,
  CompiledAgentResources,
  CompiledSubagentNode,
} from "#compiler/manifest.js";
import type { CompiledModuleBacking, CompiledModuleBinding } from "#compiler/module-binding.js";
import type {
  AgentSourceComposition,
  AgentSourceDescriptor,
  CompiledSubagentSource,
} from "#compiler/source-composition.js";

export interface CompiledManifestPathRelocator {
  readonly appPath: (path: string) => string;
  readonly physicalPath: (path: string) => string;
}

/** Relocates only physical fields declared by the compiled manifest contract. */
export function relocateCompiledAgentManifest(
  manifest: CompiledAgentManifest,
  relocator: CompiledManifestPathRelocator,
): CompiledAgentManifest {
  const resources = relocateCompiledAgentResources(manifest, relocator);
  return {
    ...manifest,
    ...resources,
    externalDependencyPlan: {
      entries: manifest.externalDependencyPlan.entries.map((entry) => ({
        ...entry,
        packages: entry.packages.map((pkg) => ({
          ...pkg,
          resolvedPackageRoot: relocator.physicalPath(pkg.resolvedPackageRoot),
        })),
        scopes: entry.scopes.map((scope) => ({
          ...scope,
          sourceRoot: relocator.physicalPath(scope.sourceRoot),
        })),
      })),
    },
    subagents: manifest.subagents.map((subagent) =>
      relocateCompiledSubagentNode(subagent, relocator),
    ),
  };
}

function relocateCompiledSubagentNode(
  subagent: CompiledSubagentNode,
  relocator: CompiledManifestPathRelocator,
): CompiledSubagentNode {
  return {
    ...subagent,
    ...relocateCompiledSubagentSource(subagent, relocator),
    agent: relocateCompiledAgentResources(subagent.agent, relocator),
  } as CompiledSubagentNode;
}

function relocateCompiledAgentResources<
  Resources extends CompiledAgentManifest | CompiledAgentNodeManifest | CompiledAgentResources,
>(resources: Resources, relocator: CompiledManifestPathRelocator): Resources {
  return {
    ...resources,
    agentRoot: relocator.appPath(resources.agentRoot),
    appRoot: relocator.appPath(resources.appRoot),
    bindings: relocateCompiledModuleBindings(resources.bindings, relocator),
    channelRoutes: {
      ...resources.channelRoutes,
      shadowed: resources.channelRoutes.shadowed.map((record) => ({
        ...record,
        loser: {
          ...record.loser,
          binding: {
            ...record.loser.binding,
            backing: relocateCompiledModuleBacking(record.loser.binding.backing, relocator),
          },
        },
      })),
    },
    extensionMounts: resources.extensionMounts.map((mount) => ({
      ...mount,
      sourceRoot: relocator.physicalPath(mount.sourceRoot),
    })),
    remoteAgents: resources.remoteAgents.map((remoteAgent) => ({
      ...remoteAgent,
      ...relocateCompiledSubagentSource(remoteAgent, relocator),
      bindings: relocateCompiledModuleBindings(remoteAgent.bindings, relocator),
      sourceComposition: relocateSourceComposition(remoteAgent.sourceComposition, relocator),
    })),
    sandboxWorkspaces: resources.sandboxWorkspaces.map((workspace) => ({
      ...workspace,
      sourcePath: relocator.physicalPath(workspace.sourcePath),
    })),
    skills: resources.skills.map((skill) =>
      skill.sourceKind === "skill-package"
        ? {
            ...skill,
            ...(skill.assetsPath === undefined
              ? {}
              : { assetsPath: relocator.physicalPath(skill.assetsPath) }),
            ...(skill.referencesPath === undefined
              ? {}
              : { referencesPath: relocator.physicalPath(skill.referencesPath) }),
            rootPath: relocator.physicalPath(skill.rootPath),
            ...(skill.scriptsPath === undefined
              ? {}
              : { scriptsPath: relocator.physicalPath(skill.scriptsPath) }),
            skillFilePath: relocator.physicalPath(skill.skillFilePath),
          }
        : skill,
    ),
    sourceComposition: relocateSourceComposition(resources.sourceComposition, relocator),
  } as Resources;
}

function relocateCompiledModuleBindings(
  bindings: Readonly<Record<string, CompiledModuleBinding>>,
  relocator: CompiledManifestPathRelocator,
): Readonly<Record<string, CompiledModuleBinding>> {
  return Object.fromEntries(
    Object.entries(bindings).map(([sourceId, binding]) => [
      sourceId,
      { ...binding, backing: relocateCompiledModuleBacking(binding.backing, relocator) },
    ]),
  );
}

function relocateCompiledSubagentSource<Source extends CompiledSubagentSource>(
  source: Source,
  relocator: CompiledManifestPathRelocator,
): Source {
  return {
    ...source,
    backing: relocateCompiledModuleBacking(source.backing, relocator),
    entryPath: relocator.physicalPath(source.entryPath),
    rootPath: relocator.physicalPath(source.rootPath),
  };
}

function relocateSourceComposition(
  composition: AgentSourceComposition,
  relocator: CompiledManifestPathRelocator,
): AgentSourceComposition {
  return {
    disabled: composition.disabled.map((entry) => ({
      ...entry,
      source: relocateSourceDescriptor(entry.source, relocator),
    })),
    selected: composition.selected.map((entry) =>
      entry.sourceKind === "non-module"
        ? { ...entry, source: relocateSourceDescriptor(entry.source, relocator) }
        : entry,
    ),
    shadowed: composition.shadowed.map((entry) => ({
      ...entry,
      source: relocateSourceDescriptor(entry.source, relocator),
    })),
  };
}

function relocateSourceDescriptor<Descriptor extends AgentSourceDescriptor>(
  descriptor: Descriptor,
  relocator: CompiledManifestPathRelocator,
): Descriptor {
  if (!("backing" in descriptor)) return descriptor;
  return {
    ...descriptor,
    backing: relocateCompiledModuleBacking(descriptor.backing, relocator),
  };
}

function relocateCompiledModuleBacking(
  backing: CompiledModuleBacking,
  relocator: CompiledManifestPathRelocator,
): CompiledModuleBacking {
  if (backing.kind === "programmatic") return backing;
  return {
    ...backing,
    ...(backing.extensionScope === undefined
      ? {}
      : {
          extensionScope: {
            ...backing.extensionScope,
            sourceRoot: relocator.physicalPath(backing.extensionScope.sourceRoot),
          },
        }),
    sourcePath: relocator.physicalPath(backing.sourcePath),
  };
}
