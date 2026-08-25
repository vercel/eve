import { normalizeLogicalPath, stripLogicalPathExtension } from "#discover/filesystem.js";

/**
 * Owner of one composed agent source. Active module-backed sources carry
 * their owner on the required compiled binding; non-module sources carry it
 * on their compiled source record.
 */
export type AgentSourceOwner =
  | { readonly kind: "application" }
  | { readonly feature: string; readonly kind: "framework" }
  | {
      readonly kind: "extension";
      readonly namespace: string;
      readonly packageName: string;
    };

/**
 * Composition layer of one candidate. Precedence is
 * `framework-default < extension-package < extension-override < application`.
 */
export type AgentSourceLayer =
  | "framework-default"
  | "extension-package"
  | "extension-override"
  | "application";

const AGENT_SOURCE_LAYER_PRECEDENCE: Readonly<Record<AgentSourceLayer, number>> = {
  "framework-default": 0,
  "extension-package": 1,
  "extension-override": 2,
  application: 3,
};

/** Returns the numeric precedence of one composition layer (higher wins). */
export function agentSourceLayerPrecedence(layer: AgentSourceLayer): number {
  return AGENT_SOURCE_LAYER_PRECEDENCE[layer];
}

/**
 * Physical backing of one module-backed source. Filesystem loading uses the
 * explicit `sourcePath`; programmatic loading uses the exact
 * registry/module/revision tuple. `logicalPath` is never used as an import
 * path.
 */
export type AgentModuleBacking =
  | {
      readonly externalDependencies: readonly string[];
      readonly extensionScope?: {
        readonly namespace: string;
        readonly sourceRoot: string;
      };
      readonly kind: "filesystem";
      readonly sourcePath: string;
    }
  | {
      readonly kind: "programmatic";
      readonly moduleId: string;
      readonly registryId: string;
      readonly revision: string;
      readonly semanticRevision?: string;
    };

/**
 * One module candidate for a canonical logical slot: logical identity plus an
 * explicit physical binding, constructed before any definition executes.
 */
export interface AgentModuleCandidate {
  readonly backing: AgentModuleBacking;
  readonly exportName?: string;
  readonly layer: AgentSourceLayer;
  readonly logicalPath: string;
  readonly nodeId: string;
  readonly owner: AgentSourceOwner;
  readonly sourceId: string;
}

/**
 * Required compiled binding for one module-backed manifest reference, keyed
 * by the same `sourceId` used by the manifest.
 */
export interface CompiledModuleBinding {
  readonly backing: AgentModuleBacking;
  readonly logicalPath: string;
  readonly owner: AgentSourceOwner;
}

/**
 * Immutable module namespace produced by one programmatic module loader.
 */
export type ProgrammaticModuleNamespace = Readonly<Record<string, unknown>>;

/**
 * One lazily loaded module namespace declared at a virtual agent-relative
 * logical path.
 */
export interface ProgrammaticAgentModule {
  readonly exportName?: string;
  readonly loadNamespace: () => Promise<ProgrammaticModuleNamespace>;
  readonly logicalPath: string;
  /**
   * Stable module-level revision used for selected-backing identity when the
   * source-wide revision intentionally covers unrelated modules.
   */
  readonly semanticRevision?: string;
}

/**
 * Immutable set of programmatic modules registered under one source id and
 * one executable revision.
 */
export interface ProgrammaticAgentSource {
  readonly id: string;
  readonly modules: readonly ProgrammaticAgentModule[];
  readonly revision: string;
}

/**
 * Declares an immutable programmatic agent source. Construction
 * shallow-copies and freezes source and module metadata without invoking any
 * namespace loader.
 */
export function defineProgrammaticAgentSource(
  input: ProgrammaticAgentSource,
): ProgrammaticAgentSource {
  if (input.id.length === 0) {
    throw new Error("A programmatic agent source requires a non-empty id.");
  }
  if (input.revision.length === 0) {
    throw new Error(`Programmatic agent source "${input.id}" requires a non-empty revision.`);
  }

  const seenLogicalPaths = new Set<string>();
  const modules = input.modules.map((module) => {
    const logicalPath = validateProgrammaticLogicalPath(input.id, module.logicalPath);
    if (seenLogicalPaths.has(logicalPath)) {
      throw new Error(
        `Programmatic agent source "${input.id}" declares "${logicalPath}" more than once.`,
      );
    }
    seenLogicalPaths.add(logicalPath);
    if (module.semanticRevision !== undefined && module.semanticRevision.length === 0) {
      throw new Error(
        `Programmatic module "${logicalPath}" in source "${input.id}" declares an empty semanticRevision.`,
      );
    }
    return Object.freeze({
      exportName: module.exportName,
      loadNamespace: module.loadNamespace,
      logicalPath,
      semanticRevision: module.semanticRevision,
    });
  });

  return Object.freeze({
    id: input.id,
    modules: Object.freeze(modules),
    revision: input.revision,
  });
}

/**
 * One registration applying a programmatic source to the application root or
 * to every already-discovered local node.
 */
export interface AgentSourceRegistration {
  readonly applyTo: "root" | "all-local-nodes";
  readonly source: ProgrammaticAgentSource;
}

/**
 * Explicitly assembled, immutable registry of programmatic sources consulted
 * by compilation and by every module-map implementation.
 */
export interface AgentSourceRegistry {
  readonly registrations: readonly AgentSourceRegistration[];
}

/**
 * Logical paths an `all-local-nodes` registration may not select. The closed
 * internal framework registration is the narrow exception that provides the
 * default `agent.ts` for every already-discovered local node.
 */
const NODE_OVERLAY_REJECTED_PREFIXES = ["subagents/", "channels/", "schedules/", "extensions/"];

/**
 * Creates an immutable agent source registry from explicit registrations.
 *
 * `all-local-nodes` registrations are a finite overlay applied after
 * filesystem and extension nodes are discovered; they reject `agent.ts`,
 * `subagents/**`, `channels/**`, `schedules/**`, and `extensions/**` so no
 * registration can expand the graph recursively.
 */
export function createAgentSourceRegistry(
  registrations: readonly AgentSourceRegistration[],
  options: { readonly allowFrameworkSlots?: boolean } = {},
): AgentSourceRegistry {
  const seenSourceIds = new Set<string>();
  for (const registration of registrations) {
    if (seenSourceIds.has(registration.source.id)) {
      throw new Error(
        `Agent source registry received source id "${registration.source.id}" more than once.`,
      );
    }
    seenSourceIds.add(registration.source.id);
    if (options.allowFrameworkSlots === true) {
      continue;
    }
    for (const module of registration.source.modules) {
      if (registration.applyTo === "all-local-nodes") {
        assertNodeOverlayLogicalPath(registration.source.id, module.logicalPath);
      }
    }
  }

  return Object.freeze({ registrations: Object.freeze([...registrations]) });
}

function assertNodeOverlayLogicalPath(sourceId: string, logicalPath: string): void {
  if (canonicalSlotKey(logicalPath) === "agent") {
    throw new Error(
      `Programmatic source "${sourceId}" may not provide "agent.ts" to all local nodes.`,
    );
  }
  for (const prefix of NODE_OVERLAY_REJECTED_PREFIXES) {
    if (logicalPath.startsWith(prefix)) {
      throw new Error(
        `Programmatic source "${sourceId}" may not provide "${logicalPath}" to all local nodes.`,
      );
    }
  }
}

function validateProgrammaticLogicalPath(sourceId: string, logicalPath: string): string {
  const normalized = normalizeLogicalPath(logicalPath);
  if (normalized.length === 0 || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(
      `Programmatic module path "${logicalPath}" in source "${sourceId}" must be relative to an agent root.`,
    );
  }
  if (normalized.split("/").includes("..")) {
    throw new Error(
      `Programmatic module path "${logicalPath}" in source "${sourceId}" may not traverse with "..".`,
    );
  }
  return normalized;
}

/**
 * Derives the deterministic source id for one programmatic module:
 * `<source.id>:<logicalPath>`.
 */
export function createProgrammaticSourceId(registryId: string, logicalPath: string): string {
  return `${registryId}:${normalizeLogicalPath(logicalPath)}`;
}

/**
 * Error raised when a programmatic binding cannot be satisfied by the
 * assembled registry. Missing or revision-mismatched bindings fail without
 * probing a virtual path on disk or invoking a namespace loader.
 */
export class ProgrammaticModuleLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgrammaticModuleLoadError";
  }
}

/**
 * Resolves one programmatic backing against the registry and loads its exact
 * namespace. Rejects a same-id source at a different revision before
 * evaluating any namespace.
 */
export async function loadProgrammaticModuleNamespace(
  registry: AgentSourceRegistry,
  backing: Extract<AgentModuleBacking, { kind: "programmatic" }>,
): Promise<ProgrammaticModuleNamespace> {
  const registration = registry.registrations.find(
    (entry) => entry.source.id === backing.registryId,
  );
  if (registration === undefined) {
    throw new ProgrammaticModuleLoadError(
      `No programmatic agent source is registered as "${backing.registryId}".`,
    );
  }
  if (registration.source.revision !== backing.revision) {
    throw new ProgrammaticModuleLoadError(
      `Programmatic agent source "${backing.registryId}" is registered at revision ` +
        `"${registration.source.revision}" but the compiled binding requires revision "${backing.revision}".`,
    );
  }
  const module = registration.source.modules.find(
    (entry) => entry.logicalPath === backing.moduleId,
  );
  if (module === undefined) {
    throw new ProgrammaticModuleLoadError(
      `Programmatic agent source "${backing.registryId}" does not declare a module at "${backing.moduleId}".`,
    );
  }
  return await module.loadNamespace();
}

/**
 * Canonical slot key for one logical path. `.js` and `.ts` module variants
 * select the same slot; the connection folder form collides with its file
 * form; skill package directories collide with flat skill files.
 */
export function canonicalSlotKey(logicalPath: string): string {
  const normalized = normalizeLogicalPath(logicalPath);
  const withoutExtension = stripLogicalPathExtension(normalized);

  // Connection folder form: connections/<name>/connection.<ext> selects the
  // same slot as connections/<name>.<ext>.
  const connectionFolderMatch = withoutExtension.match(/^connections\/([^/]+)\/connection$/);
  if (connectionFolderMatch !== undefined && connectionFolderMatch !== null) {
    return `connections/${connectionFolderMatch[1]}`;
  }

  // Sandbox folder form: sandbox/sandbox.<ext> selects the same slot as
  // sandbox.<ext>.
  if (withoutExtension === "sandbox/sandbox") {
    return "sandbox";
  }

  // Skill package directory form: skills/<name>/SKILL.md selects the same
  // slot as skills/<name>.<ext>.
  const skillPackageMatch = withoutExtension.match(/^skills\/([^/]+)\/SKILL$/);
  if (skillPackageMatch !== undefined && skillPackageMatch !== null) {
    return `skills/${skillPackageMatch[1]}`;
  }

  return withoutExtension;
}
