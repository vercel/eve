import { describe, expect, it } from "vitest";

import { RuntimeRegistryError } from "../src/internal/runtime-registry.js";
import { createRuntimeSubagentRegistry } from "../src/runtime/subagents/registry.js";
import type { ResolvedRuntimeSubagentNode } from "../src/runtime/types.js";

const SUBAGENT_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    message: {
      type: "string",
      description:
        "The message to send to the subagent. Provide all context the subagent needs to complete the task; the subagent does not see the parent's history.",
    },
  },
  required: ["message"],
  additionalProperties: false,
} as const;

describe("createRuntimeSubagentRegistry", () => {
  it("lowers local subagent inputs into serializable model-visible tools with a uniform message schema", () => {
    const registry = createRuntimeSubagentRegistry({
      subagents: [
        createResolvedRuntimeSubagentNode({
          description: "Investigate one task in depth.",
          logicalPath: "subagents/researcher",
          name: "researcher",
          nodeId: "subagents/researcher",
          sourceId: "subagents/researcher",
        }),
        createResolvedRuntimeSubagentNode({
          description: "Review one draft for clarity.",
          logicalPath: "subagents/reviewer",
          name: "reviewer",
          nodeId: "subagents/reviewer",
          sourceId: "subagents/reviewer",
        }),
      ],
    });

    expect(registry.preparedTools).toMatchObject([
      {
        description: "Investigate one task in depth.",
        inputSchema: SUBAGENT_TOOL_INPUT_SCHEMA,
        kind: "subagent",
        logicalPath: "subagents/researcher",
        name: "researcher",
        nodeId: "subagents/researcher",
        sourceId: "subagents/researcher",
      },
      {
        description: "Review one draft for clarity.",
        inputSchema: SUBAGENT_TOOL_INPUT_SCHEMA,
        kind: "subagent",
        logicalPath: "subagents/reviewer",
        name: "reviewer",
        nodeId: "subagents/reviewer",
        sourceId: "subagents/reviewer",
      },
    ]);
  });

  it("rejects subagent names that collide with another runtime-visible tool", () => {
    expect(() =>
      createRuntimeSubagentRegistry({
        reservedToolNames: ["researcher"],
        subagents: [
          createResolvedRuntimeSubagentNode({
            description: "Investigate one task in depth.",
            logicalPath: "subagents/researcher",
            name: "researcher",
            nodeId: "subagents/researcher",
            sourceId: "subagents/researcher",
          }),
        ],
      }),
    ).toThrowError(RuntimeRegistryError);
  });
});

function createResolvedRuntimeSubagentNode(input: {
  readonly description: string;
  readonly logicalPath: string;
  readonly name: string;
  readonly nodeId: string;
  readonly sourceId: string;
}): ResolvedRuntimeSubagentNode {
  return {
    description: input.description,
    kind: "subagent",
    logicalPath: input.logicalPath,
    name: input.name,
    nodeId: input.nodeId,
    sourceId: input.sourceId,
    sourceKind: "module",
  };
}
