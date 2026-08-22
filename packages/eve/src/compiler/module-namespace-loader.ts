import type { AgentSourceRegistry } from "#compiler/agent-source-registry.js";
import { getProgrammaticModuleNamespace } from "#compiler/agent-source-registry.js";
import type { CompiledModuleBacking } from "#compiler/module-binding.js";
import { loadAuthoredModuleNamespace } from "#internal/authored-module-loader.js";

export interface AgentModuleNamespaceLoader {
  load(backing: CompiledModuleBacking): Promise<Record<string, unknown>>;
}

export function createAgentModuleNamespaceLoader(
  input: {
    readonly registry?: AgentSourceRegistry;
  } = {},
): AgentModuleNamespaceLoader {
  return {
    async load(backing) {
      if (backing.kind === "filesystem") {
        return await loadAuthoredModuleNamespace(backing.sourcePath, {
          externalDependencies: backing.externalDependencies,
          extensionScopeNamespace: backing.extensionScope?.namespace,
        });
      }

      if (input.registry === undefined) {
        throw new Error(
          `Programmatic module binding "${backing.registryId}:${backing.moduleId}" requires its agent source registry.`,
        );
      }
      return { ...getProgrammaticModuleNamespace(input.registry, backing) };
    },
  };
}
