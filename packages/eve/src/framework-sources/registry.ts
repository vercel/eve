import { createFrameworkAgentSourceRegistry } from "#compiler/agent-source-registry.js";
import { defineProgrammaticAgentSource } from "#compiler/programmatic-agent-source.js";
import { resolveFrameworkAgentSourceRevision } from "#framework-sources/revision.js";
import {
  FRAMEWORK_AGENT_SOURCE_ID,
  FRAMEWORK_DEFAULT_SANDBOX_SEMANTIC_REVISION,
  FRAMEWORK_ROOT_AGENT_SOURCE_ID,
} from "./constants.js";

function createFrameworkAgentSource(revision: string) {
  return defineProgrammaticAgentSource({
    id: FRAMEWORK_AGENT_SOURCE_ID,
    revision,
    modules: [
      { logicalPath: "agent.ts", loadNamespace: () => import("./agent.js") },
      {
        logicalPath: "sandbox.ts",
        loadNamespace: () => import("./sandbox.js"),
        semanticRevision: FRAMEWORK_DEFAULT_SANDBOX_SEMANTIC_REVISION,
      },
      { logicalPath: "tools/bash.ts", loadNamespace: () => import("./tools/bash.js") },
      {
        logicalPath: "tools/connection_search.ts",
        loadNamespace: () => import("./tools/connection_search.js"),
      },
      {
        logicalPath: "tools/load_skill.ts",
        loadNamespace: () => import("./tools/load_skill.js"),
      },
      {
        logicalPath: "tools/read_file.ts",
        loadNamespace: () => import("./tools/read_file.js"),
      },
      { logicalPath: "tools/todo.ts", loadNamespace: () => import("./tools/todo.js") },
      {
        logicalPath: "tools/web_fetch.ts",
        loadNamespace: () => import("./tools/web_fetch.js"),
      },
      {
        logicalPath: "tools/web_search.ts",
        loadNamespace: () => import("./tools/web_search.js"),
      },
      {
        logicalPath: "tools/write_file.ts",
        loadNamespace: () => import("./tools/write_file.js"),
      },
    ],
  });
}

function createFrameworkRootAgentSource(revision: string) {
  return defineProgrammaticAgentSource({
    id: FRAMEWORK_ROOT_AGENT_SOURCE_ID,
    revision,
    modules: [
      {
        logicalPath: "instrumentation.ts",
        loadNamespace: () => import("./instrumentation.js"),
      },
      {
        logicalPath: "instrumentation/agent-runs.ts",
        loadNamespace: () => import("./instrumentation/agent-runs.js"),
      },
      {
        logicalPath: "instrumentation/local.ts",
        loadNamespace: () => import("./instrumentation/local.js"),
      },
      {
        logicalPath: "channels/home.ts",
        loadNamespace: () => import("./channels/home.js"),
      },
      {
        logicalPath: "channels/eve/v1/health.ts",
        loadNamespace: () => import("./channels/eve/v1/health.js"),
      },
      { logicalPath: "channels/eve.ts", loadNamespace: () => import("./channels/eve.js") },
      {
        logicalPath: "channels/eve/v1/callback/post.ts",
        loadNamespace: () => import("./channels/eve/v1/callback/post.js"),
      },
      {
        logicalPath: "channels/eve/v1/connections/callback/get.ts",
        loadNamespace: () => import("./channels/eve/v1/connections/callback/get.js"),
      },
      {
        logicalPath: "channels/eve/v1/connections/callback/legacy/get.ts",
        loadNamespace: () => import("./channels/eve/v1/connections/callback/legacy/get.js"),
      },
      {
        logicalPath: "channels/eve/v1/connections/callback/legacy/post.ts",
        loadNamespace: () => import("./channels/eve/v1/connections/callback/legacy/post.js"),
      },
      {
        logicalPath: "channels/eve/v1/connections/callback/post.ts",
        loadNamespace: () => import("./channels/eve/v1/connections/callback/post.js"),
      },
      {
        logicalPath: "channels/eve/v1/task-input/post.ts",
        loadNamespace: () => import("./channels/eve/v1/task-input/post.js"),
      },
    ],
  });
}

const frameworkRevision = resolveFrameworkAgentSourceRevision();
const frameworkAgentSource = createFrameworkAgentSource(frameworkRevision);

export const frameworkAgentSourceRegistry = createFrameworkAgentSourceRegistry({
  frameworkDefaultConfigSource: frameworkAgentSource,
  registrations: [
    { applyTo: "all-local-nodes", source: frameworkAgentSource },
    { applyTo: "root", source: createFrameworkRootAgentSource(frameworkRevision) },
  ],
});
