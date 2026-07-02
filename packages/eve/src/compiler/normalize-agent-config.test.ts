import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAgentSourceManifest, createModuleSourceRef } from "#discover/manifest.js";
import { compileAgentConfig } from "#compiler/normalize-agent-config.js";
import { experimental_codex } from "#shared/codex-subscription-model.js";
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

  it("uses Codex auth for experimental_codex models in development", async () => {
    mocks.loadModuleBackedDefinition.mockResolvedValue({
      compaction: {
        model: experimental_codex("gpt-5.4-mini"),
        modelContextWindowTokens: 400_000,
      },
      model: experimental_codex("gpt-5.2-codex"),
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
    expect(mocks.getByProviderModelId).not.toHaveBeenCalled();
    expect(mocks.getModelLimits).not.toHaveBeenCalled();
  });

  it("does not use AI Gateway metadata to validate Codex subscription models in development", async () => {
    mocks.loadModuleBackedDefinition.mockResolvedValue({
      model: experimental_codex("gpt-5.5-pro"),
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

  it("keeps experimental_codex models on AI Gateway auth in production", async () => {
    mocks.loadModuleBackedDefinition.mockResolvedValue({
      compaction: {
        model: experimental_codex("gpt-5.4-mini"),
      },
      model: experimental_codex("gpt-5.2-codex"),
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
    expect(mocks.getModelLimits).toHaveBeenCalledWith("openai/gpt-5.2-codex");
    expect(mocks.getModelLimits).toHaveBeenCalledWith("openai/gpt-5.4-mini");
  });

  it("compiles the fallback in production when the gateway catalog misses the OpenAI id", async () => {
    mocks.loadModuleBackedDefinition.mockResolvedValue({
      model: experimental_codex("gpt-5.2-codex", "anthropic/claude-sonnet-4.6"),
    });
    mocks.getModelLimits.mockImplementation(async (modelId: string) =>
      modelId === "anthropic/claude-sonnet-4.6" ? { contextWindowTokens: 200_000 } : null,
    );

    const result = await compileAgentConfig(createConfigManifest(), createContext("production"));

    expect(result.model).toMatchObject({
      contextWindowTokens: 200_000,
      id: "anthropic/claude-sonnet-4.6",
      routing: { kind: "gateway", target: "anthropic" },
    });
    expect(result.model.transport).toBeUndefined();
  });

  it("fails a production build for an unconfirmed OpenAI id without a fallback", async () => {
    mocks.loadModuleBackedDefinition.mockResolvedValue({
      model: experimental_codex("gpt-5.2-codex"),
    });
    mocks.getModelLimits.mockResolvedValue(null);

    await expect(
      compileAgentConfig(createConfigManifest(), createContext("production")),
    ).rejects.toThrow("Pass a deployable fallback model");
  });

  it("forces the gateway route in production when modelContextWindowTokens is authored", async () => {
    mocks.loadModuleBackedDefinition.mockResolvedValue({
      model: experimental_codex("gpt-5.2-codex"),
      modelContextWindowTokens: 400_000,
    });

    const result = await compileAgentConfig(createConfigManifest(), createContext("production"));

    expect(result.model).toMatchObject({
      contextWindowTokens: 400_000,
      id: "openai/gpt-5.2-codex",
      routing: { kind: "gateway", target: "openai" },
    });
    expect(result.model.transport).toBeUndefined();
    expect(mocks.getModelLimits).not.toHaveBeenCalled();
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

  it("rejects a hand-built descriptor with a provider-qualified slug", async () => {
    mocks.loadModuleBackedDefinition.mockResolvedValue({
      model: {
        kind: "eve.experimental-codex-model",
        model: "anthropic/claude-sonnet-4.6",
      },
    });

    await expect(
      compileAgentConfig(createConfigManifest(), createContext("development")),
    ).rejects.toThrow("bare OpenAI model slug");
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
