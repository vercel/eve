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
import { defineAgent } from "#public/definitions/agent.js";
import { defineDynamic, experimental_workflow } from "#public/definitions/tool.js";

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

  it("compiles a dynamic subagent from its fallback definition", async () => {
    const fallback = defineAgent({
      description: "Research the request.",
      model: "openai/gpt-5.5",
    });
    const dynamic = defineDynamic({
      fallback,
      events: {
        "session.started": () => fallback,
        "turn.started": () => null,
      },
    });
    const manifest = createManifestWithSubagent();
    mocks.compileAgentConfig.mockImplementation(async (input: AgentSourceManifest) =>
      input.agentId === "researcher"
        ? createConfig({
            description: fallback.description,
            name: "researcher",
          })
        : createConfig({ name: "root" }),
    );
    mocks.loadModuleBackedDefinition.mockResolvedValue(dynamic);

    const compiled = await compileAgentManifest(manifest);

    expect(compiled.subagents[0]?.dynamic).toEqual({
      eventNames: ["session.started", "turn.started"],
    });
    expect(mocks.compileAgentConfig.mock.calls[1]?.[2]).toMatchObject({
      definition: fallback,
    });
  });

  it("rejects a dynamic subagent without a fallback definition", async () => {
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    mocks.loadModuleBackedDefinition.mockResolvedValue(
      defineDynamic({
        events: {
          "session.started": () => null,
        },
      }),
    );

    await expect(compileAgentManifest(createManifestWithSubagent())).rejects.toThrow(
      "Dynamic subagent definitions must include a fallback agent definition",
    );
  });

  it("rejects step-scoped dynamic subagents", async () => {
    const fallback = defineAgent({
      description: "Research the request.",
      model: "openai/gpt-5.5",
    });
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    mocks.loadModuleBackedDefinition.mockResolvedValue(
      defineDynamic({
        fallback,
        events: {
          "step.started": () => fallback,
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
