import { extname, resolve } from "node:path";

import type { AgentModuleCandidate, AgentSourceLayer } from "#compiler/agent-module-candidate.js";
import type { AgentSourceRegistry } from "#compiler/agent-source-registry.js";
import {
  composeAgentModuleCandidates,
  type AgentModuleComposition,
} from "#compiler/compose-agent-module-candidates.js";
import type {
  AgentSourceOwner,
  CompiledModuleBacking,
  CompiledModuleBinding,
} from "#compiler/module-binding.js";
import { createProgrammaticModuleCandidates } from "#compiler/programmatic-module-candidates.js";
import { packageStateNamespace } from "#discover/extensions.js";
import { stripLogicalPathExtension } from "#discover/filesystem.js";
import type {
  AgentSourceManifest,
  ConnectionSourceRef,
  InstructionsSourceRef,
  LocalSubagentSourceRef,
  ResolvedExtensionMount,
  ScheduleSourceRef,
  SkillSourceRef,
} from "#discover/manifest.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";

type ComposableSourceRef =
  | ConnectionSourceRef
  | InstructionsSourceRef
  | ModuleSourceRef
  | ScheduleSourceRef
  | SkillSourceRef;

type ComposableSlot =
  | "channels"
  | "connections"
  | "hooks"
  | "instructions"
  | "sandbox"
  | "schedules"
  | "skills"
  | "tools";

export interface AgentSourceOrigin {
  readonly backing: Omit<Extract<CompiledModuleBacking, { kind: "filesystem" }>, "sourcePath">;
  readonly layer: Exclude<AgentSourceLayer, "framework-default">;
  readonly owner: AgentSourceOwner;
  readonly sourceIdPrefix?: string;
}

interface SourceCandidate {
  readonly candidate: AgentModuleCandidate;
  readonly slot: ComposableSlot;
  readonly source: ComposableSourceRef;
}

export interface ComposedAgentSources {
  readonly bindings: Readonly<Record<string, CompiledModuleBinding>>;
  readonly composition: AgentModuleComposition;
  readonly manifest: AgentSourceManifest;
}

const projectedSubagentOrigins = new WeakMap<LocalSubagentSourceRef, AgentSourceOrigin>();

/**
 * Selects one effective source for every canonical slot before any authored
 * definition executes. Extension sources are projected to their final
 * consumer-visible paths here, while their bindings retain the physical file.
 */
export function composeAgentSources(input: {
  readonly externalDependencies?: readonly string[];
  readonly isRoot: boolean;
  readonly manifest: AgentSourceManifest;
  readonly nodeId: string;
  readonly origin?: AgentSourceOrigin;
  readonly registry: AgentSourceRegistry;
}): ComposedAgentSources {
  const applicationOrigin =
    input.origin ??
    ({
      backing: {
        externalDependencies: [...(input.externalDependencies ?? [])],
        kind: "filesystem",
      },
      layer: "application",
      owner: { kind: "application" },
    } satisfies AgentSourceOrigin);
  const candidates = [
    ...createManifestCandidates({
      manifest: input.manifest,
      nodeId: input.nodeId,
      origin: applicationOrigin,
    }),
    ...input.manifest.resolvedExtensions.flatMap((mount) =>
      createExtensionCandidates(
        input.nodeId,
        mount,
        input.externalDependencies ?? mount.externalDependencies,
      ),
    ),
    ...createFrameworkCandidates(input),
  ];
  const composition = composeAgentModuleCandidates(candidates.map(({ candidate }) => candidate));
  const sourcesBySourceId = new Map(
    candidates.map(({ candidate, slot, source }) => [candidate.sourceId, { slot, source }]),
  );
  const bindings: Record<string, CompiledModuleBinding> = {};
  const selected = createEmptySelectedSources();

  for (const winner of composition.winners) {
    const entry = sourcesBySourceId.get(winner.sourceId);
    if (entry === undefined) {
      throw new Error(`Missing source metadata for candidate "${winner.sourceId}".`);
    }
    selected[entry.slot].push(entry.source as never);
    if (entry.source.sourceKind === "module" && winner.layer !== "application") {
      bindings[winner.sourceId] = {
        backing: winner.backing,
        logicalPath: winner.logicalPath,
        owner: winner.owner,
      };
    }
  }

  const subagents = composeSubagentSources(input.manifest, input.nodeId, applicationOrigin);
  Object.assign(bindings, subagents.bindings);

  return {
    bindings,
    composition,
    manifest: {
      ...input.manifest,
      channels: selected.channels,
      connections: selected.connections,
      hooks: selected.hooks,
      instructions: selected.instructions,
      sandbox: selected.sandbox[0] ?? null,
      schedules: selected.schedules,
      skills: selected.skills,
      subagents: subagents.sources,
      tools: selected.tools,
    },
  };
}

export function getSubagentSourceOrigin(
  source: LocalSubagentSourceRef,
): AgentSourceOrigin | undefined {
  return projectedSubagentOrigins.get(source);
}

function createFrameworkCandidates(input: {
  readonly isRoot: boolean;
  readonly nodeId: string;
  readonly registry: AgentSourceRegistry;
}): SourceCandidate[] {
  return createProgrammaticModuleCandidates(input).map((candidate) => {
    const slot = classifyComposablePath(candidate.logicalPath);
    return {
      candidate,
      slot,
      source: createProgrammaticSourceRef(input.registry, candidate),
    };
  });
}

function createExtensionCandidates(
  nodeId: string,
  mount: ResolvedExtensionMount,
  externalDependencies: readonly string[],
): SourceCandidate[] {
  const extensionScope = {
    namespace: packageStateNamespace(mount.packageName),
    sourceRoot: mount.sourceRoot,
  };
  const packageCandidates = createManifestCandidates({
    manifest: mount.manifest,
    namespace: mount.namespace,
    nodeId,
    origin: {
      backing: {
        externalDependencies: [...externalDependencies],
        extensionScope,
        kind: "filesystem",
      },
      layer: "extension-package",
      owner: {
        kind: "extension",
        namespace: mount.namespace,
        packageName: mount.packageName,
      },
      sourceIdPrefix: `ext:${mount.namespace}`,
    },
  });
  if (mount.overrides === undefined) return packageCandidates;

  return [
    ...packageCandidates,
    ...createManifestCandidates({
      manifest: mount.overrides,
      namespace: mount.namespace,
      nodeId,
      origin: {
        backing: {
          externalDependencies: [...externalDependencies],
          kind: "filesystem",
        },
        layer: "extension-override",
        owner: { kind: "application" },
        sourceIdPrefix: `ext-override:${mount.namespace}`,
      },
    }),
  ];
}

function createManifestCandidates(input: {
  readonly manifest: AgentSourceManifest;
  readonly namespace?: string;
  readonly nodeId: string;
  readonly origin: AgentSourceOrigin;
}): SourceCandidate[] {
  const sources: ReadonlyArray<readonly [ComposableSlot, ComposableSourceRef]> = [
    ...input.manifest.channels.map((source) => ["channels", source] as const),
    ...input.manifest.connections.map((source) => ["connections", source] as const),
    ...input.manifest.hooks.map((source) => ["hooks", source] as const),
    ...input.manifest.instructions.map((source) => ["instructions", source] as const),
    ...(input.manifest.sandbox === null ? [] : [["sandbox", input.manifest.sandbox] as const]),
    ...input.manifest.schedules.map((source) => ["schedules", source] as const),
    ...input.manifest.skills.map((source) => ["skills", source] as const),
    ...input.manifest.tools.map((source) => ["tools", source] as const),
  ];

  return sources.map(([slot, original]) => {
    const logicalPath =
      input.namespace === undefined
        ? original.logicalPath
        : projectExtensionLogicalPath(original.logicalPath, slot, input.namespace);
    const sourceId =
      input.origin.sourceIdPrefix === undefined
        ? original.sourceId
        : `${input.origin.sourceIdPrefix}:${original.sourceId}`;
    const source = projectSourceRef(original, slot, logicalPath, sourceId);
    const sourcePath = physicalSourcePath(input.manifest, original);
    return {
      candidate: {
        backing: { ...input.origin.backing, sourcePath },
        layer: input.origin.layer,
        logicalPath,
        nodeId: input.nodeId,
        owner: input.origin.owner,
        sourceId,
      },
      slot,
      source,
    };
  });
}

function composeSubagentSources(
  manifest: AgentSourceManifest,
  nodeId: string,
  applicationOrigin: AgentSourceOrigin,
): {
  readonly bindings: Readonly<Record<string, CompiledModuleBinding>>;
  readonly sources: LocalSubagentSourceRef[];
} {
  const candidates: Array<{
    readonly candidate: AgentModuleCandidate;
    readonly source: LocalSubagentSourceRef;
  }> = manifest.subagents.map((source) => {
    if (applicationOrigin.layer !== "application") {
      projectedSubagentOrigins.set(source, applicationOrigin);
    }
    return {
      candidate: createSubagentCandidate(nodeId, source, applicationOrigin),
      source,
    };
  });

  for (const mount of manifest.resolvedExtensions) {
    const externalDependencies = [
      ...new Set([
        ...applicationOrigin.backing.externalDependencies,
        ...mount.externalDependencies,
      ]),
    ];
    const packageOrigin: AgentSourceOrigin = {
      backing: {
        externalDependencies,
        extensionScope: {
          namespace: packageStateNamespace(mount.packageName),
          sourceRoot: mount.sourceRoot,
        },
        kind: "filesystem",
      },
      layer: "extension-package",
      owner: {
        kind: "extension",
        namespace: mount.namespace,
        packageName: mount.packageName,
      },
      sourceIdPrefix: `ext:${mount.namespace}`,
    };
    candidates.push(
      ...mount.manifest.subagents.map((source) => {
        const projected = projectRootExtensionSubagent(source, mount.namespace, packageOrigin);
        return {
          candidate: createSubagentCandidate(nodeId, projected, packageOrigin),
          source: projected,
        };
      }),
    );

    if (mount.overrides !== undefined) {
      const overrideOrigin: AgentSourceOrigin = {
        backing: {
          externalDependencies,
          kind: "filesystem",
        },
        layer: "extension-override",
        owner: { kind: "application" },
        sourceIdPrefix: `ext-override:${mount.namespace}`,
      };
      candidates.push(
        ...mount.overrides.subagents.map((source) => {
          const projected = projectRootExtensionSubagent(source, mount.namespace, overrideOrigin);
          return {
            candidate: createSubagentCandidate(nodeId, projected, overrideOrigin),
            source: projected,
          };
        }),
      );
    }
  }

  const composition = composeAgentModuleCandidates(candidates.map(({ candidate }) => candidate));
  const sourcesById = new Map(
    candidates.map(({ candidate, source }) => [candidate.sourceId, source]),
  );
  const bindings: Record<string, CompiledModuleBinding> = {};
  for (const winner of composition.winners) {
    if (winner.layer === "application") continue;
    bindings[winner.sourceId] = {
      backing: winner.backing,
      logicalPath: winner.logicalPath,
      owner: winner.owner,
    };
  }
  return {
    bindings,
    sources: composition.winners.map((winner) => sourcesById.get(winner.sourceId)!),
  };
}

function createSubagentCandidate(
  nodeId: string,
  source: LocalSubagentSourceRef,
  origin: AgentSourceOrigin,
): AgentModuleCandidate {
  return {
    backing: { ...origin.backing, sourcePath: source.entryPath },
    layer: origin.layer,
    logicalPath: source.logicalPath,
    nodeId,
    owner: origin.owner,
    sourceId: source.sourceId,
  };
}

function projectRootExtensionSubagent(
  source: LocalSubagentSourceRef,
  namespace: string,
  origin: AgentSourceOrigin,
): LocalSubagentSourceRef {
  const projected = scopeSubagentSourceIds(
    {
      ...source,
      logicalPath: projectExtensionLogicalPath(source.logicalPath, "subagents", namespace),
      subagentId: `${namespace}__${source.subagentId}`,
    },
    origin,
  );
  return projected;
}

function scopeSubagentSourceIds(
  source: LocalSubagentSourceRef,
  origin: AgentSourceOrigin,
): LocalSubagentSourceRef {
  const prefix = origin.sourceIdPrefix;
  if (prefix === undefined) return source;
  const projected: LocalSubagentSourceRef = {
    ...source,
    manifest: { ...source.manifest },
    sourceId: `${prefix}:${source.sourceId}`,
  };
  projectedSubagentOrigins.set(projected, origin);
  for (const child of projected.manifest.subagents) {
    projectedSubagentOrigins.set(child, origin);
  }
  return projected;
}

function projectSourceRef<T extends ComposableSourceRef>(
  source: T,
  slot: ComposableSlot,
  logicalPath: string,
  sourceId: string,
): T {
  const projected = { ...source, logicalPath, sourceId };
  if (slot === "connections") {
    return {
      ...projected,
      connectionName: connectionNameFromLogicalPath(logicalPath),
    } as T;
  }
  if (slot === "skills" && source.sourceKind === "skill-package") {
    return {
      ...projected,
      name: stripLogicalPathExtension(logicalPath)
        .replace(/^skills\//, "")
        .replace(/\/SKILL$/i, ""),
    } as T;
  }
  return projected as T;
}

function projectExtensionLogicalPath(
  logicalPath: string,
  slot: ComposableSlot | "subagents",
  namespace: string,
): string {
  const prefix = `${slot}/`;
  if (logicalPath.startsWith(prefix)) {
    const relativePath = logicalPath.slice(prefix.length);
    const separator = relativePath.indexOf("/");
    const firstSegment = separator === -1 ? relativePath : relativePath.slice(0, separator);
    const rest = separator === -1 ? "" : relativePath.slice(separator);
    return `${prefix}${namespace}__${firstSegment}${rest}`;
  }

  if (slot === "instructions") {
    const extension = extname(logicalPath);
    const name = logicalPath.slice(0, extension.length === 0 ? undefined : -extension.length);
    return `instructions/${namespace}__${name}${extension}`;
  }

  throw new Error(`Cannot project extension ${slot} source "${logicalPath}".`);
}

function physicalSourcePath(manifest: AgentSourceManifest, source: ComposableSourceRef): string {
  if (source.sourceKind === "skill-package") return source.skillFilePath;
  return resolve(manifest.agentRoot, source.logicalPath);
}

function connectionNameFromLogicalPath(logicalPath: string): string {
  const relativePath = stripLogicalPathExtension(logicalPath).replace(/^connections\//, "");
  return relativePath.endsWith("/connection")
    ? relativePath.slice(0, -"/connection".length)
    : relativePath;
}

function classifyComposablePath(logicalPath: string): ComposableSlot {
  if (logicalPath === "sandbox.ts" || logicalPath.startsWith("sandbox/")) return "sandbox";
  const slot = logicalPath.split("/", 1)[0];
  if (
    slot === "channels" ||
    slot === "connections" ||
    slot === "hooks" ||
    slot === "instructions" ||
    slot === "schedules" ||
    slot === "skills" ||
    slot === "tools"
  ) {
    return slot;
  }
  throw new Error(`Programmatic source "${logicalPath}" does not select a composable slot.`);
}

function createProgrammaticSourceRef(
  registry: AgentSourceRegistry,
  candidate: AgentModuleCandidate,
): ModuleSourceRef {
  if (candidate.backing.kind !== "programmatic") {
    throw new Error(`Expected "${candidate.sourceId}" to have a programmatic backing.`);
  }
  const module = registry.getModule(candidate.backing);
  return {
    exportName: module.exportName,
    logicalPath: candidate.logicalPath,
    sourceId: candidate.sourceId,
    sourceKind: "module",
  };
}

function createEmptySelectedSources(): {
  channels: ModuleSourceRef[];
  connections: ConnectionSourceRef[];
  hooks: ModuleSourceRef[];
  instructions: InstructionsSourceRef[];
  sandbox: ModuleSourceRef[];
  schedules: ScheduleSourceRef[];
  skills: SkillSourceRef[];
  tools: ModuleSourceRef[];
} {
  return {
    channels: [],
    connections: [],
    hooks: [],
    instructions: [],
    sandbox: [],
    schedules: [],
    skills: [],
    tools: [],
  };
}
