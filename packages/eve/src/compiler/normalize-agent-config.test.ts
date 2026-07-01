import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAgentSourceManifest, createModuleSourceRef } from "#discover/manifest.js";
import { compileAgentConfig } from "#compiler/normalize-agent-config.js";
import type { ManifestCompileContext, ManifestCompileMode } from "#compiler/normalize-helpers.js";

const mocks = vi.hoisted(() => ({
  getByProviderModelId: vi.fn(),
  getModelLimits: vi.fn(),
  loadModuleBackedDefinition: vi.fn(),
}));

vi.mock("#compiler/normalize-helpers.js", () => ({
  loadModuleBackedDefinition: mocks.loadModuleBackedDefinition,
}));

describe("compileAgentConfig", () => {
  beforeEach(() => {
    mocks.getByProviderModelId.mockReset();
    mocks.getModelLimits.mockReset();
    mocks.loadModuleBackedDefinition.mockReset();
  });

  it("uses Codex auth for OpenAI string models in development", async () => {
    mocks.loadModuleBackedDefinition.mockResolvedValue({
      experimental: {
        useCodexSubscription: true,
      },
      compaction: {
        model: "openai/gpt-5.4-mini",
        modelContextWindowTokens: 400_000,
      },
      model: "openai/gpt-5.2-codex",
      modelContextWindowTokens: 400_000,
    });

    const result = await compileAgentConfig(createConfigManifest(), createContext("development"));

    expect(result.model).toMatchObject({
      contextWindowTokens: 400_000,
      id: "openai/gpt-5.2-codex",
      routing: { kind: "gateway", target: "openai" },
      transport: "codex",
    });
    expect(result.compaction?.model).toMatchObject({
      contextWindowTokens: 400_000,
      id: "openai/gpt-5.4-mini",
      routing: { kind: "gateway", target: "openai" },
      transport: "codex",
    });
    expect(result.experimental).toEqual({ useCodexSubscription: true });
    expect(mocks.getByProviderModelId).not.toHaveBeenCalled();
    expect(mocks.getModelLimits).not.toHaveBeenCalled();
  });

  it("does not use AI Gateway metadata to validate Codex subscription models", async () => {
    mocks.loadModuleBackedDefinition.mockResolvedValue({
      experimental: {
        useCodexSubscription: true,
      },
      model: "openai/gpt-5.5-pro",
    });

    const result = await compileAgentConfig(createConfigManifest(), createContext("development"));

    expect(result.model).toMatchObject({
      id: "openai/gpt-5.5-pro",
      routing: { kind: "gateway", target: "openai" },
      transport: "codex",
    });
    expect(result.model.contextWindowTokens).toBeUndefined();
    expect(mocks.getModelLimits).not.toHaveBeenCalled();
  });

  it("keeps OpenAI string models on AI Gateway auth in production", async () => {
    mocks.loadModuleBackedDefinition.mockResolvedValue({
      experimental: {
        useCodexSubscription: true,
      },
      compaction: {
        model: "openai/gpt-5.4-mini",
      },
      model: "openai/gpt-5.2-codex",
    });
    mocks.getModelLimits.mockResolvedValue({
      contextWindowTokens: 400_000,
      maxOutputTokens: 128_000,
    });

    const result = await compileAgentConfig(createConfigManifest(), createContext("production"));

    expect(result.model).toMatchObject({
      contextWindowTokens: 400_000,
      id: "openai/gpt-5.2-codex",
      routing: { kind: "gateway", target: "openai" },
    });
    expect(result.model.transport).toBeUndefined();
    expect(result.compaction?.model).toMatchObject({
      contextWindowTokens: 400_000,
      id: "openai/gpt-5.4-mini",
      routing: { kind: "gateway", target: "openai" },
    });
    expect(result.compaction?.model?.transport).toBeUndefined();
    expect(result.experimental).toEqual({ useCodexSubscription: true });
    expect(mocks.getModelLimits).toHaveBeenCalledWith("openai/gpt-5.2-codex");
    expect(mocks.getModelLimits).toHaveBeenCalledWith("openai/gpt-5.4-mini");
  });

  it("keeps an authored model instance with a codex-named provider on external auth", async () => {
    mocks.loadModuleBackedDefinition.mockResolvedValue({
      model: {
        specificationVersion: "v2",
        provider: "codex",
        modelId: "gpt-5.4",
        doGenerate: () => {},
        doStream: () => {},
      },
      modelContextWindowTokens: 400_000,
    });

    const result = await compileAgentConfig(createConfigManifest(), createContext("development"));

    expect(result.model).toMatchObject({
      routing: { kind: "external", provider: "codex" },
    });
    expect(result.model.transport).toBeUndefined();
  });

  it("rejects useCodexSubscription for non-OpenAI string models in development", async () => {
    mocks.loadModuleBackedDefinition.mockResolvedValue({
      experimental: {
        useCodexSubscription: true,
      },
      model: "anthropic/claude-sonnet-4.6",
    });

    await expect(
      compileAgentConfig(createConfigManifest(), createContext("development")),
    ).rejects.toThrow("experimental.useCodexSubscription requires");
    expect(mocks.getModelLimits).not.toHaveBeenCalled();
  });
});

function createConfigManifest() {
  return createAgentSourceManifest({
    agentId: "app",
    agentRoot: "/app/agent",
    appRoot: "/app",
    configModule: createModuleSourceRef({ logicalPath: "agent.ts" }),
  });
}

function createContext(mode: ManifestCompileMode): ManifestCompileContext {
  return {
    mode,
    modelCatalog: {
      getByProviderModelId: mocks.getByProviderModelId,
      getModelLimits: mocks.getModelLimits,
    },
  };
}
