import {
  loadProgrammaticModuleNamespace,
  memoizeModuleNamespaceFactories,
  type AgentModuleBacking,
  type ProgrammaticModuleNamespace,
} from "#compiler/source-graph.js";
import { getDevelopmentExtensionSourceRegistry } from "#compiler/development-extensions.js";
import { frameworkAgentSourceRegistry } from "#framework/sources/registry.js";

/** Loads framework and development-extension programmatic modules for local dev maps. */
export async function loadFrameworkProgrammaticModule(
  backing: Extract<AgentModuleBacking, { readonly kind: "programmatic" }>,
): Promise<ProgrammaticModuleNamespace> {
  return memoizeModuleNamespaceFactories(
    await loadProgrammaticModuleNamespace({
      backing,
      registries: [frameworkAgentSourceRegistry, getDevelopmentExtensionSourceRegistry()],
    }),
  );
}

export { memoizeModuleNamespaceFactories } from "#compiler/source-graph.js";
export { interopAuthoredModuleNamespace } from "#internal/authored-module.js";
