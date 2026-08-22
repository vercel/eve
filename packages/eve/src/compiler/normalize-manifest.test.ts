import { beforeEach, describe, expect, it, vi } from "vitest";

import { z } from "#compiled/zod/index.js";
import type { AgentSourceManifest } from "#discover/manifest.js";
import {
  createAgentSourceManifest,
  createLocalSubagentSourceRef,
  createModuleSourceRef,
} from "#discover/manifest.js";
import { classifyModelRouting } from "#internal/classify-model-routing.js";
import type { CompiledAgentDefinition } from "#compiler/manifest.js";
import { compileAgentManifest } from "#compiler/normalize-manifest.js";
import { collectModuleRefsForManifest } from "#compiler/module-map.js";
import { defineAgent, defineDynamic } from "#public/definitions/agent.js";
import { defineInstructions } from "#public/definitions/instructions.js";
import { defineTool, experimental_workflow } from "#public/definitions/tool.js";
import { webSearch } from "#public/tools/web-search.js";

const mocks = vi.hoisted(() => ({
  applicationDefinition: vi.fn(),
  compileAgentConfig: vi.fn(),
  loadModuleBackedDefinition: vi.fn(),
}));

vi.mock("#compiler/normalize-agent-config.js", () => ({
  compileAgentConfig: mocks.compileAgentConfig,
}));

vi.mock("#compiler/normalize-helpers.js", () => ({
  loadModuleBackedDefinition: mocks.loadModuleBackedDefinition,
}));

describe("compileAgentManifest", () => {
  beforeEach(() => {
    mocks.applicationDefinition.mockReset();
    mocks.compileAgentConfig.mockReset();
    mocks.loadModuleBackedDefinition.mockReset();
    mocks.loadModuleBackedDefinition.mockImplementation(async (input) => {
      if (input.binding?.backing.kind !== "programmatic") {
        return await mocks.applicationDefinition(input);
      }
      const namespace = await input.moduleLoader.load(input.binding.backing);
      return namespace[input.source.exportName ?? "default"];
    });
  });

  it("rejects Workflow runtime configuration on subagents", async () => {
    const subagentManifest = createAgentSourceManifest({
      agentId: "research",
      agentRoot: "/app/agent/subagents/research",
      appRoot: "/app",
      configModule: createModuleSourceRef({
        logicalPath: "agent.ts",
      }),
    });
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      subagents: [
        createLocalSubagentSourceRef({
          entryPath: "subagents/research/agent.ts",
          logicalPath: "subagents/research",
          manifest: subagentManifest,
          rootPath: "/app/agent/subagents/research",
          subagentId: "research",
        }),
      ],
    });

    mocks.compileAgentConfig.mockImplementation(async (input: AgentSourceManifest) => {
      if (input.agentId === "research") {
        return createConfig({
          description: "Research subagent",
          name: "research",
          experimental: {
            workflow: {
              world: "@workflow/world-postgres",
            },
          },
        });
      }

      return createConfig({ name: "root" });
    });
    mocks.applicationDefinition.mockResolvedValue({
      description: "Research subagent",
      model: "openai/gpt-5.5",
    });

    await expect(compileAgentManifest(manifest)).rejects.toThrow(
      'Remove "experimental.workflow" from "research"',
    );
  });

  it("merges agent-owned and extension-owned external dependencies", async () => {
    const extensionManifest = createAgentSourceManifest({
      agentId: "research-extension",
      agentRoot: "/packages/research/dist/extension",
      appRoot: "/packages/research",
    });
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      extensions: [createModuleSourceRef({ logicalPath: "extensions/research.ts" })],
      resolvedExtensions: [
        {
          namespace: "research",
          specifier: "@acme/research",
          packageName: "@acme/research",
          packageRoot: "/packages/research",
          sourceRoot: "/packages/research/dist/extension",
          manifest: extensionManifest,
          externalDependencies: ["extension-only", "shared"],
        },
      ],
    });
    mocks.compileAgentConfig.mockResolvedValue(
      createConfig({
        name: "root",
        build: { externalDependencies: ["agent-only", "shared"] },
      }),
    );

    const compiled = await compileAgentManifest(manifest);

    expect(compiled.config.build?.externalDependencies).toEqual([
      "agent-only",
      "shared",
      "extension-only",
    ]);
    expect(compiled.extensionMounts).toEqual([
      expect.objectContaining({
        namespace: "research",
        externalDependencies: ["extension-only", "shared"],
      }),
    ]);
  });

  it("retains extension mounts on the subagent that owns them", async () => {
    const extensionManifest = createAgentSourceManifest({
      agentId: "research-extension",
      agentRoot: "/packages/research/dist/extension",
      appRoot: "/packages/research",
    });
    const mountRef = createModuleSourceRef({ logicalPath: "extensions/research.ts" });
    const subagentManifest = createAgentSourceManifest({
      agentId: "researcher",
      agentRoot: "/app/agent/subagents/researcher",
      appRoot: "/app",
      configModule: createModuleSourceRef({ logicalPath: "agent.ts" }),
      extensions: [mountRef],
      resolvedExtensions: [
        {
          namespace: "research",
          specifier: "@acme/research",
          packageName: "@acme/research",
          packageRoot: "/packages/research",
          sourceRoot: "/packages/research/dist/extension",
          manifest: extensionManifest,
          externalDependencies: [],
        },
      ],
    });
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      subagents: [
        createLocalSubagentSourceRef({
          entryPath: "subagents/researcher/agent.ts",
          logicalPath: "subagents/researcher",
          manifest: subagentManifest,
          rootPath: "/app/agent/subagents/researcher",
          subagentId: "researcher",
        }),
      ],
    });
    mocks.compileAgentConfig.mockImplementation(async (input: AgentSourceManifest) =>
      input.agentId === "researcher"
        ? createConfig({ name: input.agentId, description: "Research the request." })
        : createConfig({ name: input.agentId }),
    );
    mocks.applicationDefinition.mockResolvedValue({
      description: "Research the request.",
      model: "openai/gpt-5.5",
    });

    const compiled = await compileAgentManifest(manifest);

    expect(compiled.extensionMounts).toEqual([]);
    expect(compiled.subagents[0]?.agent.extensionMounts).toEqual([
      expect.objectContaining({
        namespace: "research",
        mountLogicalPath: "extensions/research.ts",
        packageName: "@acme/research",
      }),
    ]);
    expect(collectModuleRefsForManifest(compiled.subagents[0]!.agent)).toContainEqual({
      sourceKind: "module",
      logicalPath: "extensions/research.ts",
      sourceId: "extensions/research.ts",
    });
  });

  it("rejects background-task configuration on subagents", async () => {
    const subagentManifest = createAgentSourceManifest({
      agentId: "research",
      agentRoot: "/app/agent/subagents/research",
      appRoot: "/app",
      configModule: createModuleSourceRef({
        logicalPath: "agent.ts",
      }),
    });
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      subagents: [
        createLocalSubagentSourceRef({
          entryPath: "subagents/research/agent.ts",
          logicalPath: "subagents/research",
          manifest: subagentManifest,
          rootPath: "/app/agent/subagents/research",
          subagentId: "research",
        }),
      ],
    });

    mocks.compileAgentConfig.mockImplementation(async (input: AgentSourceManifest) => {
      if (input.agentId === "research") {
        return createConfig({
          description: "Research subagent",
          name: "research",
          experimental: {
            tasks: true,
          },
        });
      }

      return createConfig({ name: "root" });
    });
    mocks.applicationDefinition.mockResolvedValue({
      description: "Research subagent",
      model: "openai/gpt-5.5",
    });

    await expect(compileAgentManifest(manifest)).rejects.toThrow(
      'Remove "experimental.tasks" from "research"',
    );
  });

  it("requires experimental.tasks for background tools", async () => {
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      tools: [createModuleSourceRef({ logicalPath: "tools/export.ts" })],
    });
    mocks.applicationDefinition.mockResolvedValue(
      defineTool({
        description: "Starts an export.",
        execution: "background",
        inputSchema: z.object({}),
        execute: () => ({ ok: true }),
      }),
    );
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));

    await expect(compileAgentManifest(manifest)).rejects.toThrow(
      'Background tool "export" requires experimental.tasks: true in the root agent config.',
    );

    mocks.compileAgentConfig.mockResolvedValue(
      createConfig({ experimental: { tasks: true }, name: "root" }),
    );
    const compiled = await compileAgentManifest(manifest);
    expect(compiled.tools).toContainEqual(
      expect.objectContaining({ execution: "background", name: "export" }),
    );
  });

  it("compiles experimental Workflow tool configuration", async () => {
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      tools: [createModuleSourceRef({ logicalPath: "tools/workflow.ts" })],
    });
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    mocks.applicationDefinition.mockResolvedValue(experimental_workflow({ maxSubagents: 6 }));

    const compiled = await compileAgentManifest(manifest);

    expect(compiled.workflowTool).toEqual({ maxSubagents: 6 });
  });

  it("compiles web search provider configuration", async () => {
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      tools: [createModuleSourceRef({ logicalPath: "tools/web_search.ts" })],
    });
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    mocks.applicationDefinition.mockResolvedValue(webSearch({ provider: "exa" }));

    const compiled = await compileAgentManifest(manifest);

    expect(compiled.webSearchProvider).toBe("exa");
    expect(compiled.tools.map((tool) => tool.name)).toEqual([
      "bash",
      "read_file",
      "todo",
      "web_fetch",
      "write_file",
    ]);
    expect(compiled.dynamicTools).toContainEqual(
      expect.objectContaining({
        logicalPath: "tools/connection_search.ts",
        slug: "connection_search",
        sourceId: "eve.framework-defaults:tools/connection_search.ts",
      }),
    );
  });

  it("compiles framework defaults through ordinary module bindings", async () => {
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));

    const compiled = await compileAgentManifest(
      createAgentSourceManifest({
        agentId: "root",
        agentRoot: "/app/agent",
        appRoot: "/app",
      }),
    );

    expect(compiled.tools.map((tool) => tool.name)).toEqual([
      "bash",
      "read_file",
      "todo",
      "web_fetch",
      "write_file",
    ]);
    expect(compiled.sandbox).toMatchObject({
      logicalPath: "sandbox.ts",
      sourceId: "eve.framework-defaults:sandbox.ts",
    });
    expect(Object.values(compiled.bindings)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          backing: expect.objectContaining({
            kind: "programmatic",
            registryId: "eve.framework-defaults",
          }),
          owner: { feature: "eve.framework-defaults", kind: "framework" },
        }),
      ]),
    );
  });

  it("lets application tools replace framework defaults by logical path", async () => {
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    mocks.applicationDefinition.mockResolvedValue(
      defineTool({
        description: "Application bash",
        inputSchema: z.object({}),
        execute: () => ({ ok: true }),
      }),
    );

    const compiled = await compileAgentManifest(
      createAgentSourceManifest({
        agentId: "root",
        agentRoot: "/app/agent",
        appRoot: "/app",
        tools: [createModuleSourceRef({ logicalPath: "tools/bash.ts" })],
      }),
    );

    expect(compiled.tools.find((tool) => tool.name === "bash")?.description).toBe(
      "Application bash",
    );
    expect(compiled.bindings["tools/bash.ts"]?.backing.kind).toBe("filesystem");
    expect(compiled.bindings["eve.framework-defaults:tools/bash.ts"]).toBeUndefined();
  });

  it("lets an application tool replace the framework connection search resolver", async () => {
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    mocks.applicationDefinition.mockResolvedValue(
      defineTool({
        description: "Search a fixed connection index",
        inputSchema: z.object({}),
        execute: () => [],
      }),
    );

    const compiled = await compileAgentManifest(
      createAgentSourceManifest({
        agentId: "root",
        agentRoot: "/app/agent",
        appRoot: "/app",
        tools: [createModuleSourceRef({ logicalPath: "tools/connection_search.ts" })],
      }),
    );

    expect(compiled.tools).toContainEqual(
      expect.objectContaining({
        name: "connection_search",
        sourceId: "tools/connection_search.ts",
      }),
    );
    expect(compiled.dynamicTools).not.toContainEqual(
      expect.objectContaining({ slug: "connection_search" }),
    );
    expect(compiled.bindings["eve.framework-defaults:tools/connection_search.ts"]).toBeUndefined();
  });

  it("preserves ordered static instruction content, roles, and legacy definitions", async () => {
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      instructions: [
        createModuleSourceRef({ logicalPath: "instructions/10-user.ts" }),
        createModuleSourceRef({ logicalPath: "instructions/20-legacy.ts" }),
      ],
    });
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    mocks.applicationDefinition
      .mockResolvedValueOnce(defineInstructions({ content: "Account context.", role: "user" }))
      .mockResolvedValueOnce(defineInstructions({ markdown: "Legacy system context." }));

    const compiled = await compileAgentManifest(manifest);

    expect(compiled.instructions).toEqual([
      expect.objectContaining({
        content: "Account context.",
        logicalPath: "instructions/10-user.ts",
        role: "user",
      }),
      expect.objectContaining({
        content: "Legacy system context.",
        logicalPath: "instructions/20-legacy.ts",
        role: "system",
      }),
    ]);
  });

  it("rejects unsupported dynamic instruction event keys", async () => {
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      instructions: [createModuleSourceRef({ logicalPath: "instructions/dynamic.ts" })],
    });
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    mocks.applicationDefinition.mockResolvedValue(
      defineDynamic({
        events: {
          "step.started": () => defineInstructions({ content: "Too late." }),
        },
      }),
    );

    await expect(compileAgentManifest(manifest)).rejects.toThrow(
      'Unsupported event: "step.started"',
    );
  });

  it("requires web search configuration to use the web_search filename", async () => {
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      tools: [createModuleSourceRef({ logicalPath: "tools/search.ts" })],
    });
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    mocks.applicationDefinition.mockResolvedValue(webSearch({ provider: "exa" }));

    await expect(compileAgentManifest(manifest)).rejects.toThrow(
      'must be exported from "tools/web_search.ts"',
    );
  });

  it("compiles a dynamic subagent manifest without resolving an agent config", async () => {
    const dynamic = defineDynamic({
      events: {
        "session.started": () =>
          defineAgent({
            description: "Research the request.",
            model: "openai/gpt-5.5",
          }),
        "turn.started": () => null,
      },
    });
    const manifest = createManifestWithSubagent();
    mocks.compileAgentConfig.mockImplementation(async (input: AgentSourceManifest) =>
      createConfig({ name: input.agentId }),
    );
    mocks.applicationDefinition.mockResolvedValue(dynamic);

    const compiled = await compileAgentManifest(manifest);

    expect(compiled.subagents[0]?.configResolver).toMatchObject({
      eventNames: ["session.started", "turn.started"],
      logicalPath: "agent.ts",
      sourceId: "agent.ts",
      sourceKind: "module",
    });
    expect("config" in compiled.subagents[0]!.agent).toBe(false);
    expect(compiled.subagents[0]?.description).toBeUndefined();
    expect(mocks.compileAgentConfig).toHaveBeenCalledTimes(1);
  });

  it("applies dynamic subagent build configuration before resolving events", async () => {
    const dynamic = defineDynamic({
      build: { externalDependencies: ["just-bash"] },
      events: {
        "session.started": () =>
          defineAgent({
            description: "Edit the request.",
            model: "openai/gpt-5.5",
          }),
      },
    });
    const manifest = createManifestWithSubagent();
    mocks.compileAgentConfig.mockImplementation(async (input: AgentSourceManifest) =>
      createConfig({ name: input.agentId }),
    );
    mocks.applicationDefinition.mockResolvedValue(dynamic);

    const compiled = await compileAgentManifest(manifest);

    expect(compiled.subagents[0]?.configResolver).toMatchObject({
      build: { externalDependencies: ["just-bash"] },
      eventNames: ["session.started"],
      logicalPath: "agent.ts",
      sourceId: "agent.ts",
      sourceKind: "module",
    });
    expect("config" in compiled.subagents[0]!.agent).toBe(false);
    expect(mocks.compileAgentConfig).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid dynamic subagent build configuration", async () => {
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    mocks.applicationDefinition.mockResolvedValue({
      build: { externalDependencies: "just-bash" },
      events: { "session.started": () => null },
      kind: "eve:dynamic",
    });

    await expect(compileAgentManifest(createManifestWithSubagent())).rejects.toThrow(
      "Expected the dynamic subagent config export",
    );
  });

  it("rejects fallback on a dynamic subagent", async () => {
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    mocks.applicationDefinition.mockResolvedValue({
      ...defineDynamic({
        events: {
          "session.started": () => null,
        },
      }),
      fallback: defineAgent({
        description: "Research the request.",
        model: "openai/gpt-5.5",
      }),
    });

    await expect(compileAgentManifest(createManifestWithSubagent())).rejects.toThrow(
      'Unknown key "fallback"',
    );
  });

  it("rejects step-scoped dynamic subagents", async () => {
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    mocks.applicationDefinition.mockResolvedValue(
      defineDynamic({
        events: {
          "step.started": () =>
            defineAgent({
              description: "Research the request.",
              model: "openai/gpt-5.5",
            }),
        },
      }),
    );

    await expect(compileAgentManifest(createManifestWithSubagent())).rejects.toThrow(
      'Dynamic subagents support only "session.started" and "turn.started" handlers',
    );
  });
});

function createManifestWithSubagent(): AgentSourceManifest {
  const subagentManifest = createAgentSourceManifest({
    agentId: "researcher",
    agentRoot: "/app/agent/subagents/researcher",
    appRoot: "/app",
    configModule: createModuleSourceRef({ logicalPath: "agent.ts" }),
  });
  return createAgentSourceManifest({
    agentId: "root",
    agentRoot: "/app/agent",
    appRoot: "/app",
    subagents: [
      createLocalSubagentSourceRef({
        entryPath: "subagents/researcher/agent.ts",
        logicalPath: "subagents/researcher",
        manifest: subagentManifest,
        rootPath: "/app/agent/subagents/researcher",
        subagentId: "researcher",
      }),
    ],
  });
}

function createConfig(
  input: Pick<CompiledAgentDefinition, "name"> &
    Partial<Pick<CompiledAgentDefinition, "build" | "description" | "experimental">>,
): CompiledAgentDefinition {
  const config: CompiledAgentDefinition = {
    model: {
      id: "openai/gpt-5.5",
      routing: classifyModelRouting("openai/gpt-5.5"),
    },
    name: input.name,
  };

  if (input.description !== undefined) {
    config.description = input.description;
  }
  if (input.build !== undefined) {
    config.build = input.build;
  }
  if (input.experimental !== undefined) {
    config.experimental = input.experimental;
  }

  return config;
}
