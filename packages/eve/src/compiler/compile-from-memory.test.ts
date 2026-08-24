import { describe, expect, it } from "vitest";

import {
  createAgentSourceRegistry,
  composeAgentSourceRegistries,
} from "#compiler/agent-source-registry.js";
import { compileFromMemory } from "#compiler/compile-from-memory.js";
import {
  COMPILED_AGENT_MANIFEST_KIND,
  COMPILED_AGENT_MANIFEST_VERSION,
  compiledAgentManifestSchema,
  ROOT_COMPILED_AGENT_NODE_ID,
} from "#compiler/manifest.js";
import { createProgrammaticCompiledModuleMap } from "#compiler/module-map.js";
import { frameworkAgentSourceRegistry } from "#framework-sources/registry.js";

const MEMORY_SOURCE_ID = "eve-memory-application";

describe("compileFromMemory", () => {
  it("compiles the application and framework defaults through one source graph", async () => {
    const { manifest, moduleMap } = await compileFromMemory({ model: "openai/gpt-5.4" });

    expect(manifest.kind).toBe(COMPILED_AGENT_MANIFEST_KIND);
    expect(manifest.version).toBe(COMPILED_AGENT_MANIFEST_VERSION);
    expect(manifest.config.name).toBe("memory-agent");
    expect(manifest.config.model?.id).toBe("openai/gpt-5.4");
    expect(manifest.config.source).toEqual({
      logicalPath: "agent.ts",
      sourceId: `${MEMORY_SOURCE_ID}:agent.ts`,
      sourceKind: "module",
    });
    expect(manifest.sourceComposition.shadowed).toContainEqual(
      expect.objectContaining({
        slot: "agent",
        winningSourceId: `${MEMORY_SOURCE_ID}:agent.ts`,
        source: expect.objectContaining({
          layer: "framework-default",
          logicalPath: "agent.ts",
        }),
      }),
    );
    expect(manifest.skills).toEqual([]);
    expect(manifest.subagents).toEqual([]);
    expect(manifest.tools.length).toBeGreaterThan(0);

    const rootModules = moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]?.modules ?? {};
    expect(rootModules[`${MEMORY_SOURCE_ID}:agent.ts`]?.default).toMatchObject({
      model: "openai/gpt-5.4",
    });
    expect(Object.keys(rootModules)).toEqual(
      expect.arrayContaining(manifest.tools.map((tool) => tool.sourceId)),
    );
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

  it("derives authored tool candidates, bindings, composition, and namespaces", async () => {
    const executeWeather = async () => ({ temperature: 72 });
    const { manifest, moduleMap } = await compileFromMemory({
      model: "openai/gpt-5.4",
      tools: [
        {
          name: "weather",
          description: "Gets the weather.",
          execute: executeWeather,
          inputSchema: { type: "object" },
        },
        { name: "echo", outputSchema: { type: "string" } },
      ],
    });

    const authoredTools = manifest.tools.filter((tool) =>
      tool.sourceId.startsWith(`${MEMORY_SOURCE_ID}:`),
    );
    expect(authoredTools).toHaveLength(2);
    const weather = authoredTools.find((tool) => tool.name === "weather");
    const echo = authoredTools.find((tool) => tool.name === "echo");
    if (weather === undefined || echo === undefined) throw new Error("Missing authored tools.");
    expect(weather).toMatchObject({
      description: "Gets the weather.",
      inputSchema: { type: "object" },
      logicalPath: "tools/weather.ts",
    });
    expect(echo).toMatchObject({
      description: "echo test tool.",
      outputSchema: { type: "string" },
    });
    expect(manifest.bindings[weather.sourceId]).toEqual({
      backing: {
        kind: "programmatic",
        moduleId: "tools/weather.ts",
        registryId: MEMORY_SOURCE_ID,
        revision: expect.any(String),
      },
      logicalPath: "tools/weather.ts",
      owner: { kind: "application" },
    });
    expect(manifest.sourceComposition.selected).toContainEqual({
      slot: "tools/weather",
      sourceId: weather.sourceId,
      sourceKind: "module",
    });
    const namespace = moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]?.modules[weather.sourceId];
    if (namespace === undefined) throw new Error("Missing compiled weather namespace.");
    expect((namespace.default as { execute?: unknown }).execute).toBe(executeWeather);
  });

  it("changes artifact identity when a same-key executable changes", async () => {
    const first = await compileFromMemory({
      model: "openai/gpt-5.4",
      tools: [{ execute: () => "first", name: "echo" }],
    });
    const second = await compileFromMemory({
      model: "openai/gpt-5.4",
      tools: [{ execute: () => "second", name: "echo" }],
    });

    expect(first.metadata.compile.moduleMap.identitySha256).not.toBe(
      second.metadata.compile.moduleMap.identitySha256,
    );
  });

  it("uses an opaque generation identity for same-source closures", async () => {
    const createExecute = (captured: string) => () => captured;
    const firstExecute = createExecute("first");
    const secondExecute = createExecute("second");
    const first = await compileFromMemory({
      model: "openai/gpt-5.4",
      tools: [{ execute: firstExecute, name: "echo" }],
    });
    const second = await compileFromMemory({
      model: "openai/gpt-5.4",
      tools: [{ execute: secondExecute, name: "echo" }],
    });

    expect(Function.prototype.toString.call(firstExecute)).toBe(
      Function.prototype.toString.call(secondExecute),
    );
    expect(first.metadata.compile.moduleMap.identitySha256).not.toBe(
      second.metadata.compile.moduleMap.identitySha256,
    );
  });

  it("compiles ordinary skill modules through the primitive normalizer", async () => {
    const { manifest } = await compileFromMemory({
      model: "openai/gpt-5.4",
      skills: [{ name: "greetings", description: "Say hi", markdown: "# greet\n" }],
    });

    expect(manifest.skills).toContainEqual(
      expect.objectContaining({
        name: "greetings",
        description: "Say hi",
        markdown: "# greet\n",
        sourceKind: "module",
        logicalPath: "skills/greetings.ts",
        sourceId: `${MEMORY_SOURCE_ID}:skills/greetings.ts`,
      }),
    );
    expect(manifest.workspaceResourceRoot).toEqual({
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      logicalPath: "workspace-resources/__root__",
      rootEntries: [],
    });
  });

  it("uses canonical authored tool paths to replace kernel capabilities", async () => {
    const { manifest } = await compileFromMemory({
      model: "openai/gpt-5.4",
      tools: [{ name: "agent" }, { name: "ask_question" }],
    });

    expect(manifest.kernelPlan.prepared).not.toContain("agent");
    expect(manifest.kernelPlan.prepared).not.toContain("ask_question");
    expect(manifest.kernelPlan.prepared).toContain("final_output");
  });

  it("rejects authored tools in reserved kernel slots", async () => {
    await expect(
      compileFromMemory({
        model: "openai/gpt-5.4",
        tools: [{ name: "final_output" }],
      }),
    ).rejects.toThrow("reserved final_output kernel slot");
  });

  it("fails a missing programmatic registry before module hydration", async () => {
    const { manifest } = await compileFromMemory({
      model: "openai/gpt-5.4",
      tools: [{ name: "echo" }],
    });
    const registryWithoutApplication = composeAgentSourceRegistries([
      frameworkAgentSourceRegistry,
      createAgentSourceRegistry([]),
    ]);

    await expect(
      createProgrammaticCompiledModuleMap({
        manifest,
        registry: registryWithoutApplication,
      }),
    ).rejects.toThrow(
      'Programmatic module binding "eve-memory-application:agent.ts" is not registered.',
    );
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
