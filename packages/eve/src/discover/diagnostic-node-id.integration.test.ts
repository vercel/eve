import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/compiled-agent-node-id.js";
import { discoverAgent } from "#discover/discover-agent.js";
import { DISCOVER_TOOL_NAME_INVALID } from "#discover/grammar.js";
import { createMemoryProjectSource } from "#discover/project-source.js";

describe("discovery diagnostic node ownership", () => {
  it("distinguishes the same invalid source slot on root and child nodes", async () => {
    const appRoot = resolve("/app");
    const agentRoot = join(appRoot, "agent");
    const result = await discoverAgent({
      agentRoot,
      appRoot,
      source: createMemoryProjectSource({
        files: {
          [join(agentRoot, "instructions.md")]: "Root instructions.",
          [join(agentRoot, "subagents", "child", "agent.ts")]: "export default {};",
          [join(agentRoot, "subagents", "child", "tools", "1invalid.ts")]: "export default {};",
          [join(agentRoot, "tools", "1invalid.ts")]: "export default {};",
        },
      }),
    });

    expect(
      result.diagnostics
        .filter((diagnostic) => diagnostic.code === DISCOVER_TOOL_NAME_INVALID)
        .map((diagnostic) => ({ nodeId: diagnostic.nodeId, sourcePath: diagnostic.sourcePath })),
    ).toEqual([
      {
        nodeId: ROOT_COMPILED_AGENT_NODE_ID,
        sourcePath: join(agentRoot, "tools", "1invalid.ts"),
      },
      {
        nodeId: "subagents/child",
        sourcePath: join(agentRoot, "subagents", "child", "tools", "1invalid.ts"),
      },
    ]);
  });
});
