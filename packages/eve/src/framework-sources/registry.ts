import * as bash from "./tools/bash.js";
import * as connectionSearch from "./tools/connection_search.js";
import * as loadSkill from "./tools/load_skill.js";
import * as readFile from "./tools/read_file.js";
import * as sandbox from "./sandbox.js";
import * as todo from "./tools/todo.js";
import * as webFetch from "./tools/web_fetch.js";
import * as webSearch from "./tools/web_search.js";
import * as writeFile from "./tools/write_file.js";
import { createAgentSourceRegistry } from "#compiler/agent-source-registry.js";
import { defineProgrammaticAgentSource } from "#compiler/programmatic-agent-source.js";
import { FRAMEWORK_AGENT_SOURCE_ID, FRAMEWORK_ROOT_AGENT_SOURCE_ID } from "./constants.js";

const frameworkAgentSource = defineProgrammaticAgentSource({
  id: FRAMEWORK_AGENT_SOURCE_ID,
  modules: [
    { logicalPath: "sandbox.ts", namespace: sandbox },
    { logicalPath: "tools/bash.ts", namespace: bash },
    { logicalPath: "tools/connection_search.ts", namespace: connectionSearch },
    { logicalPath: "tools/load_skill.ts", namespace: loadSkill },
    { logicalPath: "tools/read_file.ts", namespace: readFile },
    { logicalPath: "tools/todo.ts", namespace: todo },
    { logicalPath: "tools/web_fetch.ts", namespace: webFetch },
    { logicalPath: "tools/web_search.ts", namespace: webSearch },
    { logicalPath: "tools/write_file.ts", namespace: writeFile },
  ],
});

const frameworkRootAgentSource = defineProgrammaticAgentSource({
  id: FRAMEWORK_ROOT_AGENT_SOURCE_ID,
  modules: [
    { logicalPath: "channels/eve.ts", namespace: eveChannel },
    { logicalPath: "channels/eve/v1/callback/post.ts", namespace: sessionCallbackPost },
    {
      logicalPath: "channels/eve/v1/connections/callback/get.ts",
      namespace: connectionCallbackGet,
    },
    {
      logicalPath: "channels/eve/v1/connections/callback/legacy/get.ts",
      namespace: legacyConnectionCallbackGet,
    },
    {
      logicalPath: "channels/eve/v1/connections/callback/legacy/post.ts",
      namespace: legacyConnectionCallbackPost,
    },
    {
      logicalPath: "channels/eve/v1/connections/callback/post.ts",
      namespace: connectionCallbackPost,
    },
    { logicalPath: "channels/eve/v1/task-input/post.ts", namespace: taskInputPost },
  ],
});

export const frameworkAgentSourceRegistry = createAgentSourceRegistry([
  { applyTo: "all-local-nodes", source: frameworkAgentSource },
  { applyTo: "root", source: frameworkRootAgentSource },
]);
import * as eveChannel from "./channels/eve.js";
import * as sessionCallbackPost from "./channels/eve/v1/callback/post.js";
import * as connectionCallbackGet from "./channels/eve/v1/connections/callback/get.js";
import * as legacyConnectionCallbackGet from "./channels/eve/v1/connections/callback/legacy/get.js";
import * as legacyConnectionCallbackPost from "./channels/eve/v1/connections/callback/legacy/post.js";
import * as connectionCallbackPost from "./channels/eve/v1/connections/callback/post.js";
import * as taskInputPost from "./channels/eve/v1/task-input/post.js";
