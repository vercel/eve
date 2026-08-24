import type { AgentSourceRegistry } from "#compiler/agent-source-registry.js";
import { loadProgrammaticModuleNamespace } from "#compiler/agent-source-registry.js";
import type { CompiledExternalDependencyPlanSession } from "#compiler/external-dependency-plan.js";
import { externalDependencyPlanPackageNames } from "#compiler/external-dependency-package-names.js";
import type { CompiledModuleBacking } from "#compiler/module-binding.js";
import { loadAuthoredModuleNamespace } from "#internal/authored-module-loader.js";

export interface AgentModuleNamespaceLoadOptions {
  readonly captureExternalDependencyWitnesses?: boolean;
}

export interface AgentModuleNamespaceLoader {
  load(
    backing: CompiledModuleBacking,
    options?: AgentModuleNamespaceLoadOptions,
  ): Promise<Record<string, unknown>>;
  verifyExternalDependencies?(): Promise<void>;
}

export function createAgentModuleNamespaceLoader(
  input: {
    readonly externalDependencyPlanSession?: CompiledExternalDependencyPlanSession;
    readonly registry?: AgentSourceRegistry;
  } = {},
): AgentModuleNamespaceLoader {
  return {
    async load(backing, options) {
      if (backing.kind === "filesystem") {
        const externalDependencies = externalDependencyPlanPackageNames(
          backing.externalDependencies,
        );
        if (externalDependencies.length > 0 && input.externalDependencyPlanSession === undefined) {
          throw new Error(
            `Filesystem module binding "${backing.sourcePath}" requires the compiler-selected external dependency plan.`,
          );
        }
        return await loadAuthoredModuleNamespace(backing.sourcePath, {
          externalDependencies: backing.externalDependencies,
          externalDependencyPlan: input.externalDependencyPlanSession?.planFor(
            externalDependencies,
          ) ?? { entries: [] },
          externalDependencyPlanSession: input.externalDependencyPlanSession,
          extensionScopeNamespace: backing.extensionScope?.namespace,
          captureExternalDependencyWitnesses: options?.captureExternalDependencyWitnesses === true,
        });
      }

      if (input.registry === undefined) {
        throw new Error(
          `Programmatic module binding "${backing.registryId}:${backing.moduleId}" requires its agent source registry.`,
        );
      }
      return { ...(await loadProgrammaticModuleNamespace(input.registry, backing)) };
    },
    async verifyExternalDependencies() {
      await input.externalDependencyPlanSession?.verify();
    },
  };
}
