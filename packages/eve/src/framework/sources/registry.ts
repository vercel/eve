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

const revision = `eve@${resolveInstalledPackageInfo().version}:compiled-manifest-v43`;

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
      logicalPath: "tools/todo.ts",
      loadNamespace: () => import("#tools/provided/todo.js"),
    },
    {
      logicalPath: "tools/web_fetch.ts",
      loadNamespace: () => import("#tools/provided/web-fetch.js"),
    },
    {
      logicalPath: "tools/load_skill.ts",
      loadNamespace: () => import("#tools/provided/load-skill.js"),
    },
    {
      logicalPath: "tools/connection_search.ts",
      loadNamespace: () => import("#tools/framework/connection-search.js"),
    },
    {
      logicalPath: "tools/ask_question.ts",
      loadNamespace: () => import("#tools/framework/ask-question.js"),
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
      logicalPath: "tools/task_update.ts",
      loadNamespace: () => import("#tools/framework/task-update.js"),
    },
    {
      logicalPath: "tools/task_cancel.ts",
      loadNamespace: () => import("#tools/framework/task-cancel.js"),
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

const memoryWrapperTemplateSource = defineProgrammaticAgentSource({
  id: "eve:memory-wrapper",
  revision,
  modules: [
    {
      logicalPath: "tools/memory-wrapper.ts",
      loadNamespace: async (context) => {
        const { loadMemoryWrapperNamespace } =
          await import("#framework/sources/modules/memory-wrapper.js");
        return await loadMemoryWrapperNamespace(context);
      },
    },
  ],
});

export const frameworkAgentSourceRegistry: AgentSourceRegistry = createAgentSourceRegistry(
  [
    { applyTo: "all-local-nodes", source: localDefaults },
    { applyTo: "root", source: rootDefaults },
  ],
  { templates: [memoryWrapperTemplateSource] },
);

export const memoryWrapperTemplate = frameworkAgentSourceRegistry.templates.get(
  memoryWrapperTemplateSource.id,
)!;

export async function loadFrameworkProgrammaticModule(
  backing: Extract<AgentModuleBacking, { readonly kind: "programmatic" }>,
  dependencyNamespaces?: Readonly<Record<string, ProgrammaticModuleNamespace>>,
): Promise<ProgrammaticModuleNamespace> {
  return memoizeModuleNamespaceFactories(
    await loadProgrammaticModuleNamespace({
      backing,
      dependencyNamespaces,
      registries: [frameworkAgentSourceRegistry],
    }),
  );
}
