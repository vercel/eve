import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import {
  createAgentSourceRegistry,
  defineProgrammaticAgentSource,
  loadProgrammaticModuleNamespace,
  type AgentSourceRegistry,
  type AgentModuleBacking,
  type ProgrammaticModuleNamespace,
} from "#compiler/source-graph.js";

const revision = `eve@${resolveInstalledPackageInfo().version}:compiled-manifest-v42`;

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
      loadNamespace: () => import("#framework/sources/modules/bash.js"),
    },
    {
      logicalPath: "tools/read_file.ts",
      loadNamespace: () => import("#framework/sources/modules/read-file.js"),
    },
    {
      logicalPath: "tools/write_file.ts",
      loadNamespace: () => import("#framework/sources/modules/write-file.js"),
    },
    {
      logicalPath: "tools/todo.ts",
      loadNamespace: () => import("#framework/sources/modules/todo.js"),
    },
    {
      logicalPath: "tools/web_fetch.ts",
      loadNamespace: () => import("#framework/sources/modules/web-fetch.js"),
    },
    {
      logicalPath: "tools/load_skill.ts",
      loadNamespace: () => import("#framework/sources/modules/load-skill.js"),
    },
    {
      logicalPath: "tools/connection_search.ts",
      loadNamespace: () => import("#framework/sources/modules/connection-search.js"),
    },
    {
      logicalPath: "tools/ask_question.ts",
      loadNamespace: () => import("#framework/sources/modules/ask-question.js"),
    },
    {
      logicalPath: "tools/web_search.ts",
      loadNamespace: () => import("#framework/sources/modules/web-search.js"),
    },
  ],
});

const rootDefaults = defineProgrammaticAgentSource({
  id: "eve:root-defaults",
  revision,
  modules: [
    {
      logicalPath: "tools/agent.ts",
      loadNamespace: () => import("#framework/sources/modules/agent-tool.js"),
    },
    {
      logicalPath: "tools/task_update.ts",
      loadNamespace: () => import("#framework/sources/modules/task-update.js"),
    },
    {
      logicalPath: "tools/task_cancel.ts",
      loadNamespace: () => import("#framework/sources/modules/task-cancel.js"),
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
  return await loadProgrammaticModuleNamespace({
    backing,
    registries: [frameworkAgentSourceRegistry],
  });
}
