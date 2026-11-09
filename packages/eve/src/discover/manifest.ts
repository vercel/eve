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

/**
 * Stable manifest kind emitted by discovery.
 */
export const AGENT_SOURCE_MANIFEST_KIND = "eve-agent-discovery-manifest";

/**
 * Current manifest schema version.
 */
export const AGENT_SOURCE_MANIFEST_VERSION = 16;

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

/** A memory module, with the slot it fills: `memory.ts` is `"memory"`, `memory/notes.ts` is `"notes"`. */
export interface MemorySourceRef extends ModuleSourceRef {
  readonly slot: string;
}

/** Every authored file the agent's slots hold, other than its config module. */
export type AgentSourceRef = InstructionsSourceRef | ScheduleSourceRef | SkillSourceRef;

/** What an authored source declares, which its slot — the first segment of its logical path — names. */
export type AgentSourceKind = keyof AgentSourceRefs;

interface AgentSourceRefs {
  readonly channel: ModuleSourceRef;
  readonly connection: ConnectionSourceRef;
  readonly hook: ModuleSourceRef;
  readonly instructions: InstructionsSourceRef;
  readonly memory: MemorySourceRef;
  readonly renderer: ModuleSourceRef;
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
  renderers: "renderer",
  sandbox: "sandbox",
  schedules: "schedule",
  skills: "skill",
  system: "instructions",
  tools: "tool",
};

/** The kind of source at `logicalPath`, or `undefined` for a path outside the agent's slots. */
export function sourceKindOf(logicalPath: string): AgentSourceKind | undefined {
  const root = logicalPath.split("/", 1)[0]!;
  return SOURCE_KIND_BY_SLOT_ROOT[root.includes(".") ? root.slice(0, root.indexOf(".")) : root];
}

/** The manifest's sources of one kind, in discovery order. */
export function sourcesOf<K extends AgentSourceKind>(
  manifest: Pick<AgentSourceManifest, "sources">,
  kind: K,
): readonly AgentSourceRefs[K][] {
  return manifest.sources.filter(
    (source): source is AgentSourceRefs[K] => sourceKindOf(source.logicalPath) === kind,
  );
}

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
 * Extension mount source reference preserved by the discovery manifest. Each
 * `agent/extensions/*.ts` file re-exports (and configures) an extension
 * package; the file basename is the mount namespace.
 */
export type ExtensionSourceRef = ModuleSourceRef;

/**
 * A mounted extension resolved to its package and discovered agent-shaped
 * source tree. The compiler composes each mount's {@link manifest} into the
 * consuming agent, prefixing contributions with {@link namespace}.
 */
export interface ResolvedExtensionMount {
  /** Programmatic declaration used when the mount does not exist on disk. */
  readonly programmaticDeclaration?: {
    readonly logicalPath: string;
    readonly sourceId: string;
    readonly importSpecifier: string;
    readonly entryPath: string;
    readonly config: JsonObject;
  };
  /** Mount namespace derived from the mount filename (e.g. `crm`). */
  readonly namespace: string;
  /** Package specifier the mount imports (e.g. `@acme/crm`). */
  readonly specifier: string;
  /** Package name from the resolved package.json, used to scope state. */
  readonly packageName: string;
  /** Absolute path to the resolved package root. */
  readonly packageRoot: string;
  /** Absolute path to the extension's agent-shaped source root. */
  readonly sourceRoot: string;
  /** Discovered agent-shaped source manifest for the extension. */
  readonly manifest: AgentSourceManifest;
  /** Runtime packages this extension requires the consuming application to externalize. */
  readonly externalDependencies: readonly string[];
  /**
   * Consumer-authored overrides discovered in the mount directory form
   * (`extensions/<ns>/{tools,connections,…}/`). Composed under the same
   * `<ns>__` namespace as the extension's own contributions but winning on
   * name collision. Absent for the flat file mount form.
   */
  readonly overrides?: AgentSourceManifest;
}

/**
 * Subagent source reference preserved by the discovery manifest.
 */
export type SubagentSourceRef = LocalSubagentSourceRef;

/**
 * Input used to build a manifest-ready connection source ref.
 */
interface CreateConnectionSourceRefInput extends CreateModuleSourceRefInput {
  connectionName: string;
}

/**
 * Versioned source manifest emitted by discovery.
 */
export interface AgentSourceManifest {
  agentId: string;
  agentRoot: string;
  appRoot: string;
  /** The agent's config module: `agent.<ext>`, or a single-file subagent's own file. */
  configModule?: ModuleSourceRef;
  diagnosticsSummary: DiscoverDiagnosticsSummary;
  /**
   * Mounted extension source references discovered under `agent/extensions/`.
   * Each entry's logical-path basename is the mount namespace the compiler
   * prefixes onto the extension's composed contributions.
   */
  extensions: ExtensionSourceRef[];
  /**
   * Mounted extensions resolved to their packages and discovered source trees.
   * Populated only for the agent root; extension trees do not mount further
   * extensions (transitive mounting is a non-goal).
   */
  resolvedExtensions: ResolvedExtensionMount[];
  lib: LibSourceRef[];
  kind: typeof AGENT_SOURCE_MANIFEST_KIND;
  /**
   * Every authored module and resource the agent's slots hold, other than its config module: its
   * channels, connections, hooks, memory, sandbox, tools, instructions, schedules, and skills, in
   * that order. A source's slot names its kind; see {@link sourcesOf}.
   */
  sources: AgentSourceRef[];
  /**
   * Authored sandbox workspace folder discovered under
   * `agent/sandbox/workspace/`. At most one entry per agent; mounted
   * into the live sandbox cwd at session bootstrap.
   */
  sandboxWorkspaces: SandboxWorkspaceFolderSourceRef[];
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
  configModule?: ModuleSourceRef;
  diagnostics?: readonly DiscoverDiagnostic[];
  extensions?: readonly ExtensionSourceRef[];
  resolvedExtensions?: readonly ResolvedExtensionMount[];
  lib?: readonly LibSourceRef[];
  /**
   * Optional package name read from the app root's package.json.
   * When provided this is preferred over `basename(appRoot)` for agent id
   * derivation so that builds running in synthetic CI paths (e.g.
   * `/vercel/path0`) produce a meaningful agent id.
   */
  packageName?: string;
  sandboxWorkspaces?: readonly SandboxWorkspaceFolderSourceRef[];
  sources?: readonly AgentSourceRef[];
  subagents?: readonly SubagentSourceRef[];
}

/**
 * Input used to build a manifest-ready skill package source ref.
 */
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

/**
 * Input used to build a manifest-ready module source ref.
 */
interface CreateModuleSourceRefInput {
  exportName?: string;
  logicalPath: string;
  sourceId?: string;
}

/**
 * Input used to build a manifest-ready local subagent source ref.
 */
interface CreateLocalSubagentSourceRefInput {
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
