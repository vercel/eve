import { describe, expect, it } from "vitest";

import { RuntimeRegistryError } from "../src/internal/runtime-registry.js";
import { createRuntimeToolRegistry } from "../src/runtime/tools/registry.js";
import type { ResolvedToolDefinition } from "../src/runtime/types.js";

describe("createRuntimeToolRegistry", () => {
  it("lowers authored tool schemas into serializable runtime descriptors", async () => {
    const registry = await createRuntimeToolRegistry({
      tools: [
        createResolvedToolDefinition({
          description: "Get the current weather for one city.",
          inputSchema: {
            properties: {
              city: {
                type: "string",
              },
            },
            required: ["city"],
            type: "object",
          },
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
  readonly description?: string;
  readonly inputSchema?: ResolvedToolDefinition["inputSchema"];
  readonly logicalPath: string;
  readonly name: string;
  readonly sourceId: string;
}): ResolvedToolDefinition {
  return {
    inputSchema: input.inputSchema ?? null,
    description: input.description ?? "Get the weather.",
    execute(inputValue: unknown) {
      return inputValue;
    },
    logicalPath: input.logicalPath,
    name: input.name,
    sourceId: input.sourceId,
    sourceKind: "module",
  };
}
