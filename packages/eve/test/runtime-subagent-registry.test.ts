import { describe, expect, it } from "vitest";

import { RuntimeRegistryError } from "../src/internal/runtime-registry.js";
import {
  createRuntimeSubagentRegistry,
  PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA,
} from "../src/runtime/subagents/registry.js";
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
  it("accepts null as an omitted persistent agentId", () => {
    expect(
      PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA.parse({
        agentId: null,
        message: "Investigate this",
      }),
    ).toEqual({ agentId: null, message: "Investigate this" });
  });

  it("lowers local subagent inputs into serializable model-visible tools with a uniform messaging schema", () => {
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

  it("keeps structural subagent provenance separate from its dynamic config resolver", () => {
    const events = { "session.started": () => null };
    const registry = createRuntimeSubagentRegistry({
      subagents: [
        {
          dynamic: {
            eventNames: ["session.started"],
            events,
            exportName: "resolveResearcher",
            logicalPath: "subagents/researcher/agent.ts",
            sourceId: "config:researcher",
            sourceKind: "module",
          },
          kind: "subagent",
          logicalPath: "subagents/researcher",
          name: "researcher",
          nodeId: "subagents/researcher",
          sourceId: "source:researcher",
          sourceKind: "subagent",
        },
      ],
    });

    expect(registry.dynamicResolvers).toEqual([
      {
        eventNames: ["session.started"],
        events,
        exportName: "resolveResearcher",
        kind: "subagent",
        logicalPath: "subagents/researcher/agent.ts",
        name: "researcher",
        nodeId: "subagents/researcher",
        sourceId: "config:researcher",
        sourceKind: "module",
        subagentSource: {
          logicalPath: "subagents/researcher",
          sourceId: "source:researcher",
          sourceKind: "subagent",
        },
      },
    ]);
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
    sourceKind: "subagent",
  };
}
