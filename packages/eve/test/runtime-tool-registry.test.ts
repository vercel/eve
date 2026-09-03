import { describe, expect, it } from "vitest";

import { RuntimeRegistryError } from "../src/internal/runtime-registry.js";
import { subagentToolExecuteWorkflowReference } from "../src/runtime/subagents/workflow-reference.js";
import { createRuntimeToolRegistry } from "../src/runtime/tools/registry.js";
import type { ResolvedToolDefinition } from "../src/runtime/types.js";
import { toInputSchema } from "../src/tools/schema.js";

describe("createRuntimeToolRegistry", () => {
  it("lowers authored tool schemas into serializable runtime descriptors", async () => {
    const registry = await createRuntimeToolRegistry({
      tools: [
        createResolvedToolDefinition({
          description: "Get the current weather for one city.",
          inputSchema: toInputSchema({
            properties: {
              city: {
                type: "string",
              },
            },
            required: ["city"],
            type: "object",
          }),
          logicalPath: "tools/get-weather.ts",
          name: "get_weather",
          sourceId: "tools/get-weather.ts",
        }),
      ],
    });

    expect(registry.preparedTools).toHaveLength(1);
    expect(registry.preparedTools[0]).toMatchObject({
      description: "Get the current weather for one city.",
      logicalPath: "tools/get-weather.ts",
      name: "get_weather",
      sourceId: "tools/get-weather.ts",
    });
    expect(registry.preparedTools[0]?.inputSchema).toMatchObject({
      properties: {
        city: {
          type: "string",
        },
      },
      required: ["city"],
      type: "object",
    });
  });

  it("carries task_update availability into the prepared tool descriptor", async () => {
    const registry = await createRuntimeToolRegistry({
      tools: [
        createResolvedToolDefinition({
          behavior: {
            availability: ["delegated-task-child"],
            handling: { action: "task-update", kind: "dispatch" },
          },
          logicalPath: "tools/task_update.ts",
          name: "task_update",
          sourceId: "framework:tools/task_update.ts",
        }),
      ],
    });

    expect(registry.preparedTools[0]?.behavior).toEqual({
      availability: ["delegated-task-child"],
      handling: { kind: "dispatch", target: { kind: "task-update" } },
      presentation: undefined,
    });
  });

  it("keeps authored workflow execution metadata grouped", async () => {
    const workflowId = "workflow//./agent/tools/deploy//execute";
    const registry = await createRuntimeToolRegistry({
      tools: [
        createResolvedToolDefinition({
          behavior: {
            availability: [],
            handling: { kind: "workflow-tool", workflowId },
          },
          logicalPath: "tools/deploy.ts",
          name: "deploy",
          sourceId: "tools/deploy.ts",
        }),
      ],
    });

    expect(registry.preparedTools[0]).toMatchObject({
      behavior: {
        handling: { kind: "dispatch", target: { kind: "workflow-tool-call", workflowId } },
      },
    });
    expect(registry.preparedTools[0]?.task).toEqual({ workflowId });
    expect(registry.preparedTools[0]).not.toHaveProperty("workflowId");
    expect(registry.preparedTools[0]).not.toHaveProperty("nodeId");
    expect(registry.preparedTools[0]).not.toHaveProperty("resultKind");
  });

  it("uses the shared stable workflow for the framework agent tool", async () => {
    const registry = await createRuntimeToolRegistry({
      tools: [
        createResolvedToolDefinition({
          behavior: {
            availability: [],
            handling: {
              kind: "workflow-tool",
              workflowId: "workflow//./agent/tools/agent//execute",
            },
          },
          logicalPath: "tools/agent.ts",
          name: "agent",
          owner: { feature: "root-defaults", kind: "framework" },
          sourceId: "eve:root-defaults:tools/agent.ts",
        }),
      ],
    });

    const prepared = registry.preparedTools[0];
    expect(subagentToolExecuteWorkflowReference.workflowId).toMatch(
      /^workflow\/\/[^/]+\/\/subagentToolExecuteWorkflow$/,
    );
    expect(prepared?.task).toEqual({
      nodeId: "__root__",
      resultKind: "subagent",
      workflowId: subagentToolExecuteWorkflowReference.workflowId,
    });
    expect(prepared?.behavior?.handling).toEqual({
      kind: "dispatch",
      target: {
        kind: "workflow-tool-call",
        workflowId: subagentToolExecuteWorkflowReference.workflowId,
      },
    });
  });

  it("rejects duplicate authored tool names", async () => {
    await expect(
      createRuntimeToolRegistry({
        tools: [
          createResolvedToolDefinition({
            logicalPath: "tools/first.ts",
            name: "get_weather",
            sourceId: "tools/first.ts",
          }),
          createResolvedToolDefinition({
            logicalPath: "tools/second.ts",
            name: "get_weather",
            sourceId: "tools/second.ts",
          }),
        ],
      }),
    ).rejects.toBeInstanceOf(RuntimeRegistryError);
  });

  it("rejects authored tool names that collide with reserved runtime tools", async () => {
    await expect(
      createRuntimeToolRegistry(
        {
          tools: [
            createResolvedToolDefinition({
              logicalPath: "tools/load-skill.ts",
              name: "load_skill",
              sourceId: "tools/load-skill.ts",
            }),
          ],
        },
        {
          reservedToolNames: ["load_skill"],
        },
      ),
    ).rejects.toBeInstanceOf(RuntimeRegistryError);
  });
});

function createResolvedToolDefinition(input: {
  readonly behavior?: ResolvedToolDefinition["behavior"];
  readonly description?: string;
  readonly inputSchema?: ResolvedToolDefinition["inputSchema"];
  readonly logicalPath: string;
  readonly name: string;
  readonly owner?: ResolvedToolDefinition["owner"];
  readonly sourceId: string;
}): ResolvedToolDefinition {
  return {
    behavior: input.behavior,
    inputSchema: input.inputSchema ?? null,
    description: input.description ?? "Get the weather.",
    execute(inputValue: unknown) {
      return inputValue;
    },
    logicalPath: input.logicalPath,
    name: input.name,
    owner: input.owner ?? { kind: "application" },
    sourceId: input.sourceId,
    sourceKind: "module",
  };
}
