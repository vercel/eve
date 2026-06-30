import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAgentSourceManifest, createModuleSourceRef } from "#discover/manifest.js";
import { compileAgentConfig } from "#compiler/normalize-agent-config.js";
import type { ManifestCompileContext } from "#compiler/normalize-helpers.js";
import { experimentalCodex } from "#public/codex/index.js";

const mocks = vi.hoisted(() => ({
  getByProviderModelId: vi.fn(),
  getModelLimits: vi.fn(),
  loadModuleBackedDefinition: vi.fn(),
}));

vi.mock("#compiler/normalize-helpers.js", () => ({
  loadModuleBackedDefinition: mocks.loadModuleBackedDefinition,
}));

const context: ManifestCompileContext = {
  modelCatalog: {
    getByProviderModelId: mocks.getByProviderModelId,
    getModelLimits: mocks.getModelLimits,
  },
};

describe("compileAgentConfig", () => {
  beforeEach(() => {
    mocks.getByProviderModelId.mockReset();
    mocks.getModelLimits.mockReset();
    mocks.loadModuleBackedDefinition.mockReset();
  });

  it("accepts the Codex model when its context window is authored", async () => {
    mocks.loadModuleBackedDefinition.mockResolvedValue({
      model: experimentalCodex({ model: "gpt-5.2-codex" }),
      modelContextWindowTokens: 400_000,
    });
    const manifest = createAgentSourceManifest({
      agentId: "app",
      agentRoot: "/app/agent",
      appRoot: "/app",
      configModule: createModuleSourceRef({ logicalPath: "agent.ts" }),
    });

    const result = await compileAgentConfig(manifest, context);

    expect(result.model).toMatchObject({
      contextWindowTokens: 400_000,
      id: "codex/gpt-5.2-codex",
      routing: { kind: "external", provider: "codex" },
    });
    expect(mocks.getByProviderModelId).not.toHaveBeenCalled();
    expect(mocks.getModelLimits).not.toHaveBeenCalled();
  });
});
