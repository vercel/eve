import {
  createAgentSourceRegistry,
  defineProgrammaticAgentSource,
  loadProgrammaticModuleNamespace,
  type AgentSourceRegistry,
  type ProgrammaticModuleNamespace,
} from "#compiler/source-graph.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";

/**
 * Stable semantic revision for the framework default sandbox. Pinned so
 * unrelated eve releases do not change the selected sandbox backing
 * identity and discard durable sandbox state.
 */
const FRAMEWORK_DEFAULT_SANDBOX_REVISION = "eve-default-sandbox-v1";

/** Source id of the framework defaults registered for every local node. */
export const FRAMEWORK_NODE_SOURCE_ID = "eve";

/** Source id of the framework defaults registered for the root node only. */
export const FRAMEWORK_ROOT_SOURCE_ID = "eve-root";

let cachedRegistry: AgentSourceRegistry | undefined;

/**
 * The closed internal framework source registration. Modules contain only
 * literal dynamic imports inside their namespace loaders, so a shadowed
 * framework default never executes during compilation or cold-start
 * hydration. The `agent.ts` entry is the narrow exception allowed to
 * provide the default config slot for every already-discovered local node —
 * config composes in phase one against known nodes, so it can never expand
 * the graph it composes into.
 */
export function getFrameworkAgentSourceRegistry(): AgentSourceRegistry {
  if (cachedRegistry !== undefined) {
    return cachedRegistry;
  }

  const revision = resolveInstalledPackageInfo().version;

  const nodeDefaults = defineProgrammaticAgentSource({
    id: FRAMEWORK_NODE_SOURCE_ID,
    revision,
    modules: [
      {
        logicalPath: "agent.ts",
        loadNamespace: () => import("#public/definitions/default-agent-config.js"),
      },
      {
        logicalPath: "sandbox.ts",
        loadNamespace: () => import("#public/sandbox/default-sandbox-definition.js"),
        semanticRevision: FRAMEWORK_DEFAULT_SANDBOX_REVISION,
      },
      { logicalPath: "tools/bash.ts", loadNamespace: () => import("#public/tools/bash.js") },
      {
        logicalPath: "tools/read_file.ts",
        loadNamespace: () => import("#public/tools/read-file.js"),
      },
      {
        logicalPath: "tools/write_file.ts",
        loadNamespace: () => import("#public/tools/write-file.js"),
      },
      { logicalPath: "tools/todo.ts", loadNamespace: () => import("#public/tools/todo.js") },
      {
        logicalPath: "tools/web_fetch.ts",
        loadNamespace: () => import("#public/tools/web-fetch.js"),
      },
      {
        logicalPath: "tools/load_skill.ts",
        loadNamespace: () => import("#public/tools/load-skill.js"),
      },
      {
        logicalPath: "tools/connection_search.ts",
        loadNamespace: () => import("#runtime/framework-tools/connection-search-dynamic.js"),
      },
      {
        logicalPath: "tools/ask_question.ts",
        loadNamespace: () => import("#public/tools/ask-question.js"),
      },
      {
        logicalPath: "tools/web_search.ts",
        loadNamespace: () => import("#public/tools/web-search-default.js"),
      },
    ],
  });

  const rootDefaults = defineProgrammaticAgentSource({
    id: FRAMEWORK_ROOT_SOURCE_ID,
    revision,
    modules: [
      { logicalPath: "tools/agent.ts", loadNamespace: () => import("#public/tools/agent.js") },
      {
        logicalPath: "tools/task_update.ts",
        loadNamespace: () => import("#public/tools/task-update.js"),
      },
      {
        logicalPath: "tools/task_cancel.ts",
        loadNamespace: () => import("#public/tools/task-cancel.js"),
      },
      {
        logicalPath: "channels/eve.ts",
        loadNamespace: () => import("#runtime/framework-channels/eve-default.js"),
      },
      { logicalPath: "channels/home.ts", loadNamespace: () => import("#public/channels/home.js") },
    ],
  });

  cachedRegistry = createAgentSourceRegistry(
    [
      { applyTo: "all-local-nodes", source: nodeDefaults },
      { applyTo: "root", source: rootDefaults },
    ],
    { allowFrameworkSlots: true },
  );

  return cachedRegistry;
}

/**
 * Loads one selected framework module namespace for a compiled programmatic
 * binding. Generated module maps import this function so their registry
 * lookups stay statically reachable, and it rejects a revision mismatch
 * before evaluating any namespace loader.
 */
export async function loadFrameworkSourceModuleNamespace(
  registryId: string,
  moduleId: string,
  revision: string,
): Promise<ProgrammaticModuleNamespace> {
  return await loadProgrammaticModuleNamespace(getFrameworkAgentSourceRegistry(), {
    kind: "programmatic",
    moduleId,
    registryId,
    revision,
  });
}
