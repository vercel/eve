import { describe, expect, it } from "vitest";

import {
  createRuntimeSubagentRegistry,
  SUBAGENT_TOOL_INPUT_SCHEMA,
} from "#runtime/subagents/registry.js";
import type { ResolvedRuntimeSubagentNode } from "#runtime/types.js";

describe("createRuntimeSubagentRegistry", () => {
  it("lowers the default tool input schema when the definition declares none", () => {
    const registry = createRuntimeSubagentRegistry({
      subagents: [createSubagentNode()],
    });

    expect(registry.preparedTools[0]?.inputSchema).toBe(SUBAGENT_TOOL_INPUT_SCHEMA);
  });

  it("lowers a definition-level inputSchema onto the prepared tool", () => {
    const inputSchema = {
      properties: { city: { type: "string" } },
      required: ["city"],
      type: "object",
    };
    const registry = createRuntimeSubagentRegistry({
      subagents: [{ ...createSubagentNode(), inputSchema }],
    });

    expect(registry.preparedTools[0]?.inputSchema).toEqual(inputSchema);
  });
});

function createSubagentNode(): ResolvedRuntimeSubagentNode {
  return {
    description: "Performs research.",
    kind: "subagent",
    logicalPath: "subagents/research",
    name: "research",
    nodeId: "subagents/research",
    sourceId: "subagents/research",
    sourceKind: "module",
  };
}
