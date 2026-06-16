import { describe, expect, it } from "vitest";

import {
  COMPILED_AGENT_MANIFEST_KIND,
  COMPILED_AGENT_MANIFEST_VERSION,
  compiledAgentManifestSchema,
  ROOT_COMPILED_AGENT_NODE_ID,
} from "#compiler/manifest.js";
import { compileFromMemory } from "#compiler/compile-from-memory.js";

describe("compileFromMemory", () => {
  it("produces a manifest and module map with minimal input", () => {
    const { manifest, moduleMap } = compileFromMemory({ model: "openai/gpt-5.4" });

    expect(manifest.kind).toBe(COMPILED_AGENT_MANIFEST_KIND);
    expect(manifest.version).toBe(COMPILED_AGENT_MANIFEST_VERSION);
    expect(manifest.config.name).toBe("memory-agent");
    expect(manifest.config.model.id).toBe("openai/gpt-5.4");
    expect(manifest.tools).toEqual([]);
    expect(manifest.skills).toEqual([]);
    expect(manifest.subagents).toEqual([]);
    expect(moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]?.modules).toEqual({});
  });

  it("honours descriptor overrides for name, model, and roots", () => {
    const { manifest } = compileFromMemory({
      name: "custom-agent",
      model: "mock/custom",
      appRoot: "/app",
      agentRoot: "/app/agent",
    });

    expect(manifest.config.name).toBe("custom-agent");
    expect(manifest.config.model.id).toBe("mock/custom");
    expect(manifest.appRoot).toBe("/app");
    expect(manifest.agentRoot).toBe("/app/agent");
  });

  it("projects authored tools into the manifest and module map", () => {
    const { manifest, moduleMap } = compileFromMemory({
      model: "openai/gpt-5.4",
      tools: [
        { name: "weather", description: "Gets the weather.", inputSchema: { kind: "object" } },
        { name: "echo", outputSchema: { type: "string" } },
      ],
    });

    expect(manifest.tools).toHaveLength(2);
    const [weather, echo] = manifest.tools;
    expect(weather?.name).toBe("weather");
    expect(weather?.description).toBe("Gets the weather.");
    expect(weather?.inputSchema).toEqual({ kind: "object" });
    expect(weather?.logicalPath).toBe("tools/weather.ts");
    expect(echo?.description).toBe("echo test tool.");
    expect(echo?.outputSchema).toEqual({ type: "string" });

    const rootModules = moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]?.modules ?? {};
    expect(Object.keys(rootModules)).toHaveLength(2);
    expect(rootModules[weather?.sourceId ?? ""]).toBeDefined();
  });

  it("projects markdown skills into the manifest", () => {
    const { manifest } = compileFromMemory({
      model: "openai/gpt-5.4",
      skills: [{ name: "greetings", description: "Say hi", markdown: "# greet\n" }],
    });

    expect(manifest.skills).toHaveLength(1);
    const [skill] = manifest.skills;
    expect(skill?.name).toBe("greetings");
    expect(skill?.description).toBe("Say hi");
    expect(skill?.markdown).toBe("# greet\n");
    expect(skill?.sourceKind).toBe("markdown");
    expect(skill?.logicalPath).toBe("skills/greetings.md");
  });

  it("produces a manifest that passes the versioned schema validation", () => {
    const { manifest } = compileFromMemory({
      model: "openai/gpt-5.4",
      tools: [{ name: "ping" }],
      skills: [{ name: "hello", description: "Greet" }],
    });

    const parsed = compiledAgentManifestSchema.safeParse(manifest);
    expect(parsed.success).toBe(true);
  });
});
