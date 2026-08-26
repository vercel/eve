import { join } from "node:path";

import type {
  AgentSourceManifest,
  ConnectionSourceRef,
  InstructionsSourceRef,
  LocalSubagentSourceRef,
  ResolvedExtensionMount,
  ScheduleSourceRef,
  SkillSourceRef,
} from "#discover/manifest.js";
import { stripLogicalPathExtension } from "#discover/filesystem.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import type {
  AgentModuleCandidate,
  AgentResourceCandidate,
  AgentSourceCandidate,
  AgentSourceLayer,
  AgentSourceOwner,
} from "#compiler/source-graph.js";
import { canonicalSourceSlot } from "#compiler/source-graph.js";

export type ProjectedModuleSource =
  | {
      readonly candidate: AgentModuleCandidate;
      readonly kind: "connection";
      readonly source: ConnectionSourceRef;
    }
  | {
      readonly candidate: AgentModuleCandidate;
      readonly kind:
        | "channel"
        | "config"
        | "extension"
        | "hook"
        | "instructions"
        | "instrumentation"
        | "memory"
        | "sandbox"
        | "schedule"
        | "skill"
        | "tool";
      readonly source: ModuleSourceRef;
    };

export type ProjectedResourceSource =
  | {
      readonly candidate: AgentResourceCandidate;
      readonly kind: "instructions";
      readonly source: InstructionsSourceRef;
    }
  | {
      readonly candidate: AgentResourceCandidate;
      readonly kind: "schedule";
      readonly source: ScheduleSourceRef;
    }
  | {
      readonly candidate: AgentResourceCandidate;
      readonly kind: "skill";
      readonly source: SkillSourceRef;
    };

export type ProjectedSource = ProjectedModuleSource | ProjectedResourceSource;

const MODULE_KIND_BY_SLOT_ROOT: Partial<
  Record<string, Exclude<ProjectedModuleSource["kind"], "connection">>
> = {
  agent: "config",
  channels: "channel",
  extensions: "extension",
  hooks: "hook",
  instructions: "instructions",
  instrumentation: "instrumentation",
  memory: "memory",
  sandbox: "sandbox",
  schedules: "schedule",
  skills: "skill",
  tools: "tool",
};

export interface ProjectedSubagentSource {
  readonly candidate: AgentResourceCandidate;
  readonly extensionScope?: { readonly namespace: string; readonly sourceRoot: string };
  readonly owner: AgentSourceOwner;
  readonly source: LocalSubagentSourceRef;
}

export interface ProjectedAgentSources {
  readonly candidates: readonly AgentSourceCandidate[];
  readonly resources: readonly ProjectedResourceSource[];
  readonly subagents: readonly ProjectedSubagentSource[];
}

export function projectAgentSources(input: {
  readonly externalDependencies: readonly string[];
  readonly extensionScope?: { readonly namespace: string; readonly sourceRoot: string };
  readonly layer?: AgentSourceLayer;
  readonly manifest: AgentSourceManifest;
  readonly nodeId: string;
  readonly owner?: AgentSourceOwner;
}): ProjectedAgentSources {
  const owner = input.owner ?? { kind: "application" as const };
  const candidates: AgentSourceCandidate[] = [];
  const resources: ProjectedResourceSource[] = [];
  const subagents: ProjectedSubagentSource[] = [];

  projectManifest({
    externalDependencies: input.externalDependencies,
    candidates,
    projection: createApplicationManifestSourceProjection(input.extensionScope),
    layer: input.layer ?? "application",
    manifest: input.manifest,
    nodeId: input.nodeId,
    owner,
    resources,
    subagents,
  });

  for (const mount of [...input.manifest.resolvedExtensions].sort((left, right) =>
    left.namespace.localeCompare(right.namespace),
  )) {
    const projection = createExtensionManifestSourceProjection(mount);
    const extensionOwner: AgentSourceOwner = {
      kind: "extension",
      namespace: mount.namespace,
      packageName: mount.packageName,
    };
    projectManifest({
      externalDependencies: mergeDependencies(
        input.externalDependencies,
        mount.externalDependencies,
      ),
      candidates,
      projection,
      layer: "extension-package",
      manifest: mount.manifest,
      nodeId: input.nodeId,
      owner: extensionOwner,
      resources,
      sourceIdPrefix: `ext:${mount.namespace}:`,
      subagents,
    });
    if (mount.overrides !== undefined) {
      projectManifest({
        externalDependencies: input.externalDependencies,
        candidates,
        projection,
        layer: "extension-override",
        manifest: mount.overrides,
        nodeId: input.nodeId,
        owner: { kind: "application" },
        resources,
        sourceIdPrefix: `ext-override:${mount.namespace}:`,
        subagents,
      });
    }
  }

  return { candidates, resources, subagents };
}

export function projectSelectedSources(input: {
  readonly candidates: Iterable<AgentSourceCandidate>;
  readonly resources: readonly ProjectedResourceSource[];
}): readonly ProjectedSource[] {
  const resourcesBySourceId = new Map(
    input.resources.map((entry) => [entry.candidate.sourceId, entry]),
  );
  const projected: ProjectedSource[] = [];
  for (const candidate of input.candidates) {
    if (!isModuleCandidate(candidate)) {
      const resource = resourcesBySourceId.get(candidate.sourceId);
      if (resource !== undefined) projected.push(resource);
    } else {
      projected.push(projectModuleCandidate(candidate));
    }
  }
  return projected;
}

export function createFilesystemModuleCandidate(input: {
  readonly externalDependencies: readonly string[];
  readonly extensionScope?: { readonly namespace: string; readonly sourceRoot: string };
  readonly layer: AgentSourceLayer;
  readonly logicalPath: string;
  readonly nodeId: string;
  readonly owner: AgentSourceOwner;
  readonly source: ModuleSourceRef;
  readonly sourceId?: string;
  readonly sourceRoot: string;
}): AgentModuleCandidate {
  const backing = {
    externalDependencies: [...input.externalDependencies],
    ...(input.owner.kind === "extension" && input.extensionScope !== undefined
      ? { extensionScope: input.extensionScope }
      : {}),
    kind: "filesystem" as const,
    sourcePath: join(input.sourceRoot, input.source.logicalPath),
  };
  return {
    backing,
    exportName: input.source.exportName,
    form: "direct",
    layer: input.layer,
    logicalPath: input.logicalPath,
    nodeId: input.nodeId,
    owner: input.owner,
    sourceId: input.sourceId ?? input.source.sourceId,
  };
}

interface ManifestSourceProjection {
  readonly extensionScope?: { readonly namespace: string; readonly sourceRoot: string };
  readonly logicalPath: (logicalPath: string) => string;
  readonly name: (name: string) => string;
}

function createApplicationManifestSourceProjection(extensionScope?: {
  readonly namespace: string;
  readonly sourceRoot: string;
}): ManifestSourceProjection {
  const projection: {
    extensionScope?: { readonly namespace: string; readonly sourceRoot: string };
    logicalPath: (logicalPath: string) => string;
    name: (name: string) => string;
  } = {
    logicalPath: (logicalPath) => logicalPath,
    name: (name) => name,
  };
  if (extensionScope !== undefined) {
    projection.extensionScope = extensionScope;
  }
  return projection;
}

function createExtensionManifestSourceProjection(
  extension: ResolvedExtensionMount,
): ManifestSourceProjection {
  const { namespace, sourceRoot } = extension;
  return {
    extensionScope: { namespace, sourceRoot },
    logicalPath: (logicalPath) => qualifyExtensionContributionLogicalPath(logicalPath, namespace),
    name: (name) => `${namespace}__${name}`,
  };
}

function projectManifest(input: {
  readonly candidates: AgentSourceCandidate[];
  readonly externalDependencies: readonly string[];
  readonly projection: ManifestSourceProjection;
  readonly layer: AgentSourceLayer;
  readonly manifest: AgentSourceManifest;
  readonly nodeId: string;
  readonly owner: AgentSourceOwner;
  readonly resources: ProjectedResourceSource[];
  readonly sourceIdPrefix?: string;
  readonly subagents: ProjectedSubagentSource[];
}): void {
  const { projection } = input;
  const sourceId = (id: string) => `${input.sourceIdPrefix ?? ""}${id}`;
  const pushModule = (source: ModuleSourceRef, logicalPathOverride?: string) => {
    const logicalPath = projection.logicalPath(logicalPathOverride ?? source.logicalPath);
    const candidate = createFilesystemModuleCandidate({
      externalDependencies: input.externalDependencies,
      ...(projection.extensionScope === undefined
        ? {}
        : { extensionScope: projection.extensionScope }),
      layer: input.layer,
      logicalPath,
      nodeId: input.nodeId,
      owner: input.owner,
      source,
      sourceId: sourceId(source.sourceId),
      sourceRoot: input.manifest.agentRoot,
    });
    input.candidates.push(candidate);
  };
  const pushResource = (
    kind: ProjectedResourceSource["kind"],
    source: InstructionsSourceRef | ScheduleSourceRef | SkillSourceRef,
  ) => {
    const logicalPath = projection.logicalPath(source.logicalPath);
    const projected = {
      ...source,
      ...(source.sourceKind === "skill-package"
        ? {
            name: projection.name(source.name),
          }
        : {}),
      logicalPath,
      sourceId: sourceId(source.sourceId),
    };
    const candidate: AgentResourceCandidate = {
      backing: {
        kind: "resource",
        sourcePath:
          source.sourceKind === "skill-package"
            ? source.skillFilePath
            : join(input.manifest.agentRoot, source.logicalPath),
      },
      form: "direct",
      layer: input.layer,
      logicalPath,
      nodeId: input.nodeId,
      owner: input.owner,
      sourceId: projected.sourceId,
    };
    input.candidates.push(candidate);
    input.resources.push({
      candidate,
      kind,
      source: projected,
    } as ProjectedResourceSource);
  };

  if (input.manifest.configModule !== undefined) {
    const logicalPath = input.manifest.configModule.logicalPath;
    pushModule(
      input.manifest.configModule,
      canonicalSourceSlot(logicalPath) === "agent" ? undefined : "agent.ts",
    );
  }
  if (input.manifest.instrumentation !== undefined) {
    pushModule(input.manifest.instrumentation);
  }
  for (const source of input.manifest.extensions) pushModule(source);
  for (const source of input.manifest.channels) pushModule(source);
  for (const source of input.manifest.connections) pushModule(source);
  for (const source of input.manifest.hooks) pushModule(source);
  for (const source of input.manifest.memories) pushModule(source);
  if (input.manifest.sandbox !== null) pushModule(input.manifest.sandbox);
  for (const source of input.manifest.tools) pushModule(source);
  for (const source of input.manifest.instructions) {
    if (source.sourceKind === "module") pushModule(source);
    else pushResource("instructions", source);
  }
  for (const source of input.manifest.schedules) {
    if (source.sourceKind === "module") pushModule(source);
    else pushResource("schedule", source);
  }
  for (const source of input.manifest.skills) {
    if (source.sourceKind === "module") pushModule(source);
    else pushResource("skill", source);
  }
  for (const source of input.manifest.subagents) {
    const name = projection.name(source.subagentId);
    const logicalPath = projection.logicalPath(source.logicalPath);
    const projectedSource = {
      ...source,
      logicalPath,
      sourceId: sourceId(source.sourceId),
      subagentId: name,
    };
    const candidate: AgentResourceCandidate = {
      backing: { kind: "resource", sourcePath: source.entryPath },
      form: "direct",
      layer: input.layer,
      logicalPath,
      nodeId: input.nodeId,
      owner: input.owner,
      sourceId: projectedSource.sourceId,
    };
    input.candidates.push(candidate);
    input.subagents.push({
      candidate,
      ...(projection.extensionScope === undefined
        ? {}
        : { extensionScope: projection.extensionScope }),
      owner: input.owner,
      source: projectedSource,
    });
  }
}

function projectModuleCandidate(candidate: AgentModuleCandidate): ProjectedModuleSource {
  const source: ModuleSourceRef = {
    exportName: candidate.exportName,
    logicalPath: candidate.logicalPath,
    sourceId: candidate.sourceId,
    sourceKind: "module",
  };
  const slot = canonicalSourceSlot(candidate.logicalPath);
  if (slot.startsWith("connections/")) {
    return {
      candidate,
      kind: "connection",
      source: { ...source, connectionName: deriveConnectionName(candidate.logicalPath) },
    };
  }
  const kind = MODULE_KIND_BY_SLOT_ROOT[slot.split("/", 1)[0]!];
  if (kind === undefined) {
    throw new Error(`Agent module source slot "${candidate.logicalPath}" is not compiled yet.`);
  }
  return { candidate, kind, source };
}

function isModuleCandidate(candidate: AgentSourceCandidate): candidate is AgentModuleCandidate {
  return candidate.backing.kind !== "resource";
}

const EXTENSION_CONTRIBUTION_ROOTS = new Set([
  "channels",
  "connections",
  "hooks",
  "instructions",
  "schedules",
  "skills",
  "subagents",
  "tools",
]);

export function qualifyExtensionContributionLogicalPath(
  logicalPath: string,
  namespace: string,
): string {
  const parts = logicalPath.split("/");
  if (parts.length === 1) {
    const slot = stripLogicalPathExtension(logicalPath);
    if (slot === "instructions" || slot === "system") {
      return `instructions/${namespace}${logicalPath.slice(logicalPath.lastIndexOf("."))}`;
    }
    throw new Error(`Extension source slot "${logicalPath}" cannot be namespace-scoped.`);
  }

  const root = parts[0]!;
  if (!EXTENSION_CONTRIBUTION_ROOTS.has(root)) {
    throw new Error(`Extension source slot "${logicalPath}" cannot be namespace-scoped.`);
  }
  parts[1] = `${namespace}__${parts[1]}`;
  return parts.join("/");
}

function deriveConnectionName(logicalPath: string): string {
  const stripped = stripLogicalPathExtension(logicalPath).replace(/^connections\//, "");
  return stripped.endsWith("/connection") ? stripped.slice(0, -"/connection".length) : stripped;
}

function mergeDependencies(...lists: readonly (readonly string[])[]): readonly string[] {
  return [...new Set(lists.flat())];
}
