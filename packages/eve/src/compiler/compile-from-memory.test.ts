import { describe, expect, it } from "vitest";

import { compileFromMemory } from "#compiler/compile-from-memory.js";
import {
  COMPILED_AGENT_MANIFEST_KIND,
  COMPILED_AGENT_MANIFEST_VERSION,
  compiledAgentManifestSchema,
  ROOT_COMPILED_AGENT_NODE_ID,
} from "#compiler/manifest.js";
import { validateCompiledModuleMap } from "#compiler/validate-artifact.js";
import { defineInstrumentation } from "#public/instrumentation/index.js";

describe("compileFromMemory", () => {
  it("uses the ordinary source compiler for defaults and authored config", async () => {
    const { manifest, moduleMap } = await compileFromMemory({
      model: "openai/gpt-5.4",
    });

    expect(manifest).toMatchObject({
      kind: COMPILED_AGENT_MANIFEST_KIND,
      version: COMPILED_AGENT_MANIFEST_VERSION,
      config: {
        model: { id: "openai/gpt-5.4" },
        name: "memory-agent",
        source: { logicalPath: "agent.ts", sourceKind: "module" },
      },
      sandbox: { logicalPath: "sandbox.ts" },
    });
    expect(manifest.bindings[manifest.config.source.sourceId]?.owner).toEqual({
      kind: "application",
    });
    expect(manifest.sourceComposition.entries).toContainEqual(
      expect.objectContaining({
        kind: "shadowed",
        source: expect.objectContaining({
          logicalPath: "agent.ts",
          owner: expect.objectContaining({ kind: "framework" }),
        }),
        winnerSourceId: manifest.config.source.sourceId,
      }),
    );
    expect(moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]).toBeDefined();
    expect(() => validateCompiledModuleMap(manifest, moduleMap)).not.toThrow();
  });

  it("projects authored tools and skills as selected programmatic modules", async () => {
    const execute = () => ({ ok: true });
    const { manifest, moduleMap } = await compileFromMemory({
      model: "openai/gpt-5.4",
      tools: [
        {
          name: "weather",
          description: "Gets the weather.",
          execute,
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
        },
      ],
      skills: [{ name: "greetings", description: "Say hi", markdown: "# greet\n" }],
    });

    const weather = manifest.tools.find((tool) => tool.name === "weather");
    expect(weather).toMatchObject({
      description: "Gets the weather.",
      hasExecute: true,
      logicalPath: "tools/weather.ts",
      outputSchema: { type: "object" },
    });
    expect(manifest.bindings[weather!.sourceId]?.owner).toEqual({ kind: "application" });
    expect(moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]?.modules[weather!.sourceId]).toBeDefined();

    const skill = manifest.skills.find((entry) => entry.name === "greetings");
    expect(skill).toMatchObject({
      description: "Say hi",
      logicalPath: "skills/greetings.ts",
      markdown: "# greet\n",
      name: "greetings",
      sourceKind: "module",
    });
    expect(skill).not.toHaveProperty("owner");
    expect(manifest.bindings[skill!.sourceId]?.owner).toEqual({ kind: "application" });
  });

  it("preserves roots and passes the serialized v43 schema", async () => {
    const { manifest } = await compileFromMemory({
      agentRoot: "/app/agent",
      appRoot: "/app",
      model: "openai/gpt-5.4",
      name: "custom-agent",
    });

    expect(manifest).toMatchObject({
      agentRoot: "/app/agent",
      appRoot: "/app",
      config: { name: "custom-agent" },
    });
    expect(
      compiledAgentManifestSchema.safeParse(JSON.parse(JSON.stringify(manifest))).success,
    ).toBe(true);
  });

  it("binds instrumentation as an ordinary programmatic module slot", async () => {
    const instrumentation = defineInstrumentation({ recordInputs: true });
    const { manifest, moduleMap } = await compileFromMemory({
      model: "openai/gpt-5.4",
      modules: [
        {
          loadNamespace: async () => ({ default: instrumentation }),
          logicalPath: "instrumentation.ts",
        },
      ],
    });

    expect(manifest.instrumentation).toMatchObject({
      logicalPath: "instrumentation.ts",
      sourceKind: "module",
    });
    const sourceId = manifest.instrumentation!.sourceId;
    expect(manifest.bindings[sourceId]).toMatchObject({
      backing: { kind: "programmatic", moduleId: "instrumentation.ts" },
      owner: { kind: "application" },
    });
    expect(moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]?.modules[sourceId]?.default).toBe(
      instrumentation,
    );
  });
});
