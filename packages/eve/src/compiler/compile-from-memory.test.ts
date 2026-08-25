import { describe, expect, it } from "vitest";

import {
  COMPILED_AGENT_MANIFEST_KIND,
  COMPILED_AGENT_MANIFEST_VERSION,
  compiledAgentManifestSchema,
  ROOT_COMPILED_AGENT_NODE_ID,
} from "#compiler/manifest.js";
import { collectModuleRefsForManifest } from "#compiler/module-map.js";
import { compileFromMemory } from "#compiler/compile-from-memory.js";

const FRAMEWORK_ROOT_TOOL_NAMES = [
  "agent",
  "ask_question",
  "bash",
  "load_skill",
  "read_file",
  "task_cancel",
  "task_update",
  "todo",
  "web_fetch",
  "web_search",
  "write_file",
];

describe("compileFromMemory", () => {
  it("produces a v42 manifest with the framework defaults composed in", async () => {
    const { manifest, moduleMap } = await compileFromMemory({ model: "openai/gpt-5.4" });

    expect(manifest.kind).toBe(COMPILED_AGENT_MANIFEST_KIND);
    expect(manifest.version).toBe(42);
    expect(manifest.version).toBe(COMPILED_AGENT_MANIFEST_VERSION);
    expect(manifest.config.name).toBe("memory-agent");
    expect(manifest.config.model?.id).toBe("openai/gpt-5.4");
    expect(manifest.config.source?.sourceId).toBe("memory:agent.ts");
    expect(manifest.subagents).toEqual([]);
    expect(manifest.skills).toEqual([]);

    expect(manifest.tools.map((tool) => tool.name).sort()).toEqual(FRAMEWORK_ROOT_TOOL_NAMES);
    expect(manifest.tools.map((tool) => tool.sourceId)).toContain("eve:tools/bash.ts");
    expect(manifest.dynamicTools).toEqual([
      expect.objectContaining({
        slug: "connection_search",
        sourceId: "eve:tools/connection_search.ts",
      }),
    ]);
    expect(manifest.sandbox.sourceId).toBe("eve:sandbox.ts");
    expect(manifest.bindings["eve:tools/bash.ts"]).toMatchObject({
      backing: { kind: "programmatic", moduleId: "tools/bash.ts", registryId: "eve" },
      logicalPath: "tools/bash.ts",
      owner: { feature: "tools/bash", kind: "framework" },
    });
    expect(manifest.channelRoutes.effective).toContainEqual(
      expect.objectContaining({
        method: "GET",
        sourceId: "eve-root:channels/home.ts",
        urlPath: "/",
      }),
    );
    expect(manifest.channelRoutes.effective).toContainEqual(
      expect.objectContaining({ sourceId: "eve-root:channels/eve.ts" }),
    );
    expect(moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]).toBeDefined();
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

  it("composes descriptor tools at tools/<name>.ts with application ownership", async () => {
    const { manifest } = await compileFromMemory({
      model: "openai/gpt-5.4",
      tools: [
        { name: "weather", description: "Gets the weather.", inputSchema: { kind: "object" } },
        { name: "echo", outputSchema: { type: "string" } },
      ],
    });

    const weather = manifest.tools.find((tool) => tool.name === "weather");
    expect(weather).toMatchObject({
      description: "Gets the weather.",
      inputSchema: { kind: "object" },
      logicalPath: "tools/weather.ts",
      sourceId: "memory:tools/weather.ts",
    });
    const echo = manifest.tools.find((tool) => tool.name === "echo");
    expect(echo).toMatchObject({
      description: "echo test tool.",
      outputSchema: { type: "string" },
      sourceId: "memory:tools/echo.ts",
    });
    expect(manifest.bindings["memory:tools/weather.ts"]).toMatchObject({
      backing: {
        kind: "programmatic",
        moduleId: "tools/weather.ts",
        registryId: "memory",
      },
      logicalPath: "tools/weather.ts",
      owner: { kind: "application" },
    });
  });

  it("exposes exactly the manifest's module refs through the module map", async () => {
    const { manifest, moduleMap } = await compileFromMemory({
      model: "openai/gpt-5.4",
      tools: [{ name: "ping" }],
    });

    const rootModules = moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]?.modules ?? {};
    const expectedSourceIds = collectModuleRefsForManifest(manifest)
      .map((ref) => ref.sourceId)
      .sort();

    expect(Object.keys(rootModules).sort()).toEqual(expectedSourceIds);
    expect(expectedSourceIds).toContain("memory:tools/ping.ts");
  });

  it("keeps live executors reachable through the module map", async () => {
    const { manifest, moduleMap } = await compileFromMemory({
      model: "openai/gpt-5.4",
      tools: [
        {
          name: "echo",
          execute: (input) => ({ echoed: input }),
        },
      ],
    });

    const echo = manifest.tools.find((tool) => tool.name === "echo");
    expect(echo).toBeDefined();
    const namespace = moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]?.modules[echo!.sourceId];
    expect(namespace).toBeDefined();
    const definition = (
      namespace as { default: { execute: (input: unknown, ctx: unknown) => unknown } }
    ).default;

    expect(definition.execute({ value: 1 }, {})).toEqual({ echoed: { value: 1 } });
  });

  it("projects markdown skills into the manifest", async () => {
    const { manifest } = await compileFromMemory({
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
    expect(skill?.owner).toEqual({ kind: "application" });
  });

  it("produces a manifest whose serialized form passes the versioned schema validation", async () => {
    const { manifest } = await compileFromMemory({
      model: "openai/gpt-5.4",
      tools: [{ name: "ping" }],
      skills: [{ name: "hello", description: "Greet" }],
    });

    // The schema governs the serialized artifact: JSON serialization drops
    // the transient undefined-valued keys (eg. a skill's unmaterialized
    // `files`) that the disk pipeline strips during workspace
    // materialization.
    const parsed = compiledAgentManifestSchema.safeParse(JSON.parse(JSON.stringify(manifest)));
    expect(parsed.success).toBe(true);
  });
});
