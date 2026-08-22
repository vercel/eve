import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAgentSourceManifest, createModuleSourceRef } from "#discover/manifest.js";
import { defineDynamic } from "#public/definitions/tool.js";
import { chatgpt } from "#public/models/openai/index.js";
import { compileAgentConfig } from "#compiler/normalize-agent-config.js";
import type { ManifestCompileContext } from "#compiler/normalize-helpers.js";
import { createAgentModuleNamespaceLoader } from "#compiler/module-namespace-loader.js";

const mocks = vi.hoisted(() => ({
  loadModuleBackedDefinition: vi.fn(),
}));

vi.mock("#compiler/normalize-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#compiler/normalize-helpers.js")>()),
  loadModuleBackedDefinition: mocks.loadModuleBackedDefinition,
}));

describe("compileAgentConfig", () => {
  beforeEach(() => {
    mocks.loadModuleBackedDefinition.mockReset();
  });

  it("compiles a dynamic model resolver without a model reference", async () => {
    mocks.loadModuleBackedDefinition.mockResolvedValue({
      model: defineDynamic({
        events: {
          "session.started": () => "openai/gpt-5.5-mini",
          "step.started": () => "openai/gpt-5.5",
        },
      }),
    });

    const manifest = createAgentSourceManifest({
      agentId: "app",
      agentRoot: "/app/agent",
      appRoot: "/app",
      configModule: createModuleSourceRef({
        logicalPath: "agent.ts",
        sourceId: "agent-config",
      }),
    });

    const modelCatalog = createModelCatalog();
    const compiled = await compileAgentConfig(manifest, createContext(modelCatalog));

    expect(compiled.model).toBeUndefined();
    expect(compiled.dynamicModel).toEqual({
      eventNames: ["session.started", "step.started"],
      logicalPath: "agent.ts",
      sourceId: "agent-config",
      sourceKind: "module",
    });
    expect(modelCatalog.getModelLimits).not.toHaveBeenCalled();
  });

  it("compiles an eve-owned Codex model without AI Gateway metadata", async () => {
    mocks.loadModuleBackedDefinition.mockResolvedValue({ model: chatgpt("gpt-5.6-sol") });
    const manifest = createAgentSourceManifest({
      agentId: "app",
      agentRoot: "/app/agent",
      appRoot: "/app",
      configModule: createModuleSourceRef({ logicalPath: "agent.ts", sourceId: "agent-config" }),
    });
    const modelCatalog = createModelCatalog();

    const compiled = await compileAgentConfig(manifest, createContext(modelCatalog));

    expect(compiled.model).toEqual(
      expect.objectContaining({
        id: "codex/gpt-5.6-sol",
        routing: { kind: "external", provider: "codex" },
        contextWindowTokens: 200_000,
      }),
    );
    expect(modelCatalog.getByProviderModelId).not.toHaveBeenCalled();
    expect(modelCatalog.getModelLimits).not.toHaveBeenCalled();
  });

  it("compiles an injected agent definition without reloading agent.ts", async () => {
    const manifest = createAgentSourceManifest({
      agentId: "researcher",
      agentRoot: "/app/agent/subagents/researcher",
      appRoot: "/app",
      configModule: createModuleSourceRef({
        logicalPath: "agent.ts",
        sourceId: "agent-config",
      }),
    });

    const compiled = await compileAgentConfig(manifest, createContext(createModelCatalog()), {
      definition: {
        model: "openai/gpt-5.5",
      },
    });

    expect(mocks.loadModuleBackedDefinition).not.toHaveBeenCalled();
    expect(compiled.description).toBeUndefined();
    expect(compiled.source?.sourceId).toBe("agent-config");
  });
});

function createModelCatalog(): ManifestCompileContext["modelCatalog"] {
  return {
    getByProviderModelId: vi.fn(),
    getModelLimits: vi.fn(async () => ({ contextWindowTokens: 256_000 })),
  };
}

function createContext(
  modelCatalog: ManifestCompileContext["modelCatalog"],
): ManifestCompileContext {
  return {
    bindingsByAgentRoot: new Map(),
    modelCatalog,
    moduleLoader: createAgentModuleNamespaceLoader(),
  };
}
