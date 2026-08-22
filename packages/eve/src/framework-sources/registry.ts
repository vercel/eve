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
import { FRAMEWORK_AGENT_SOURCE_ID } from "./constants.js";

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

export const frameworkAgentSourceRegistry = createAgentSourceRegistry([
  { applyTo: "all-local-nodes", source: frameworkAgentSource },
]);
