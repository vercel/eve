import { describe, expect, it, vi } from "vitest";

import { createModuleSourceRef } from "#discover/manifest.js";
import { defineDynamic } from "#public/definitions/tool.js";
import { chatgpt } from "#public/models/openai/index.js";
import { getFrameworkAgentSourceRegistry } from "#internal/agent-sources.js";
import { compileAgentConfig } from "#compiler/normalize-agent-config.js";
import type { ManifestCompileContext } from "#compiler/normalize-helpers.js";

const CONFIG_SOURCE = createModuleSourceRef({
  logicalPath: "agent.ts",
  sourceId: "agent-config",
});

function createContext(modelCatalog: ManifestCompileContext["modelCatalog"]) {
  const frameworkRegistry = getFrameworkAgentSourceRegistry();
  return {
    frameworkRegistry,
    modelCatalog,
    registry: frameworkRegistry,
  } satisfies ManifestCompileContext;
}

describe("compileAgentConfig", () => {
  it("compiles a dynamic model resolver without a model reference", async () => {
    const modelCatalog = createModelCatalog();

    const compiled = await compileAgentConfig(
      {
        agentId: "app",
        definitionValue: {
          model: defineDynamic({
            events: {
              "session.started": () => "openai/gpt-5.5-mini",
              "step.started": () => "openai/gpt-5.5",
            },
          }),
        },
        source: CONFIG_SOURCE,
      },
      createContext(modelCatalog),
    );

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
    const modelCatalog = createModelCatalog();

    const compiled = await compileAgentConfig(
      {
        agentId: "app",
        definitionValue: { model: chatgpt("gpt-5.6-sol") },
        source: CONFIG_SOURCE,
      },
      createContext(modelCatalog),
    );

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

  it("compiles a gateway model with catalog limits and the selected source ref", async () => {
    const modelCatalog = createModelCatalog();

    const compiled = await compileAgentConfig(
      {
        agentId: "researcher",
        definitionValue: { model: "openai/gpt-5.5" },
        source: CONFIG_SOURCE,
      },
      createContext(modelCatalog),
    );

    expect(compiled.model).toEqual(
      expect.objectContaining({
        contextWindowTokens: 256_000,
        id: "openai/gpt-5.5",
        routing: { kind: "gateway", target: "openai" },
      }),
    );
    expect(compiled.name).toBe("researcher");
    expect(compiled.description).toBeUndefined();
    expect(compiled.source?.sourceId).toBe("agent-config");
    expect(modelCatalog.getModelLimits).toHaveBeenCalledWith("openai/gpt-5.5");
  });
});

function createModelCatalog(): ManifestCompileContext["modelCatalog"] {
  return {
    getByProviderModelId: vi.fn(),
    getModelLimits: vi.fn(async () => ({ contextWindowTokens: 256_000 })),
  };
}
