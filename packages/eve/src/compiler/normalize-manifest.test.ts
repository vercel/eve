import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { experimental_workflow } from "#public/definitions/tool.js";
import { webSearch } from "#public/tools/web-search.js";

const mocks = vi.hoisted(() => ({
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
    mocks.compileAgentConfig.mockReset();
    mocks.loadModuleBackedDefinition.mockReset();
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
    mocks.loadModuleBackedDefinition.mockResolvedValue({
      description: "Research subagent",
      model: "openai/gpt-5.5",
    });

    await expect(compileAgentManifest(manifest)).rejects.toThrow(
      'Remove "experimental.workflow" from "research"',
    );
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
    mocks.loadModuleBackedDefinition.mockResolvedValue({
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

  it("compiles experimental Workflow tool configuration", async () => {
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      tools: [createModuleSourceRef({ logicalPath: "tools/workflow.ts" })],
    });
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    mocks.loadModuleBackedDefinition.mockResolvedValue(experimental_workflow({ maxSubagents: 6 }));

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
    mocks.loadModuleBackedDefinition.mockResolvedValue(webSearch({ provider: "exa" }));

    const compiled = await compileAgentManifest(manifest);

    expect(compiled.webSearchProvider).toBe("exa");
    expect(compiled.tools).toEqual([]);
  });

  it("requires web search configuration to use the web_search filename", async () => {
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      tools: [createModuleSourceRef({ logicalPath: "tools/search.ts" })],
    });
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    mocks.loadModuleBackedDefinition.mockResolvedValue(webSearch({ provider: "exa" }));

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
    mocks.loadModuleBackedDefinition.mockResolvedValue(dynamic);

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
    mocks.loadModuleBackedDefinition.mockResolvedValue(dynamic);

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
    mocks.loadModuleBackedDefinition.mockResolvedValue({
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
    mocks.loadModuleBackedDefinition.mockResolvedValue({
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
    mocks.loadModuleBackedDefinition.mockResolvedValue(
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
    Partial<Pick<CompiledAgentDefinition, "description" | "experimental">>,
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
  if (input.experimental !== undefined) {
    config.experimental = input.experimental;
  }

  return config;
}
