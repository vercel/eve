import { basename, relative, resolve } from "node:path";
import type { JsonObject } from "#shared/json.js";
import type {
  MarkdownSourceRef,
  ModuleSourceRef,
  SkillPackageSourceRef,
} from "#shared/source-ref.js";
import type { NamedSkillDefinition } from "#shared/skill-definition.js";
import type { ScheduleDefinition } from "#public/definitions/schedule.js";
import type { SkillDefinition } from "#public/definitions/skill.js";
import type { InstructionsDefinition } from "#public/definitions/instructions.js";
import type { DiscoverDiagnostic, DiscoverDiagnosticsSummary } from "#discover/diagnostics.js";
import { summarizeDiscoverDiagnostics } from "#discover/diagnostics.js";
import { normalizeLogicalPath } from "#discover/filesystem.js";

export const AGENT_SOURCE_MANIFEST_KIND = "eve-agent-discovery-manifest";

export const AGENT_SOURCE_MANIFEST_VERSION = 16;

export interface ConnectionSourceRef extends ModuleSourceRef {
  readonly connectionName: string;
}

export type InstructionsSourceRef = MarkdownSourceRef<InstructionsDefinition> | ModuleSourceRef;

export type SkillSourceRef =
  | MarkdownSourceRef<SkillDefinition>
  | ModuleSourceRef
  | (NamedSkillDefinition & SkillPackageSourceRef);

export interface MemorySourceRef extends ModuleSourceRef {
  readonly slot: string;
}

export type AgentSourceRef = InstructionsSourceRef | ScheduleSourceRef | SkillSourceRef;

export type AgentSourceKind = keyof AgentSourceRefs;

interface AgentSourceRefs {
  readonly channel: ModuleSourceRef;
  readonly connection: ConnectionSourceRef;
  readonly hook: ModuleSourceRef;
  readonly instructions: InstructionsSourceRef;
  readonly memory: MemorySourceRef;
  readonly sandbox: ModuleSourceRef;
  readonly schedule: ScheduleSourceRef;
  readonly skill: SkillSourceRef;
  readonly tool: ModuleSourceRef;
}

const SOURCE_KIND_BY_SLOT_ROOT: Readonly<Record<string, AgentSourceKind>> = {
  channels: "channel",
  connections: "connection",
  hooks: "hook",
  instructions: "instructions",
  memory: "memory",
  sandbox: "sandbox",
  schedules: "schedule",
  skills: "skill",
  system: "instructions",
  tools: "tool",
};

export function sourceKindOf(logicalPath: string): AgentSourceKind | undefined {
  const root = logicalPath.split("/", 1)[0]!;
  return SOURCE_KIND_BY_SLOT_ROOT[root.includes(".") ? root.slice(0, root.indexOf(".")) : root];
}

export function sourcesOf<K extends AgentSourceKind>(
  manifest: Pick<AgentSourceManifest, "sources">,
  kind: K,
): readonly AgentSourceRefs[K][] {
  return manifest.sources.filter(
    (source): source is AgentSourceRefs[K] => sourceKindOf(source.logicalPath) === kind,
  );
}

export interface LocalSubagentSourceRef {
  entryPath: string;
  logicalPath: string;
  manifest: AgentSourceManifest;
  rootPath: string;
  sourceId: string;
  subagentId: string;
}

export type ScheduleSourceRef = MarkdownSourceRef<ScheduleDefinition> | ModuleSourceRef;

export interface SandboxWorkspaceFolderSourceRef {
  readonly logicalPath: string;
  readonly rootEntries: readonly string[];
  readonly sourceId: string;
  readonly sourcePath: string;
}

export type LibSourceRef = ModuleSourceRef;

export type ExtensionSourceRef = ModuleSourceRef;

export interface ResolvedExtensionMount {
  readonly programmaticDeclaration?: {
    readonly logicalPath: string;
    readonly sourceId: string;
    readonly importSpecifier: string;
    readonly entryPath: string;
    readonly config: JsonObject;
  };
  readonly namespace: string;
  readonly specifier: string;
  readonly packageName: string;
  readonly packageRoot: string;
  readonly sourceRoot: string;
  readonly manifest: AgentSourceManifest;
  readonly externalDependencies: readonly string[];
  readonly overrides?: AgentSourceManifest;
}

export type SubagentSourceRef = LocalSubagentSourceRef;

interface CreateConnectionSourceRefInput extends CreateModuleSourceRefInput {
  connectionName: string;
}

export interface AgentSourceManifest {
  agentId: string;
  agentRoot: string;
  appRoot: string;
  configModule?: ModuleSourceRef;
  diagnosticsSummary: DiscoverDiagnosticsSummary;
  extensions: ExtensionSourceRef[];
  resolvedExtensions: ResolvedExtensionMount[];
  lib: LibSourceRef[];
  kind: typeof AGENT_SOURCE_MANIFEST_KIND;
  sources: AgentSourceRef[];
  sandboxWorkspaces: SandboxWorkspaceFolderSourceRef[];
  version: typeof AGENT_SOURCE_MANIFEST_VERSION;
  subagents: SubagentSourceRef[];
}

export interface CreateAgentSourceManifestInput {
  agentId?: string;
  agentRoot: string;
  appRoot: string;
  configModule?: ModuleSourceRef;
  diagnostics?: readonly DiscoverDiagnostic[];
  extensions?: readonly ExtensionSourceRef[];
  resolvedExtensions?: readonly ResolvedExtensionMount[];
  lib?: readonly LibSourceRef[];
  packageName?: string;
  sandboxWorkspaces?: readonly SandboxWorkspaceFolderSourceRef[];
  sources?: readonly AgentSourceRef[];
  subagents?: readonly SubagentSourceRef[];
}

interface CreateSkillPackageSourceRefInput {
  assetsPath?: string;
  deferred?: boolean;
  description: string;
  license?: string;
  logicalPath: string;
  markdown: string;
  metadata?: Readonly<Record<string, string>>;
  name: string;
  referencesPath?: string;
  rootPath: string;
  scriptsPath?: string;
  skillFilePath: string;
  skillId: string;
  sourceId: string;
}

interface CreateModuleSourceRefInput {
  exportName?: string;
  logicalPath: string;
  sourceId?: string;
}

interface CreateLocalSubagentSourceRefInput {
  entryPath: string;
  logicalPath: string;
  manifest: AgentSourceManifest;
  rootPath: string;
  sourceId?: string;
  subagentId: string;
}

export function createAgentSourceManifest(
  input: CreateAgentSourceManifestInput,
): AgentSourceManifest {
  const appRoot = resolve(input.appRoot);
  const agentRoot = resolve(input.agentRoot);
  const manifest: AgentSourceManifest = {
    agentId: input.agentId ?? deriveAgentIdFromRoots(appRoot, agentRoot, input.packageName),
    agentRoot,
    appRoot,
    diagnosticsSummary: summarizeDiscoverDiagnostics(input.diagnostics ?? []),
    extensions: [...(input.extensions ?? [])],
    resolvedExtensions: [...(input.resolvedExtensions ?? [])],
    lib: [...(input.lib ?? [])],
    kind: AGENT_SOURCE_MANIFEST_KIND,
    sandboxWorkspaces: [...(input.sandboxWorkspaces ?? [])],
    sources: [...(input.sources ?? [])],
    version: AGENT_SOURCE_MANIFEST_VERSION,
    subagents: [...(input.subagents ?? [])],
  };

  if (input.configModule !== undefined) {
    manifest.configModule = input.configModule;
  }
  return manifest;
}

export function deriveAgentIdFromRoots(
  appRoot: string,
  agentRoot: string,
  packageName?: string,
): string {
  const relativeAgentRoot = normalizeLogicalPath(relative(appRoot, agentRoot));

  if (relativeAgentRoot === "" || relativeAgentRoot === ".") {
    return packageName ?? basename(appRoot);
  }

  if (relativeAgentRoot === "agent") {
    return packageName ?? basename(appRoot);
  }

  return basename(agentRoot);
}

export function createPathDerivedSourceId(logicalPath: string): string {
  return normalizeLogicalPath(logicalPath);
}

export function createModuleSourceRef(input: CreateModuleSourceRefInput): ModuleSourceRef {
  const logicalPath = normalizeLogicalPath(input.logicalPath);
  const moduleSourceRef: ModuleSourceRef = {
    sourceKind: "module",
    logicalPath,
    sourceId: input.sourceId ?? createPathDerivedSourceId(logicalPath),
  };

  if (input.exportName !== undefined) {
    moduleSourceRef.exportName = input.exportName;
  }

  return moduleSourceRef;
}

export function createConnectionSourceRef(
  input: CreateConnectionSourceRefInput,
): ConnectionSourceRef {
  return {
    ...createModuleSourceRef(input),
    connectionName: input.connectionName,
  };
}

export function createLocalSubagentSourceRef(
  input: CreateLocalSubagentSourceRefInput,
): LocalSubagentSourceRef {
  const logicalPath = normalizeLogicalPath(input.logicalPath);

  return {
    entryPath: input.entryPath,
    logicalPath,
    manifest: input.manifest,
    rootPath: input.rootPath,
    sourceId: input.sourceId ?? createPathDerivedSourceId(logicalPath),
    subagentId: input.subagentId,
  };
}

export function createSkillPackageSourceRef(
  input: CreateSkillPackageSourceRefInput,
): NamedSkillDefinition & SkillPackageSourceRef {
  const skillSourceRef: NamedSkillDefinition & SkillPackageSourceRef = {
    assetsPath: input.assetsPath,
    deferred: input.deferred,
    description: input.description,
    license: input.license,
    logicalPath: normalizeLogicalPath(input.logicalPath),
    content: input.markdown,
    metadata: input.metadata !== undefined ? { ...input.metadata } : undefined,
    name: input.name,
    referencesPath: input.referencesPath,
    rootPath: input.rootPath,
    scriptsPath: input.scriptsPath,
    skillFilePath: input.skillFilePath,
    skillId: input.skillId,
    sourceId: input.sourceId,
    sourceKind: "skill-package",
  };

  return skillSourceRef;
}
