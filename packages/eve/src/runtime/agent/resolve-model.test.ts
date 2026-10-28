import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { defineDynamic } from "#dynamic/definition.js";
import { createModelMetadata, type ModelMetadata } from "#internal/model-catalog.js";
import {
  InvalidRuntimeModelSelectionError,
  loadDynamicRuntimeModelDefinition,
  resolveRuntimeModelReference,
  resolveRuntimeModelSelection,
} from "#runtime/agent/resolve-model.js";

const DYNAMIC_MODEL_SOURCE = {
  logicalPath: "agent.ts",
  sourceId: "agent-config",
  sourceKind: "module" as const,
};

const BUILD_METADATA = createModelMetadata({
  catalog: {
    models: [
      {
        slug: "openai/gpt-5.5",
        providers: [
          { contextWindowTokens: 256_000, provider: "openai", providerModelId: "gpt-5.5" },
        ],
      },
      {
        slug: "anthropic/claude-opus-5",
        providers: [
          { contextWindowTokens: 200_000, provider: "anthropic", providerModelId: "claude-opus-5" },
        ],
      },
    ],
    providerAliases: {},
  },
  fetchedAt: "2026-10-27T00:00:00.000Z",
});

describe("dynamic runtime model resolution", () => {
  it.each(["gateway", "provider"])("retains reasoning for a %s selection", async (kind) => {
    const model =
      kind === "gateway" ? "openai/gpt-5.5" : createLanguageModel("openai.responses", "gpt-5.5");
    const result = await resolveRuntimeModelSelection({
      selection: { model, reasoning: "low", modelContextWindowTokens: 128_000 },
      durability: kind === "gateway" ? "durable" : "live",
      modelMetadata: metadataSource(),
    });
    expect(result.reference.reasoning).toBe("low");
    if (kind === "provider") expect(result.model).toBe(model);
  });

  it("rejects invalid reasoning before reading model metadata", async () => {
    const modelMetadata = metadataSource();
    await expect(
      resolveRuntimeModelSelection({
        modelMetadata,
        selection: { model: "openai/gpt-5.5", reasoning: "maximum" } as never,
        durability: "live",
      }),
    ).rejects.toBeInstanceOf(InvalidRuntimeModelSelectionError);
    expect(modelMetadata).not.toHaveBeenCalled();
  });

  it("keeps model metadata load failures retryable", async () => {
    const failure = new Error("model-metadata.json could not be read.");

    await expect(
      resolveRuntimeModelSelection({
        modelMetadata: vi.fn(async () => Promise.reject(failure)),
        selection: "openai/gpt-5.5",
        durability: "durable",
      }),
    ).rejects.toBe(failure);
  });

  it("carries prompt cache options on a direct provider selection", async () => {
    const result = await resolveRuntimeModelSelection({
      selection: {
        model: createLanguageModel("amazon-bedrock", "application-inference-profile/abc"),
        modelContextWindowTokens: 200_000,
        modelOptions: { promptCache: { anthropic: { ttl: "1h" } } },
      },
      durability: "live",
      modelMetadata: metadataSource(),
    });

    expect(result.reference.promptCache).toEqual({ anthropic: { ttl: "1h" } });
  });

  it("rejects prompt cache options on an AI Gateway selection", async () => {
    const modelMetadata = metadataSource();
    await expect(
      resolveRuntimeModelSelection({
        modelMetadata,
        selection: {
          model: "anthropic/claude-opus-5",
          modelOptions: { promptCache: { anthropic: {} } },
        },
        durability: "durable",
      }),
    ).rejects.toThrow('modelOptions.promptCache for "anthropic/claude-opus-5"');
    expect(modelMetadata).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("does not resolve a source-free eve mock model without the test seam", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const model = await resolveRuntimeModelReference({ id: "eve-mock/dynamic-subagent" });

    expect(model).toBe("eve-mock/dynamic-subagent");
  });

  it("resolves a source-free eve mock model through the explicit test seam", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EVE_MOCK_AUTHORED_MODELS", "1");

    const model = await resolveRuntimeModelReference({ id: "eve-mock/dynamic-subagent" });

    expect(typeof model).toBe("object");
    if (typeof model === "string") throw new Error("expected a mock model instance");
    expect(model.provider).toBe("eve-runtime-mock");
    expect(model.modelId).toBe("eve-mock/dynamic-subagent");
  });

  it("loads resolver-only definitions and normalizes explicit metadata", async () => {
    const moduleMap = createModuleMap({
      default: {
        model: defineDynamic((ctx) => ({
          model: ctx.channel.kind === "channel:slack" ? "openai/gpt-5.5-mini" : "openai/gpt-5.5",
          modelContextWindowTokens: 128_000,
          modelOptions: {
            providerOptions: { gateway: { order: ["openai"] } },
          },
        })),
      },
    });

    const definition = await loadDynamicRuntimeModelDefinition({
      dynamicModel: DYNAMIC_MODEL_SOURCE,
      scope: { moduleMap, nodeId: undefined },
    });
    const result = await definition.evaluate({
      channel: { kind: "channel:slack", metadata: {} },
    } as never);
    const modelMetadata = metadataSource();

    const resolved = await resolveRuntimeModelSelection({
      durability: "live",
      modelMetadata,
      selection: result as never,
    });

    expect(resolved).toEqual({
      reference: {
        contextWindowTokens: 128_000,
        id: "openai/gpt-5.5-mini",
        providerOptions: { gateway: { order: ["openai"] } },
      },
    });
    expect(modelMetadata).not.toHaveBeenCalled();
  });

  it.each([
    { selection: "openai/gpt-5.5", id: "openai/gpt-5.5" },
    // A -thinking variant keeps its Gateway id and takes its base model's window.
    { selection: "openai/gpt-5.5-thinking", id: "openai/gpt-5.5-thinking" },
  ])("resolves an omitted context window for $selection from the build", async (input) => {
    const resolved = await resolveRuntimeModelSelection({
      durability: "durable",
      modelMetadata: metadataSource(),
      selection: input.selection,
    });

    expect(resolved.reference).toMatchObject({ contextWindowTokens: 256_000, id: input.id });
  });

  it.each([undefined, 128_000])(
    "names a gateway() model by its Gateway id (window %s)",
    async (modelContextWindowTokens) => {
      const resolved = await resolveRuntimeModelSelection({
        durability: "live",
        modelMetadata: metadataSource(),
        selection: {
          model: createLanguageModel("gateway", "openai/gpt-5.5"),
          modelContextWindowTokens,
        },
      });

      expect(resolved.reference).toMatchObject({
        contextWindowTokens: modelContextWindowTokens ?? 256_000,
        id: "openai/gpt-5.5",
      });
    },
  );

  it("names a direct provider model by its Gateway slug, as the compiler does", async () => {
    const model = createLanguageModel("anthropic.messages", "claude-opus-5");

    const resolved = await resolveRuntimeModelSelection({
      durability: "live",
      modelMetadata: metadataSource(),
      selection: model,
    });

    expect(resolved).toMatchObject({
      model,
      reference: { contextWindowTokens: 200_000, id: "anthropic/claude-opus-5" },
    });
  });

  it("rejects missing, malformed, and unknown selections", async () => {
    const modelMetadata = metadataSource();

    await expect(
      resolveRuntimeModelSelection({ durability: "live", modelMetadata, selection: null as never }),
    ).rejects.toThrow(/returned no model/);
    await expect(
      resolveRuntimeModelSelection({
        durability: "live",
        modelMetadata,
        selection: {
          contextWindowTokens: 128_000,
          model: "openai/gpt-5.5-mini",
        } as never,
      }),
    ).rejects.toThrow(/returned "contextWindowTokens", which can't vary per session/);
    await expect(
      resolveRuntimeModelSelection({
        durability: "live",
        modelMetadata,
        selection: { build: {}, defaultTools: false, model: "openai/gpt-5.5-mini" } as never,
      }),
    ).rejects.toThrow(/returned "build", "defaultTools".*declare them on defineAgent\(\) instead/);
    await expect(
      resolveRuntimeModelSelection({
        durability: "live",
        modelMetadata,
        selection: "custom/unknown",
      }),
    ).rejects.toThrow(
      'Cannot select model "custom/unknown" because the AI Gateway model catalog this build read at 2026-10-27T00:00:00.000Z has no context window for it. Return modelContextWindowTokens',
    );
  });

  it("explains a build that couldn't read the catalog", async () => {
    await expect(
      resolveRuntimeModelSelection({
        durability: "durable",
        modelMetadata: metadataSource(createModelMetadata(null)),
        selection: "openai/gpt-5.5",
      }),
    ).rejects.toThrow(
      "this build couldn't read the AI Gateway model catalog, so it has no context window for the model",
    );
  });

  it("rejects durable provider objects before reading model metadata", async () => {
    const modelMetadata = metadataSource();

    await expect(
      resolveRuntimeModelSelection({
        durability: "durable",
        modelMetadata,
        selection: createLanguageModel("openai.responses", "gpt-5.5"),
      }),
    ).rejects.toThrow(/durable model selections must be serializable/);

    expect(modelMetadata).not.toHaveBeenCalled();
  });
});

function metadataSource(metadata: ModelMetadata = BUILD_METADATA) {
  return vi.fn(async () => metadata);
}

function createModuleMap(moduleNamespace: Record<string, unknown>): CompiledModuleMap {
  return {
    nodes: {
      [ROOT_COMPILED_AGENT_NODE_ID]: {
        modules: {
          [DYNAMIC_MODEL_SOURCE.sourceId]: moduleNamespace,
        },
      },
    },
  };
}

function createLanguageModel(provider: string, modelId: string): LanguageModel {
  return {
    specificationVersion: "v2",
    provider,
    modelId,
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("not implemented");
    },
    doStream: async () => {
      throw new Error("not implemented");
    },
  } as LanguageModel;
}
