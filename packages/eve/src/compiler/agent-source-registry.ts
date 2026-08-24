import type { AgentSourceOwner, CompiledModuleBacking } from "#compiler/module-binding.js";
import type { AgentSourceLayer } from "#compiler/source-composition.js";
import type {
  ProgrammaticAgentModule,
  ProgrammaticAgentSource,
  ProgrammaticModuleNamespace,
} from "#compiler/programmatic-agent-source.js";

const AGENT_SOURCE_REGISTRY = Symbol("eve.agent-source-registry");

export interface AgentSourceRegistration {
  readonly applyTo: "root" | "all-local-nodes";
  readonly source: ProgrammaticAgentSource;
}

export type RegisteredAgentSource = AgentSourceRegistration &
  (
    | {
        readonly layer: Extract<AgentSourceLayer, "application">;
        readonly owner: Extract<AgentSourceOwner, { kind: "application" }>;
      }
    | {
        readonly layer: Extract<AgentSourceLayer, "framework-default">;
        readonly owner: Extract<AgentSourceOwner, { kind: "framework" }>;
      }
  );

export interface AgentSourceRegistry {
  readonly [AGENT_SOURCE_REGISTRY]: true;
  readonly registrations: readonly RegisteredAgentSource[];
  validateModules(
    backings: readonly Extract<CompiledModuleBacking, { kind: "programmatic" }>[],
  ): void;
  loadModule(
    backing: Extract<CompiledModuleBacking, { kind: "programmatic" }>,
  ): Promise<ProgrammaticModuleNamespace>;
}

/** Creates an application-owned registry without framework-only all-node privileges. */
export function createAgentSourceRegistry(
  registrations: readonly AgentSourceRegistration[],
): AgentSourceRegistry {
  return createRegistry(registrations, {
    provenance: () => ({ layer: "application", owner: { kind: "application" } }),
  });
}

/**
 * Creates eve's own source registry with one exact framework-owned all-node
 * default config candidate. Ordinary registries cannot opt into this privilege.
 */
export function createFrameworkAgentSourceRegistry(input: {
  readonly frameworkDefaultConfigSource: ProgrammaticAgentSource;
  readonly registrations: readonly AgentSourceRegistration[];
}): AgentSourceRegistry {
  if (
    !input.frameworkDefaultConfigSource.modules.some((module) => module.logicalPath === "agent.ts")
  ) {
    throw new Error('The framework default config source must declare exact module "agent.ts".');
  }
  if (
    !input.registrations.some(
      (registration) =>
        registration.applyTo === "all-local-nodes" &&
        registration.source === input.frameworkDefaultConfigSource,
    )
  ) {
    throw new Error("The framework default config source must be registered by identity.");
  }
  return createRegistry(input.registrations, {
    frameworkDefaultConfigSource: input.frameworkDefaultConfigSource,
    provenance: (registration) => ({
      layer: "framework-default",
      owner: { feature: registration.source.id, kind: "framework" },
    }),
  });
}

/** Combines immutable registries without changing their factory-owned provenance or privilege. */
export function composeAgentSourceRegistries(
  registries: readonly AgentSourceRegistry[],
): AgentSourceRegistry {
  const sourceRegistries = new Map<string, AgentSourceRegistry>();
  const registrations = registries.flatMap((registry) =>
    registry.registrations.map((registration) => {
      if (sourceRegistries.has(registration.source.id)) {
        throw new Error(
          `Programmatic agent source id "${registration.source.id}" is registered twice.`,
        );
      }
      sourceRegistries.set(registration.source.id, registry);
      return registration;
    }),
  );

  return Object.freeze({
    [AGENT_SOURCE_REGISTRY]: true as const,
    registrations: Object.freeze(registrations),
    validateModules(backings: readonly Extract<CompiledModuleBacking, { kind: "programmatic" }>[]) {
      const grouped = new Map<AgentSourceRegistry, (typeof backings)[number][]>();
      for (const backing of backings) {
        const registry = sourceRegistries.get(backing.registryId);
        if (registry === undefined) {
          throw new Error(
            `Programmatic module binding "${backing.registryId}:${backing.moduleId}" is not registered.`,
          );
        }
        const entries = grouped.get(registry) ?? [];
        entries.push(backing);
        grouped.set(registry, entries);
      }
      for (const [registry, entries] of grouped) registry.validateModules(entries);
    },
    async loadModule(backing: Extract<CompiledModuleBacking, { kind: "programmatic" }>) {
      const registry = sourceRegistries.get(backing.registryId);
      if (registry === undefined) {
        throw new Error(
          `Programmatic module binding "${backing.registryId}:${backing.moduleId}" is not registered.`,
        );
      }
      return await registry.loadModule(backing);
    },
  });
}

function createRegistry(
  registrations: readonly AgentSourceRegistration[],
  input: {
    readonly frameworkDefaultConfigSource?: ProgrammaticAgentSource;
    readonly provenance: (registration: AgentSourceRegistration) =>
      | {
          readonly layer: "application";
          readonly owner: Extract<AgentSourceOwner, { kind: "application" }>;
        }
      | {
          readonly layer: "framework-default";
          readonly owner: Extract<AgentSourceOwner, { kind: "framework" }>;
        };
  },
): AgentSourceRegistry {
  const sources = new Map<string, ReadonlyMap<string, ProgrammaticAgentModule>>();
  const revisions = new Map<string, string>();
  const namespaces = new Map<string, Promise<ProgrammaticModuleNamespace>>();
  const frozenRegistrations = registrations.map((registration): RegisteredAgentSource => {
    if (sources.has(registration.source.id)) {
      throw new Error(
        `Programmatic agent source id "${registration.source.id}" is registered twice.`,
      );
    }
    const structuralModule = registration.source.modules.find((module) =>
      isFilesystemStructuredModule(module.logicalPath),
    );
    if (structuralModule !== undefined) {
      throw new Error(
        `Programmatic source "${registration.source.id}" cannot register "${structuralModule.logicalPath}" because extension mounts and subagent trees require discovered structural source records.`,
      );
    }
    if (registration.applyTo === "all-local-nodes") {
      const recursiveModule = registration.source.modules.find(
        (module) =>
          isGraphOrHostExpandingModule(module.logicalPath) &&
          !(
            module.logicalPath === "agent.ts" &&
            registration.source === input.frameworkDefaultConfigSource
          ),
      );
      if (recursiveModule !== undefined) {
        throw new Error(
          `Programmatic source "${registration.source.id}" cannot apply "${recursiveModule.logicalPath}" to all local nodes because that slot can expand the graph or host surface.`,
        );
      }
    }
    const modules = new Map(
      registration.source.modules.map((module) => [module.logicalPath, module] as const),
    );
    sources.set(registration.source.id, modules);
    revisions.set(registration.source.id, registration.source.revision);
    const provenance = input.provenance(registration);
    if (provenance.layer === "application") {
      return Object.freeze({
        applyTo: registration.applyTo,
        layer: provenance.layer,
        owner: Object.freeze({ ...provenance.owner }),
        source: registration.source,
      });
    }
    return Object.freeze({
      applyTo: registration.applyTo,
      layer: provenance.layer,
      owner: Object.freeze({ ...provenance.owner }),
      source: registration.source,
    });
  });

  const validateModule = (
    backing: Extract<CompiledModuleBacking, { kind: "programmatic" }>,
  ): ProgrammaticAgentModule => {
    const module = sources.get(backing.registryId)?.get(backing.moduleId);
    if (module === undefined) {
      throw new Error(
        `Programmatic module binding "${backing.registryId}:${backing.moduleId}" is not registered.`,
      );
    }
    const registeredRevision = revisions.get(backing.registryId);
    if (registeredRevision !== backing.revision) {
      throw new Error(
        `Programmatic module binding "${backing.registryId}:${backing.moduleId}" requires revision "${backing.revision}", but the registered source provides "${registeredRevision ?? "none"}".`,
      );
    }
    if (module.semanticRevision !== backing.semanticRevision) {
      throw new Error(
        `Programmatic module binding "${backing.registryId}:${backing.moduleId}" requires semantic revision "${backing.semanticRevision ?? "none"}", but the registered module provides "${module.semanticRevision ?? "none"}".`,
      );
    }
    return module;
  };

  return Object.freeze({
    [AGENT_SOURCE_REGISTRY]: true as const,
    registrations: Object.freeze(frozenRegistrations),
    validateModules(backings: readonly Extract<CompiledModuleBacking, { kind: "programmatic" }>[]) {
      for (const backing of backings) validateModule(backing);
    },
    async loadModule(backing: Extract<CompiledModuleBacking, { kind: "programmatic" }>) {
      const module = validateModule(backing);
      const key = `${backing.registryId}\0${backing.moduleId}`;
      let namespace = namespaces.get(key);
      if (namespace === undefined) {
        namespace = Promise.resolve(module.loadNamespace()).then((value) =>
          Object.freeze({ ...value }),
        );
        namespaces.set(key, namespace);
      }
      return await namespace;
    },
  });
}

function isFilesystemStructuredModule(logicalPath: string): boolean {
  return /^(?:extensions|subagents)\//.test(logicalPath);
}

function isGraphOrHostExpandingModule(logicalPath: string): boolean {
  return /^(?:agent\.[^/]+|channels\/|instrumentation(?:\.|\/)|schedules\/)/.test(logicalPath);
}

export async function loadProgrammaticModuleNamespace(
  registry: AgentSourceRegistry,
  backing: Extract<CompiledModuleBacking, { kind: "programmatic" }>,
): Promise<ProgrammaticModuleNamespace> {
  return await registry.loadModule(backing);
}
