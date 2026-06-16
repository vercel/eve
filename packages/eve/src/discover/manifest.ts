import { basename, relative, resolve } from "node:path";
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

/**
 * Stable manifest kind emitted by discovery.
 */
export const AGENT_SOURCE_MANIFEST_KIND = "eve-agent-discovery-manifest";

/**
 * Current manifest schema version.
 */
export const AGENT_SOURCE_MANIFEST_VERSION = 12;

/**
 * Channel source reference preserved by the discovery manifest.
 */
export type ChannelSourceRef = ModuleSourceRef;

/**
 * Connection source reference preserved by the discovery manifest.
 *
 * Carries the explicit `connectionName` so the compiler does not have to
 * re-derive it from the module's logical path.
 */
export interface ConnectionSourceRef extends ModuleSourceRef {
  /**
   * Authored connection name. Equals the basename of the file form
   * (`connections/linear.ts` -> `"linear"`) or the directory name of the
   * folder form (`connections/linear/connection.ts` -> `"linear"`).
   */
  readonly connectionName: string;
}

/**
 * Instructions source reference preserved by discovery for compiler
 * normalization.
 */
export type InstructionsSourceRef = MarkdownSourceRef<InstructionsDefinition> | ModuleSourceRef;

/**
 * Skill source reference preserved by the discovery manifest.
 */
export type SkillSourceRef =
  | MarkdownSourceRef<SkillDefinition>
  | ModuleSourceRef
  | (NamedSkillDefinition & SkillPackageSourceRef);

/**
 * Recursive manifest entry for a local subagent package.
 */
export interface LocalSubagentSourceRef {
  entryPath: string;
  logicalPath: string;
  manifest: AgentSourceManifest;
  rootPath: string;
  sourceId: string;
  subagentId: string;
}

/**
 * Schedule source reference preserved by the discovery manifest. A
 * schedule may be authored either as a TypeScript module
 * (`schedules/<name>.ts`) or as a markdown file with frontmatter
 * (`schedules/<name>.md`).
 */
export type ScheduleSourceRef = MarkdownSourceRef<ScheduleDefinition> | ModuleSourceRef;

/**
 * Sandbox source reference preserved by the discovery manifest.
 *
 * Every agent owns exactly one sandbox; the source ref is just a
 * module reference identifying the authored `sandbox.<ext>` (or
 * `sandbox/sandbox.<ext>`) override.
 */
export type SandboxSourceRef = ModuleSourceRef;

/**
 * Sandbox workspace folder reference preserved by the discovery
 * manifest.
 *
 * Emitted when `agent/sandbox/workspace/` is found on disk. The
 * compiler and runtime mount the contents of `sourcePath` into the
 * sandbox's live cwd at session bootstrap.
 */
export interface SandboxWorkspaceFolderSourceRef {
  /**
   * Logical path of the workspace folder relative to the agent root,
   * e.g. `"sandbox/workspace"`.
   */
  readonly logicalPath: string;
  /**
   * Top-level directory entries discovered inside the workspace folder.
   * Directories are listed with a trailing `/`. Used by the workspace
   * prompt section so the model can see the file tree at a glance.
   */
  readonly rootEntries: readonly string[];
  /**
   * Stable id derived from the logical path.
   */
  readonly sourceId: string;
  /**
   * Absolute on-disk path to the workspace folder.
   */
  readonly sourcePath: string;
}

/**
 * Package-local helper module preserved by the discovery manifest.
 */
export type LibSourceRef = ModuleSourceRef;

/**
 * Subagent source reference preserved by the discovery manifest.
 */
export type SubagentSourceRef = LocalSubagentSourceRef;

/**
 * Input used to build a manifest-ready connection source ref.
 */
export interface CreateConnectionSourceRefInput extends CreateModuleSourceRefInput {
  connectionName: string;
}

/**
 * Versioned source manifest emitted by discovery.
 */
export interface AgentSourceManifest {
  agentId: string;
  agentRoot: string;
  appRoot: string;
  channels: ChannelSourceRef[];
  connections: ConnectionSourceRef[];
  configModule?: ModuleSourceRef;
  diagnosticsSummary: DiscoverDiagnosticsSummary;
  hooks: ModuleSourceRef[];
  lib: LibSourceRef[];
  kind: typeof AGENT_SOURCE_MANIFEST_KIND;
  /**
   * Authored instructions prompt sources discovered at the agent root.
   *
   * Supports three forms:
   * 1. Flat file: `instructions.md` or `instructions.{ts,...}` → single element.
   * 2. Directory: `instructions/` with `.md` and `.ts` files → multiple elements.
   * 3. Legacy: `system.{md,ts,...}` → single element with deprecation warning.
   *
   * Empty when no instructions are authored.
   */
  instructions: InstructionsSourceRef[];
  /**
   * Authored sandbox module discovered for this agent, or `null` when
   * the agent does not declare one. Every agent owns at most one
   * sandbox.
   */
  sandbox: SandboxSourceRef | null;
  /**
   * Authored sandbox workspace folder discovered under
   * `agent/sandbox/workspace/`. At most one entry per agent; mounted
   * into the live sandbox cwd at session bootstrap.
   */
  sandboxWorkspaces: SandboxWorkspaceFolderSourceRef[];
  schedules: ScheduleSourceRef[];
  skills: SkillSourceRef[];
  tools: ModuleSourceRef[];
  version: typeof AGENT_SOURCE_MANIFEST_VERSION;
  subagents: SubagentSourceRef[];
}

/**
 * Input used to build a discovery manifest with stable defaults.
 */
export interface CreateAgentSourceManifestInput {
  agentId?: string;
  agentRoot: string;
  appRoot: string;
  channels?: readonly ChannelSourceRef[];
  connections?: readonly ConnectionSourceRef[];
  configModule?: ModuleSourceRef;
  diagnostics?: readonly DiscoverDiagnostic[];
  hooks?: readonly ModuleSourceRef[];
  lib?: readonly LibSourceRef[];
  /**
   * Optional package name read from the app root's package.json.
   * When provided this is preferred over `basename(appRoot)` for agent id
   * derivation so that builds running in synthetic CI paths (e.g.
   * `/vercel/path0`) produce a meaningful agent id.
   */
  packageName?: string;
  instructions?: readonly InstructionsSourceRef[];
  sandbox?: SandboxSourceRef | null;
  sandboxWorkspaces?: readonly SandboxWorkspaceFolderSourceRef[];
  schedules?: readonly ScheduleSourceRef[];
  skills?: readonly SkillSourceRef[];
  tools?: readonly ModuleSourceRef[];
  subagents?: readonly SubagentSourceRef[];
}

/**
 * Input used to build a manifest-ready skill package source ref.
 */
export interface CreateSkillPackageSourceRefInput {
  assetsPath?: string;
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

/**
 * Input used to build a manifest-ready module source ref.
 */
export interface CreateModuleSourceRefInput {
  exportName?: string;
  logicalPath: string;
  sourceId?: string;
}

/**
 * Input used to build a manifest-ready local subagent source ref.
 */
export interface CreateLocalSubagentSourceRefInput {
  entryPath: string;
  logicalPath: string;
  manifest: AgentSourceManifest;
  rootPath: string;
  sourceId?: string;
  subagentId: string;
}

/**
 * Creates a versioned discovery manifest with stable empty-array defaults.
 */
export function createAgentSourceManifest(
  input: CreateAgentSourceManifestInput,
): AgentSourceManifest {
  const appRoot = resolve(input.appRoot);
  const agentRoot = resolve(input.agentRoot);
  const manifest: AgentSourceManifest = {
    agentId: input.agentId ?? deriveAgentIdFromRoots(appRoot, agentRoot, input.packageName),
    agentRoot,
    appRoot,
    channels: [...(input.channels ?? [])],
    connections: [...(input.connections ?? [])],
    diagnosticsSummary: summarizeDiscoverDiagnostics(input.diagnostics ?? []),
    hooks: [...(input.hooks ?? [])],
    instructions: [...(input.instructions ?? [])],
    lib: [...(input.lib ?? [])],
    kind: AGENT_SOURCE_MANIFEST_KIND,
    sandbox: input.sandbox ?? null,
    sandboxWorkspaces: [...(input.sandboxWorkspaces ?? [])],
    schedules: [...(input.schedules ?? [])],
    skills: [...(input.skills ?? [])],
    tools: [...(input.tools ?? [])],
    version: AGENT_SOURCE_MANIFEST_VERSION,
    subagents: [...(input.subagents ?? [])],
  };

  if (input.configModule !== undefined) {
    manifest.configModule = input.configModule;
  }

  return manifest;
}

/**
 * Derives a stable agent id from the resolved app and agent roots.
 *
 * When `packageName` is provided it is preferred over `basename(appRoot)` so
 * that builds running inside synthetic CI working directories (e.g.
 * `/vercel/path0`) produce a meaningful agent id instead of `"path0"`.
 */
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

/**
 * Creates a stable path-derived source id for manifest entries.
 */
export function createPathDerivedSourceId(logicalPath: string): string {
  return normalizeLogicalPath(logicalPath);
}

/**
 * Creates a module source ref while omitting optional undefined fields.
 */
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

/**
 * Creates a connection source ref tagged with its authored name.
 */
export function createConnectionSourceRef(
  input: CreateConnectionSourceRefInput,
): ConnectionSourceRef {
  return {
    ...createModuleSourceRef(input),
    connectionName: input.connectionName,
  };
}

/**
 * Creates a local subagent source ref while omitting optional undefined fields.
 */
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

/**
 * Creates a skill package source ref while omitting optional undefined fields.
 */
export function createSkillPackageSourceRef(
  input: CreateSkillPackageSourceRefInput,
): NamedSkillDefinition & SkillPackageSourceRef {
  const skillSourceRef: NamedSkillDefinition & SkillPackageSourceRef = {
    assetsPath: input.assetsPath,
    description: input.description,
    license: input.license,
    logicalPath: normalizeLogicalPath(input.logicalPath),
    markdown: input.markdown,
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
