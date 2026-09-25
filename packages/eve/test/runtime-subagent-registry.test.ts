import { describe, expect, it } from "vitest";

import { RuntimeRegistryError } from "../src/internal/runtime-registry.js";
import {
  createPreparedRuntimeSubagentTool,
  createRuntimeSubagentRegistry,
} from "../src/runtime/subagents/registry.js";
import { SUBAGENT_TOOL_INPUT_SCHEMA as subagentToolInputSchema } from "../src/tools/framework/agent-contract.js";
import type { ResolvedRuntimeSubagentNode } from "../src/runtime/types.js";
import { AGENT_TASK_WORKFLOW_ID } from "../src/tasks/agent-tool.js";

const SUBAGENT_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    taskId: {
      type: ["string", "null"],
      description:
        "Only to correct or continue a task this tool started: that task's id, from its receipt or the latest [Tasks] note. An idle task starts on this input; a working one uses it in its current work or starts on it right after. Omit it to start a new task.",
    },
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
  it("accepts null as an omitted taskId", () => {
    expect(
      subagentToolInputSchema["~standard"].validate({
        message: "Investigate this",
        taskId: null,
      }),
    ).toEqual({ value: { message: "Investigate this", taskId: null } });
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

  it("marks subagent tools as agent tasks the owner starts", () => {
    const definition = createResolvedRuntimeSubagentNode({
      description: "Investigate one task in depth.",
      logicalPath: "subagents/researcher",
      name: "researcher",
      nodeId: "subagents/researcher",
      sourceId: "subagents/researcher",
    });

    const prepared = createPreparedRuntimeSubagentTool(definition);

    expect(prepared).not.toHaveProperty("execution");
    expect(prepared.task).toEqual({
      nodeId: definition.nodeId,
      workflowId: AGENT_TASK_WORKFLOW_ID,
    });
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
