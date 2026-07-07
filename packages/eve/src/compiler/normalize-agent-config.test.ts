import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAgentSourceManifest, createModuleSourceRef } from "#discover/manifest.js";
import { defineDynamic } from "#public/definitions/tool.js";
import { compileAgentConfig } from "#compiler/normalize-agent-config.js";
import type { ManifestCompileContext } from "#compiler/normalize-helpers.js";

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

  it("compiles a dynamic model fallback and preserves the resolver source", async () => {
    mocks.loadModuleBackedDefinition.mockResolvedValue({
      model: defineDynamic({
        fallback: "openai/gpt-5.5",
        events: {
          "session.started": () => "openai/gpt-5.5-mini",
          "step.started": () => null,
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

    const compiled = await compileAgentConfig(manifest, {
      modelCatalog: createModelCatalog(),
    });

    expect(compiled.model).toEqual({
      contextWindowTokens: 256_000,
      id: "openai/gpt-5.5",
      routing: { kind: "gateway", target: "openai" },
    });
    expect(compiled.dynamicModel).toEqual({
      eventNames: ["session.started", "step.started"],
      logicalPath: "agent.ts",
      sourceId: "agent-config",
      sourceKind: "module",
    });
  });
});

function createModelCatalog(): ManifestCompileContext["modelCatalog"] {
  return {
    getByProviderModelId: vi.fn(),
    getModelLimits: vi.fn(async () => ({ contextWindowTokens: 256_000 })),
  };
}
