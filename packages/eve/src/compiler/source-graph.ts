import { isAbsolute, posix } from "node:path";

import {
  getSupportedModuleBaseName,
  normalizeLogicalPath,
  stripLogicalPathExtension,
} from "#discover/filesystem.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";

export type ProgrammaticModuleNamespace = Readonly<Record<string, unknown>>;

/** Shares zero-argument definition-factory results within one module-map load. */
export function memoizeModuleNamespaceFactories(
  namespace: ProgrammaticModuleNamespace,
): ProgrammaticModuleNamespace {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(namespace).map(([exportName, exportValue]) => {
        if (typeof exportValue !== "function") return [exportName, exportValue];
        let invocation: Promise<unknown> | undefined;
        const memoized = new Proxy(exportValue, {
          apply(target, thisArgument, argumentsList) {
            if (argumentsList.length > 0) {
              return Reflect.apply(target, thisArgument, argumentsList);
            }
            invocation ??= Promise.resolve().then(() =>
              Reflect.apply(target, thisArgument, argumentsList),
            );
            return invocation;
          },
        });
        return [exportName, memoized];
      }),
    ),
  );
}

export interface ProgrammaticModuleLoadContext {
  readonly dependencies: Readonly<Record<string, ProgrammaticModuleNamespace>>;
  readonly parameters: JsonObject;
}

export interface ProgrammaticAgentModule {
  readonly exportName?: string;
  readonly loadNamespace: (
    context: ProgrammaticModuleLoadContext,
  ) => Promise<ProgrammaticModuleNamespace>;
  readonly logicalPath: string;
  readonly semanticRevision?: string;
}

export interface ProgrammaticAgentSource {
  readonly id: string;
  readonly modules: readonly ProgrammaticAgentModule[];
  readonly revision: string;
}

export interface AgentSourceRegistration {
  readonly applyTo: "root" | "all-local-nodes";
  readonly source: ProgrammaticAgentSource;
}

export interface AgentSourceRegistryOptions {
  readonly templates?: readonly ProgrammaticAgentSource[];
}

export interface RegisteredProgrammaticTemplate {
  readonly module: ProgrammaticAgentModule;
  readonly source: ProgrammaticAgentSource;
}

export interface AgentSourceRegistry {
  readonly registrations: readonly AgentSourceRegistration[];
  readonly sources: ReadonlyMap<string, ProgrammaticAgentSource>;
  readonly templates: ReadonlyMap<string, RegisteredProgrammaticTemplate>;
}

class ImmutableProgrammaticSourceMap<T> implements ReadonlyMap<string, T> {
  readonly #values: ReadonlyMap<string, T>;

  constructor(values: ReadonlyMap<string, T>) {
    this.#values = new Map(values);
    Object.freeze(this);
  }

  get size(): number {
    return this.#values.size;
  }

  get [Symbol.toStringTag](): string {
    return "ImmutableProgrammaticSourceMap";
  }

  [Symbol.iterator](): MapIterator<[string, T]> {
    return this.#values[Symbol.iterator]();
  }

  entries(): MapIterator<[string, T]> {
    return this.#values.entries();
  }

  forEach(
    callbackfn: (value: T, key: string, map: ReadonlyMap<string, T>) => void,
    thisArg?: unknown,
  ): void {
    this.#values.forEach((value, key) => callbackfn.call(thisArg, value, key, this));
  }

  get(key: string): T | undefined {
    return this.#values.get(key);
  }

  has(key: string): boolean {
    return this.#values.has(key);
  }

  keys(): MapIterator<string> {
    return this.#values.keys();
  }

  values(): MapIterator<T> {
    return this.#values.values();
  }
}

export type AgentSourceOwner =
  | { readonly kind: "application" }
  | { readonly feature: string; readonly kind: "framework" }
  | {
      readonly kind: "extension";
      readonly namespace: string;
      readonly packageName: string;
    };

export type AgentSourceLayer =
  | "framework-default"
  | "extension-package"
  | "extension-override"
  | "application";

export type AgentSourceForm = "derived" | "direct";

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
      readonly dependencies?: Readonly<Record<string, string>>;
      readonly kind: "programmatic";
      readonly moduleId: string;
      readonly parameters?: JsonObject;
      readonly registryId: string;
      readonly revision: string;
      readonly semanticRevision?: string;
    };

export type AgentSourceBacking =
  | AgentModuleBacking
  | {
      readonly kind: "resource";
      readonly sourcePath: string;
    };

export interface AgentModuleCandidate {
  readonly backing: AgentModuleBacking;
  readonly exportName?: string;
  readonly form: AgentSourceForm;
  readonly layer: AgentSourceLayer;
  readonly logicalPath: string;
  readonly nodeId: string;
  readonly owner: AgentSourceOwner;
  readonly sourceId: string;
}

export interface CompiledModuleBinding {
  readonly backing: AgentModuleBacking;
  readonly logicalPath: string;
  readonly owner: AgentSourceOwner;
}

export interface AgentSourceDescriptor {
  readonly backing: AgentSourceBacking;
  readonly form: AgentSourceForm;
  readonly layer: AgentSourceLayer;
  readonly logicalPath: string;
  readonly owner: AgentSourceOwner;
  readonly sourceId: string;
}

export interface AgentResourceCandidate {
  readonly backing: Extract<AgentSourceBacking, { readonly kind: "resource" }>;
  readonly form: AgentSourceForm;
  readonly layer: AgentSourceLayer;
  readonly logicalPath: string;
  readonly nodeId: string;
  readonly owner: AgentSourceOwner;
  readonly sourceId: string;
}

export type AgentSourceCandidate = AgentModuleCandidate | AgentResourceCandidate;

export type AgentSourceCompositionEntry =
  | {
      readonly kind: "shadowed";
      readonly source: AgentSourceDescriptor;
      readonly winnerSourceId: string;
    }
  | {
      readonly kind: "disabled";
      readonly source: AgentSourceDescriptor;
    };

export interface AgentSourceComposition {
  readonly entries: readonly AgentSourceCompositionEntry[];
}

export interface ComposedAgentModuleCandidates {
  readonly composition: AgentSourceComposition;
  readonly selected: ReadonlyMap<string, AgentSourceCandidate>;
}

const LAYER_PRECEDENCE: Readonly<Record<AgentSourceLayer, number>> = {
  "framework-default": 0,
  "extension-package": 1,
  "extension-override": 2,
  application: 3,
};

const FORM_PRECEDENCE: Readonly<Record<AgentSourceForm, number>> = {
  derived: 0,
  direct: 1,
};

const registeredProgrammaticTemplates = new WeakSet<RegisteredProgrammaticTemplate>();

export function defineProgrammaticAgentSource(
  input: ProgrammaticAgentSource,
): ProgrammaticAgentSource {
  const id = expectNonEmpty(input.id, "Programmatic agent source id");
  const revision = expectNonEmpty(input.revision, `Programmatic agent source "${id}" revision`);
  const logicalPaths = new Set<string>();
  const modules = input.modules.map((module) => {
    const logicalPath = validateProgrammaticLogicalPath(module.logicalPath);
    if (logicalPaths.has(logicalPath)) {
      throw new Error(
        `Programmatic agent source "${id}" declares "${logicalPath}" more than once.`,
      );
    }
    logicalPaths.add(logicalPath);
    const semanticRevision =
      module.semanticRevision === undefined
        ? undefined
        : expectNonEmpty(
            module.semanticRevision,
            `Programmatic module "${id}:${logicalPath}" semanticRevision`,
          );
    return Object.freeze({
      exportName: module.exportName,
      loadNamespace: module.loadNamespace,
      logicalPath,
      semanticRevision,
    });
  });

  return Object.freeze({ id, modules: Object.freeze(modules), revision });
}

export function createAgentSourceRegistry(
  registrations: readonly AgentSourceRegistration[],
  options: AgentSourceRegistryOptions = {},
): AgentSourceRegistry {
  const sources = new Map<string, ProgrammaticAgentSource>();
  const templates = new Map<string, RegisteredProgrammaticTemplate>();
  const addSource = (inputSource: ProgrammaticAgentSource): ProgrammaticAgentSource => {
    const source = defineProgrammaticAgentSource(inputSource);
    if (sources.has(source.id)) {
      throw new Error(`Programmatic agent source id "${source.id}" is registered more than once.`);
    }
    sources.set(source.id, source);
    return source;
  };
  const frozenRegistrations = registrations.map((registration) => {
    const source = addSource(registration.source);
    return Object.freeze({ applyTo: registration.applyTo, source });
  });
  for (const inputTemplate of options.templates ?? []) {
    const source = addSource(inputTemplate);
    if (source.modules.length !== 1) {
      throw new Error(
        `Programmatic template source "${source.id}" must register exactly one module.`,
      );
    }
    const template = Object.freeze({ module: source.modules[0]!, source });
    registeredProgrammaticTemplates.add(template);
    templates.set(source.id, template);
  }

  return Object.freeze({
    registrations: Object.freeze(frozenRegistrations),
    sources: new ImmutableProgrammaticSourceMap(sources),
    templates: new ImmutableProgrammaticSourceMap(templates),
  });
}

export function createProgrammaticModuleCandidates(input: {
  readonly layer: AgentSourceLayer;
  readonly nodeId: string;
  readonly owner: AgentSourceOwner;
  readonly registration: AgentSourceRegistration;
}): readonly AgentModuleCandidate[] {
  return input.registration.source.modules.map((module) => {
    const sourceId = `${input.registration.source.id}:${module.logicalPath}`;
    return Object.freeze({
      backing: Object.freeze({
        kind: "programmatic" as const,
        moduleId: module.logicalPath,
        registryId: input.registration.source.id,
        revision: input.registration.source.revision,
        semanticRevision: module.semanticRevision,
      }),
      exportName: module.exportName,
      form: "direct" as const,
      layer: input.layer,
      logicalPath: module.logicalPath,
      nodeId: input.nodeId,
      owner: input.owner,
      sourceId,
    });
  });
}

export function instantiateProgrammaticTemplate(input: {
  readonly anchor: AgentModuleCandidate;
  readonly dependencies: Readonly<Record<string, AgentModuleCandidate>>;
  readonly logicalPath: string;
  readonly owner: AgentSourceOwner;
  readonly parameters?: JsonObject;
  readonly template: RegisteredProgrammaticTemplate;
}): AgentModuleCandidate {
  if (!registeredProgrammaticTemplates.has(input.template)) {
    throw new Error("Derived programmatic modules require a registered template.");
  }
  const logicalPath = validateProgrammaticLogicalPath(input.logicalPath);
  const anchorSourceId = expectNonEmpty(
    input.anchor.sourceId,
    "Derived programmatic module anchor source id",
  );
  const sourceId = `${input.template.source.id}:${logicalPath}:from:${anchorSourceId}`;
  const dependencyCandidates = Object.values(input.dependencies);
  if (!dependencyCandidates.some((candidate) => candidate.sourceId === anchorSourceId)) {
    throw new Error(
      `Derived programmatic module "${sourceId}" must include its anchor source as a dependency.`,
    );
  }
  const dependencies = Object.freeze(
    Object.fromEntries(
      Object.entries(input.dependencies)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([alias, candidate]) => {
          expectNonEmpty(alias, "Derived programmatic module dependency alias");
          if (candidate.nodeId !== input.anchor.nodeId) {
            throw new Error(
              `Derived programmatic module "${sourceId}" cannot depend on source "${candidate.sourceId}" from another node.`,
            );
          }
          return [alias, candidate.sourceId];
        }),
    ),
  );
  const parameters = Object.freeze(parseJsonObject(input.parameters ?? {}));
  return Object.freeze({
    backing: Object.freeze({
      dependencies,
      kind: "programmatic" as const,
      moduleId: input.template.module.logicalPath,
      parameters,
      registryId: input.template.source.id,
      revision: input.template.source.revision,
      semanticRevision: input.template.module.semanticRevision,
    }),
    exportName: input.template.module.exportName,
    form: "derived" as const,
    layer: input.anchor.layer,
    logicalPath,
    nodeId: input.anchor.nodeId,
    owner: input.owner,
    sourceId,
  });
}

export function composeAgentModuleCandidates(
  candidates: readonly AgentSourceCandidate[],
): ComposedAgentModuleCandidates {
  const candidatesBySlot = new Map<string, AgentSourceCandidate[]>();
  const sourceIds = new Set<string>();

  for (const candidate of candidates) {
    if (sourceIds.has(candidate.sourceId)) {
      throw new Error(
        `Agent source id "${candidate.sourceId}" is declared more than once in node "${candidate.nodeId}".`,
      );
    }
    sourceIds.add(candidate.sourceId);
    const slot = canonicalSourceSlot(candidate.logicalPath);
    const slotCandidates = candidatesBySlot.get(slot) ?? [];
    slotCandidates.push(candidate);
    candidatesBySlot.set(slot, slotCandidates);
  }

  const selected = new Map<string, AgentSourceCandidate>();
  const entries: AgentSourceCompositionEntry[] = [];

  for (const [slot, slotCandidates] of [...candidatesBySlot].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const seenPrecedence = new Set<string>();
    for (const candidate of slotCandidates) {
      const precedence = `${candidate.layer}:${candidate.form}`;
      if (seenPrecedence.has(precedence)) {
        throw new Error(
          `Agent source slot "${slot}" has more than one ${candidate.layer} ${candidate.form} candidate.`,
        );
      }
      seenPrecedence.add(precedence);
    }

    const ordered = [...slotCandidates].sort(
      (left, right) =>
        LAYER_PRECEDENCE[right.layer] - LAYER_PRECEDENCE[left.layer] ||
        FORM_PRECEDENCE[right.form] - FORM_PRECEDENCE[left.form],
    );
    const winner = ordered[0]!;
    selected.set(slot, winner);

    for (const loser of ordered.slice(1)) {
      entries.push({
        kind: "shadowed",
        source: describeAgentSourceCandidate(loser),
        winnerSourceId: winner.sourceId,
      });
    }
  }

  validateSelectedCandidateDependencies(selected);

  return {
    composition: { entries: Object.freeze(entries) },
    selected,
  };
}

export function disableComposedCandidate(input: {
  readonly candidate: AgentSourceCandidate;
  readonly composed: ComposedAgentModuleCandidates;
}): ComposedAgentModuleCandidates {
  const slot = canonicalSourceSlot(input.candidate.logicalPath);
  const selected = new Map(input.composed.selected);
  if (selected.get(slot)?.sourceId !== input.candidate.sourceId) {
    throw new Error(`Only the selected source for "${slot}" can disable that slot.`);
  }
  const replaced = input.composed.composition.entries.some(
    (entry) => entry.kind === "shadowed" && entry.winnerSourceId === input.candidate.sourceId,
  );
  if (!replaced) {
    throw new Error(
      `Source "${input.candidate.logicalPath}" disables a slot with no lower-precedence source.`,
    );
  }
  selected.delete(slot);
  return {
    composition: {
      entries: Object.freeze([
        ...input.composed.composition.entries,
        { kind: "disabled" as const, source: describeAgentSourceCandidate(input.candidate) },
      ]),
    },
    selected,
  };
}

export function createCompiledModuleBinding(
  candidate: AgentModuleCandidate,
): CompiledModuleBinding {
  return Object.freeze({
    backing: candidate.backing,
    logicalPath: candidate.logicalPath,
    owner: candidate.owner,
  });
}

export async function loadProgrammaticModuleNamespace(input: {
  readonly backing: Extract<AgentModuleBacking, { readonly kind: "programmatic" }>;
  readonly dependencyNamespaces?: Readonly<Record<string, ProgrammaticModuleNamespace>>;
  readonly registries: readonly AgentSourceRegistry[];
}): Promise<ProgrammaticModuleNamespace> {
  const matchingSources = input.registries
    .map((registry) => registry.sources.get(input.backing.registryId))
    .filter((source): source is ProgrammaticAgentSource => source !== undefined);
  if (matchingSources.length !== 1) {
    throw new Error(
      `Expected exactly one registered programmatic source "${input.backing.registryId}", found ${matchingSources.length}.`,
    );
  }
  const source = matchingSources[0]!;
  if (source.revision !== input.backing.revision) {
    throw new Error(
      `Programmatic source "${source.id}" revision mismatch: artifact requires "${input.backing.revision}", registry provides "${source.revision}".`,
    );
  }
  const module = source.modules.find(
    (candidate) => candidate.logicalPath === input.backing.moduleId,
  );
  if (module === undefined) {
    throw new Error(
      `Programmatic source "${source.id}" does not register module "${input.backing.moduleId}".`,
    );
  }
  if (module.semanticRevision !== input.backing.semanticRevision) {
    throw new Error(
      `Programmatic module "${source.id}:${module.logicalPath}" semantic revision does not match the compiled binding.`,
    );
  }
  const dependencies = Object.fromEntries(
    Object.entries(input.backing.dependencies ?? {}).map(([alias, sourceId]) => {
      const namespace = input.dependencyNamespaces?.[alias];
      if (namespace === undefined) {
        throw new Error(
          `Programmatic module "${source.id}:${module.logicalPath}" requires unresolved binding "${sourceId}" as dependency "${alias}".`,
        );
      }
      return [alias, namespace];
    }),
  );
  const namespace = await module.loadNamespace({
    dependencies: Object.freeze(dependencies),
    parameters: Object.freeze(input.backing.parameters ?? {}),
  });
  if (namespace === null || typeof namespace !== "object") {
    throw new Error(
      `Programmatic module "${source.id}:${module.logicalPath}" loader must return a module namespace object.`,
    );
  }
  return namespace;
}

export function canonicalModuleSlot(logicalPath: string): string {
  validateProgrammaticLogicalPath(logicalPath);
  return canonicalSourceSlot(logicalPath);
}

/**
 * Canonical composition slot for one logical path. Module extensions, folder
 * forms, and skill packages collapse onto the same authored primitive identity.
 */
export function canonicalSourceSlot(logicalPath: string): string {
  const normalized = normalizeLogicalPath(logicalPath);
  if (
    normalized.length === 0 ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    posix.normalize(normalized) !== normalized
  ) {
    throw new Error(`Agent source logical path "${logicalPath}" is invalid.`);
  }

  const withoutExtension = stripLogicalPathExtension(normalized);

  const connectionFolderMatch = withoutExtension.match(/^connections\/([^/]+)\/connection$/);
  if (connectionFolderMatch !== null) return `connections/${connectionFolderMatch[1]!}`;

  if (withoutExtension === "sandbox/sandbox") return "sandbox";

  const skillPackageMatch = withoutExtension.match(/^skills\/([^/]+)\/SKILL$/);
  if (skillPackageMatch !== null) return `skills/${skillPackageMatch[1]!}`;

  return withoutExtension;
}

export function validateProgrammaticLogicalPath(input: string): string {
  if (input.length === 0 || isAbsolute(input) || input.includes("\\")) {
    throw new Error(`Programmatic module logical path "${input}" must be a relative POSIX path.`);
  }
  const logicalPath = normalizeLogicalPath(input);
  if (
    logicalPath === "." ||
    logicalPath.startsWith("../") ||
    logicalPath.includes("/../") ||
    posix.normalize(logicalPath) !== logicalPath
  ) {
    throw new Error(`Programmatic module logical path "${input}" may not traverse directories.`);
  }
  const segments = logicalPath.split("/");
  const fileName = segments.at(-1)!;
  if (getSupportedModuleBaseName(fileName) === null) {
    throw new Error(
      `Programmatic module logical path "${input}" must use a supported JavaScript or TypeScript extension.`,
    );
  }
  const root = segments[0];
  const extensionless = stripLogicalPathExtension(logicalPath);
  const supported =
    (segments.length === 1 &&
      ["agent", "memory", "sandbox", "instrumentation"].includes(extensionless)) ||
    (root === "sandbox" &&
      segments.length === 2 &&
      getSupportedModuleBaseName(fileName) === "sandbox") ||
    ([
      "channels",
      "connections",
      "hooks",
      "instructions",
      "memory",
      "schedules",
      "skills",
      "tools",
    ].includes(root!) &&
      segments.length >= 2);
  if (!supported) {
    throw new Error(
      `Programmatic module logical path "${input}" does not select an eve module slot.`,
    );
  }
  return logicalPath;
}

export function describeAgentSourceCandidate(
  candidate: AgentSourceCandidate,
): AgentSourceDescriptor {
  return Object.freeze({
    backing: candidate.backing,
    form: candidate.form,
    layer: candidate.layer,
    logicalPath: candidate.logicalPath,
    owner: candidate.owner,
    sourceId: candidate.sourceId,
  });
}

function validateSelectedCandidateDependencies(
  selected: ReadonlyMap<string, AgentSourceCandidate>,
): void {
  const selectedSourceIds = new Set([...selected.values()].map((candidate) => candidate.sourceId));
  for (const candidate of selected.values()) {
    if (candidate.backing.kind !== "programmatic") continue;
    for (const sourceId of Object.values(candidate.backing.dependencies ?? {})) {
      if (!selectedSourceIds.has(sourceId)) {
        throw new Error(
          `Derived programmatic source "${candidate.sourceId}" depends on unselected source "${sourceId}".`,
        );
      }
    }
  }
}

function expectNonEmpty(value: string, label: string): string {
  if (value.trim().length === 0) throw new Error(`${label} must be non-empty.`);
  return value;
}
