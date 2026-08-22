import { describe, expect, it } from "vitest";

import {
  COMPILED_AGENT_MANIFEST_KIND,
  COMPILED_AGENT_MANIFEST_VERSION,
  compiledAgentManifestSchema,
  ROOT_COMPILED_AGENT_NODE_ID,
} from "#compiler/manifest.js";
import { compileFromMemory } from "#compiler/compile-from-memory.js";

describe("compileFromMemory", () => {
  it("produces a manifest and module map with minimal input", async () => {
    const { manifest, moduleMap } = await compileFromMemory({ model: "openai/gpt-5.4" });

    expect(manifest.kind).toBe(COMPILED_AGENT_MANIFEST_KIND);
    expect(manifest.version).toBe(COMPILED_AGENT_MANIFEST_VERSION);
    expect(manifest.config.name).toBe("memory-agent");
    expect(manifest.config.model?.id).toBe("openai/gpt-5.4");
    expect(manifest.tools.filter((tool) => tool.sourceId.startsWith("memory:"))).toEqual([]);
    expect(manifest.tools.length).toBeGreaterThan(0);
    expect(manifest.skills).toEqual([]);
    expect(manifest.subagents).toEqual([]);
    expect(
      Object.keys(moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]?.modules ?? {}).length,
    ).toBeGreaterThan(0);
  });

  it("honours descriptor overrides for name, model, and roots", async () => {
    const { manifest } = await compileFromMemory({
      name: "custom-agent",
      model: "mock/custom",
      appRoot: "/app",
      agentRoot: "/app/agent",
    });

    expect(manifest.config.name).toBe("custom-agent");
    expect(manifest.config.model?.id).toBe("mock/custom");
    expect(manifest.appRoot).toBe("/app");
    expect(manifest.agentRoot).toBe("/app/agent");
  });

  it("projects authored tools into the manifest and module map", async () => {
    const executeWeather = async () => ({ temperature: 72 });
    const { manifest, moduleMap } = await compileFromMemory({
      model: "openai/gpt-5.4",
      tools: [
        {
          name: "weather",
          description: "Gets the weather.",
          execute: executeWeather,
          inputSchema: { kind: "object" },
        },
        { name: "echo", outputSchema: { type: "string" } },
      ],
    });

    const authoredTools = manifest.tools.filter((tool) => tool.sourceId.startsWith("memory:"));
    expect(authoredTools).toHaveLength(2);
    const weather = authoredTools.find((tool) => tool.name === "weather");
    const echo = authoredTools.find((tool) => tool.name === "echo");
    if (weather === undefined || echo === undefined)
      throw new Error("Missing authored test tools.");
    expect(weather.name).toBe("weather");
    expect(weather.description).toBe("Gets the weather.");
    expect(weather.inputSchema).toEqual({ kind: "object" });
    expect(weather.logicalPath).toBe("tools/weather.ts");
    expect(echo.description).toBe("echo test tool.");
    expect(echo.outputSchema).toEqual({ type: "string" });

    const rootModules = moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]?.modules ?? {};
    expect(
      Object.keys(rootModules).filter((sourceId) => sourceId.startsWith("memory:")),
    ).toHaveLength(2);
    const weatherNamespace = rootModules[weather.sourceId];
    if (weatherNamespace === undefined) throw new Error("Missing weather module namespace.");
    expect(weatherNamespace.default).toMatchObject({
      description: "Gets the weather.",
    });
    expect((weatherNamespace.default as { execute?: unknown }).execute).toBe(executeWeather);
    expect(manifest.bindings[weather.sourceId]).toMatchObject({
      backing: {
        kind: "programmatic",
        moduleId: "tools/weather.ts",
        registryId: "eve-memory-application",
      },
      owner: { kind: "application" },
    });
    expect(rootModules["agent.ts"]?.default).toMatchObject({ model: "openai/gpt-5.4" });
  });

  it("projects ordinary skill modules into the manifest", async () => {
    const { manifest } = await compileFromMemory({
      model: "openai/gpt-5.4",
      skills: [{ name: "greetings", description: "Say hi", markdown: "# greet\n" }],
    });

    expect(manifest.skills).toHaveLength(1);
    const [skill] = manifest.skills;
    expect(skill?.name).toBe("greetings");
    expect(skill?.description).toBe("Say hi");
    expect(skill?.markdown).toBe("# greet\n");
    expect(skill?.sourceKind).toBe("module");
    expect(skill?.logicalPath).toBe("skills/greetings.ts");
  });

  it("produces a manifest that passes the versioned schema validation", async () => {
    const { manifest } = await compileFromMemory({
      model: "openai/gpt-5.4",
      tools: [{ name: "ping" }],
      skills: [{ name: "hello", description: "Greet" }],
    });

    const parsed = compiledAgentManifestSchema.safeParse(manifest);
    expect(parsed.success, parsed.error?.message).toBe(true);
  });
});
