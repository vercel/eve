import type { CompiledModuleBacking } from "#compiler/module-binding.js";
import type {
  ProgrammaticAgentModule,
  ProgrammaticAgentSource,
  ProgrammaticModuleNamespace,
} from "#compiler/programmatic-agent-source.js";

export interface AgentSourceRegistration {
  readonly applyTo: "root" | "all-local-nodes";
  readonly source: ProgrammaticAgentSource;
}

export interface AgentSourceRegistry {
  readonly registrations: readonly AgentSourceRegistration[];
  getModule(
    backing: Extract<CompiledModuleBacking, { kind: "programmatic" }>,
  ): ProgrammaticAgentModule;
}

export function createAgentSourceRegistry(
  registrations: readonly AgentSourceRegistration[],
): AgentSourceRegistry {
  const sources = new Map<string, ReadonlyMap<string, ProgrammaticAgentModule>>();
  const frozenRegistrations = registrations.map((registration) => {
    if (sources.has(registration.source.id)) {
      throw new Error(
        `Programmatic agent source id "${registration.source.id}" is registered twice.`,
      );
    }
    if (registration.applyTo === "all-local-nodes") {
      const recursiveModule = registration.source.modules.find((module) =>
        /^(?:agent\.[^/]+|channels\/|extensions\/|schedules\/|subagents\/)/.test(
          module.logicalPath,
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
    return Object.freeze({ applyTo: registration.applyTo, source: registration.source });
  });

  return Object.freeze({
    registrations: Object.freeze(frozenRegistrations),
    getModule(backing: Extract<CompiledModuleBacking, { kind: "programmatic" }>) {
      const module = sources.get(backing.registryId)?.get(backing.moduleId);
      if (module === undefined) {
        throw new Error(
          `Programmatic module binding "${backing.registryId}:${backing.moduleId}" is not registered.`,
        );
      }
      return module;
    },
  });
}

export function getProgrammaticModuleNamespace(
  registry: AgentSourceRegistry,
  backing: Extract<CompiledModuleBacking, { kind: "programmatic" }>,
): ProgrammaticModuleNamespace {
  return registry.getModule(backing).namespace;
}
