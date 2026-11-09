import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import {
  createAgentSourceRegistry,
  defineProgrammaticAgentSource,
  loadProgrammaticModuleNamespace,
  memoizeModuleNamespaceFactories,
  type AgentSourceRegistry,
  type AgentModuleBacking,
  type ProgrammaticModuleNamespace,
} from "#compiler/source-graph.js";

const revision = `eve@${resolveInstalledPackageInfo().version}:compiled-manifest-v54`;

const localDefaults = defineProgrammaticAgentSource({
  id: "eve:defaults",
  revision,
  modules: [
    { logicalPath: "agent.ts", loadNamespace: () => import("#framework/sources/modules/agent.js") },
    {
      logicalPath: "sandbox.ts",
      semanticRevision: "eve:default-sandbox:v1",
      loadNamespace: () => import("#framework/sources/modules/sandbox.js"),
    },
    {
      logicalPath: "tools/bash.ts",
      loadNamespace: () => import("#tools/provided/bash.js"),
    },
    {
      logicalPath: "tools/read_file.ts",
      loadNamespace: () => import("#tools/provided/read-file.js"),
    },
    {
      logicalPath: "tools/write_file.ts",
      loadNamespace: () => import("#tools/provided/write-file.js"),
    },
    {
      logicalPath: "tools/edit_file.ts",
      loadNamespace: () => import("#tools/provided/edit-file.js"),
    },
    {
      logicalPath: "tools/web_fetch.ts",
      loadNamespace: () => import("#tools/provided/web-fetch.js"),
    },
    {
      logicalPath: "tools/web_search.ts",
      loadNamespace: () => import("#tools/provided/web-search.js"),
    },
  ],
});

const rootDefaults = defineProgrammaticAgentSource({
  id: "eve:root-defaults",
  revision,
  modules: [
    {
      logicalPath: "tools/agent.ts",
      loadNamespace: () => import("#tools/framework/agent.js"),
    },
    {
      logicalPath: "channels/eve.ts",
      loadNamespace: () => import("#framework/sources/modules/eve-channel.js"),
    },
    {
      logicalPath: "channels/home.ts",
      loadNamespace: () => import("#framework/sources/modules/home-channel.js"),
    },
  ],
});

export const frameworkAgentSourceRegistry: AgentSourceRegistry = createAgentSourceRegistry([
  { applyTo: "all-local-nodes", source: localDefaults },
  { applyTo: "root", source: rootDefaults },
]);

export async function loadFrameworkProgrammaticModule(
  backing: Extract<AgentModuleBacking, { readonly kind: "programmatic" }>,
): Promise<ProgrammaticModuleNamespace> {
  return memoizeModuleNamespaceFactories(
    await loadProgrammaticModuleNamespace({ backing, registries: [frameworkAgentSourceRegistry] }),
  );
}
