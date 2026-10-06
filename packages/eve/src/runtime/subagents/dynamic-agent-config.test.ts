import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import { buildResolveContext } from "#context/dynamic-resolve-context.js";
import { LiveStepDynamicModelSelectionKey, StaticModelReferenceKey } from "#context/keys.js";
import { defineAgent } from "#public/definitions/agent.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import type { RuntimeModelCatalog } from "#runtime/agent/model-catalog.js";
import { normalizeDynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";

const languageModel = new MockLanguageModelV3({ provider: "custom", modelId: "model" });

function createCatalog(): RuntimeModelCatalog {
  return { getByGatewayId: vi.fn(async () => null), getByProviderModelId: vi.fn(async () => null) };
}

function normalize(state: ContextContainer, value: unknown, catalog = createCatalog()) {
  return normalizeDynamicSubagentAgentConfig({ catalog, name: "child", state, value });
}

function parentState(reference: RuntimeModelReference): ContextContainer {
  const state = new ContextContainer();
  state.set(StaticModelReferenceKey, reference);
  return state;
}

describe("dynamic subagent ctx.model", () => {
  it("reuses the parent reference without a catalog lookup", async () => {
    const catalog = createCatalog();
    const state = parentState({
      id: "custom/model",
      contextWindowTokens: 1_000_000,
      providerOptions: { custom: { mode: "fast" } },
      reasoning: "high",
      source: { sourceKind: "module", logicalPath: "agent.ts", sourceId: "agent" },
    });
    const { model } = buildResolveContext(state, []);

    const config = await normalize(
      state,
      defineAgent({ description: "Child.", model: model!, reasoning: "low" }),
      catalog,
    );

    // The child's own reasoning applies, as it does for a model id.
    expect(config.model).toEqual({
      id: "custom/model",
      contextWindowTokens: 1_000_000,
      providerOptions: { custom: { mode: "fast" } },
      source: { sourceKind: "module", logicalPath: "agent.ts", sourceId: "agent" },
      sourceNodeId: "__root__",
    });
    expect(config.reasoning).toBe("low");
    expect(catalog.getByGatewayId).not.toHaveBeenCalled();
    expect(catalog.getByProviderModelId).not.toHaveBeenCalled();
  });

  it("rejects a live step-scoped provider instance instead of routing its id through Gateway", async () => {
    const state = parentState({ id: "openai/gpt-5.5" });
    state.set(LiveStepDynamicModelSelectionKey, {
      model: languageModel,
      reference: { id: "custom/model", contextWindowTokens: 1_000_000 },
    });
    const { model } = buildResolveContext(state, []);

    await expect(
      normalize(state, defineAgent({ description: "Child.", model: model! })),
    ).rejects.toThrow(/durable model selections must be serializable/);
  });

  it("rejects metadata overrides beside ctx.model", async () => {
    const state = parentState({ id: "custom/model", contextWindowTokens: 1_000_000 });
    const { model } = buildResolveContext(state, []);

    await expect(
      normalize(state, { description: "Child.", model, modelContextWindowTokens: 10 }),
    ).rejects.toThrow(/already carries its metadata/);
  });

  it("does not treat a look-alike object as ctx.model", async () => {
    const state = parentState({ id: "custom/model", contextWindowTokens: 1_000_000 });

    await expect(
      normalize(state, { description: "Child.", model: { id: "custom/model" } }),
    ).rejects.toThrow();
  });
});
