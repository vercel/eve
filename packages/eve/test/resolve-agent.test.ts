import { asSchema } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "#compiled/zod/index.js";

import { compileFromMemory } from "../src/compiler/compile-from-memory.js";
import { defineTool } from "../src/tools/definition.js";
import { ResolveAgentError, resolveAgent } from "../src/runtime/resolve-agent.js";
import { serializeInputSchema } from "../src/tools/schema.js";

describe("resolveAgent", () => {
  it("hydrates the effective compiled graph and reattaches tool execution", async () => {
    const execute = (input: { city: string }) => input;
    const { manifest, moduleMap } = await compileFromMemory({
      model: "openai/gpt-5.4",
      name: "weather-agent",
      skills: [{ description: "Use weather data.", name: "weather" }],
      tools: [
        {
          description: "Get the current weather for a city.",
          execute,
          inputSchema: {
            properties: { city: { type: "string" } },
            required: ["city"],
            type: "object",
          },
          name: "get_weather",
        },
      ],
    });

    const resolved = await resolveAgent({ manifest, moduleMap });
    const weather = resolved.tools.find((tool) => tool.name === "get_weather");

    expect(resolved.config).toMatchObject({
      model: { id: "openai/gpt-5.4" },
      name: "weather-agent",
    });
    expect(resolved.channels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "GET", urlPath: "/eve/v1/health" }),
        expect.objectContaining({ method: "GET", urlPath: "/eve/v1/info" }),
      ]),
    );
    expect(resolved.sandbox).toMatchObject({
      backend: expect.objectContaining({ create: expect.any(Function), name: expect.any(String) }),
      logicalPath: "sandbox.ts",
    });
    expect(resolved.skills).toContainEqual(
      expect.objectContaining({ description: "Use weather data.", name: "weather" }),
    );
    expect(weather).toMatchObject({
      description: "Get the current weather for a city.",
      owner: { kind: "application" },
    });
    expect(serializeInputSchema(weather!.inputSchema!)).toMatchObject({
      properties: { city: { type: "string" } },
      required: ["city"],
      type: "object",
    });
    expect(
      weather?.execute?.({ city: "Brooklyn" }, { messages: [], toolCallId: "call_1" }),
    ).toEqual({ city: "Brooklyn" });
  });

  it("retains live standard-schema validators from programmatic sources", async () => {
    const schema = z.object({
      maxRows: z.number().int().positive().default(200),
      sql: z.string().default("SELECT 1"),
    });
    const { manifest, moduleMap } = await compileFromMemory({
      model: "openai/gpt-5.4",
      modules: [
        {
          loadNamespace: async () => ({
            default: defineTool({
              description: "Execute a query.",
              execute: (input) => input,
              inputSchema: schema,
            }),
          }),
          logicalPath: "tools/query.ts",
        },
      ],
    });

    const resolved = await resolveAgent({ manifest, moduleMap });
    const query = resolved.tools.find((tool) => tool.name === "query");
    const result = await asSchema(query!.inputSchema!).validate!({});

    expect(result).toEqual({ success: true, value: { maxRows: 200, sql: "SELECT 1" } });
  });

  it("rejects an invalid live export for a compiled executable tool", async () => {
    const { manifest, moduleMap } = await compileFromMemory({
      model: "openai/gpt-5.4",
      tools: [{ name: "weather" }],
    });
    const weather = manifest.tools.find((tool) => tool.name === "weather")!;
    const root = moduleMap.nodes.__root__!;
    const invalidMap = {
      nodes: {
        ...moduleMap.nodes,
        __root__: {
          modules: {
            ...root.modules,
            [weather.sourceId]: { default: { description: "Missing execute." } },
          },
        },
      },
    };

    await expect(resolveAgent({ manifest, moduleMap: invalidMap })).rejects.toBeInstanceOf(
      ResolveAgentError,
    );
  });
});
