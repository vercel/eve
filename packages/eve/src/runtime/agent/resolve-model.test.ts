import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { ContextContainer } from "#context/container.js";
import { RuntimeModelMetadataCacheKey } from "#context/keys.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { defineDynamic } from "#public/definitions/tool.js";
import type { RuntimeModelCatalog } from "#runtime/agent/model-catalog.js";
import {
  loadDynamicRuntimeModelDefinition,
  resolveRuntimeModelReference,
  resolveRuntimeModelSelection,
} from "#runtime/agent/resolve-model.js";

const DYNAMIC_MODEL_SOURCE = {
  eventNames: ["session.started"],
  logicalPath: "agent.ts",
  sourceId: "agent-config",
  sourceKind: "module" as const,
};

describe("dynamic runtime model resolution", () => {
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
        model: defineDynamic({
          events: {
            "session.started": (_event, ctx) => ({
              model: ctx.channel.kind === "slack" ? "openai/gpt-5.5-mini" : "openai/gpt-5.5",
              modelContextWindowTokens: 128_000,
              modelOptions: {
                providerOptions: { gateway: { order: ["openai"] } },
              },
            }),
          },
        }),
      },
    });

    const definition = await loadDynamicRuntimeModelDefinition({
      dynamicModel: DYNAMIC_MODEL_SOURCE,
      scope: { moduleMap, nodeId: undefined },
    });
    const result = await definition.events["session.started"]?.(
      { type: "session.started" },
      {
        channel: { kind: "slack" },
        messages: [{ content: "Hi", role: "user" }],
        session: { auth: { current: null, initiator: null }, id: "session-1" },
      },
    );

    const resolved = await resolveRuntimeModelSelection({
      selection: result as never,
      state: new ContextContainer(),
    });

    expect(resolved).toEqual({
      reference: {
        contextWindowTokens: 128_000,
        id: "openai/gpt-5.5-mini",
        maxOutputTokens: undefined,
        providerOptions: { gateway: { order: ["openai"] } },
      },
    });
  });

  it("resolves omitted metadata from the catalog and caches successful selections", async () => {
    const state = new ContextContainer();
    const catalog = createCatalog();

    const first = await resolveRuntimeModelSelection({
      catalog,
      selection: "openai/gpt-5.5",
      state,
    });
    const second = await resolveRuntimeModelSelection({
      catalog,
      selection: "openai/gpt-5.5",
      state,
    });

    expect(first.reference).toMatchObject({
      contextWindowTokens: 256_000,
      id: "openai/gpt-5.5",
      maxOutputTokens: 32_000,
    });
    expect(second).toEqual(first);
    expect(catalog.getByGatewayId).toHaveBeenCalledTimes(1);
  });

  it("reuses cached metadata after durable context serialization", async () => {
    const state = new ContextContainer();
    await resolveRuntimeModelSelection({
      catalog: createCatalog(),
      selection: "openai/gpt-5.5",
      state,
    });
    const resumedState = await deserializeContext(serializeContext(state));
    const resumedCatalog = createCatalog();

    await expect(
      resolveRuntimeModelSelection({
        catalog: resumedCatalog,
        selection: "openai/gpt-5.5",
        state: resumedState,
      }),
    ).resolves.toMatchObject({ reference: { id: "openai/gpt-5.5" } });
    expect(resumedCatalog.getByGatewayId).not.toHaveBeenCalled();
  });

  it("prunes expired entries during successful cache writes", async () => {
    vi.spyOn(Date, "now").mockReturnValue(2_000);
    const state = new ContextContainer();
    state.set(RuntimeModelMetadataCacheKey, {
      "gateway:expired/model": {
        contextWindowTokens: 1,
        expiresAt: 1_999,
        resolvedModelId: "expired/model",
      },
    });

    await resolveRuntimeModelSelection({
      catalog: createCatalog(),
      selection: "openai/gpt-5.5",
      state,
    });

    expect(state.get(RuntimeModelMetadataCacheKey)).not.toHaveProperty("gateway:expired/model");
    expect(state.get(RuntimeModelMetadataCacheKey)).toHaveProperty("gateway:openai/gpt-5.5");
  });

  it("does not cache failed catalog requests", async () => {
    const getByGatewayId = vi
      .fn<RuntimeModelCatalog["getByGatewayId"]>()
      .mockRejectedValueOnce(new Error("catalog unavailable"))
      .mockResolvedValueOnce({
        contextWindowTokens: 256_000,
        resolvedModelId: "openai/gpt-5.5",
      });
    const catalog: RuntimeModelCatalog = {
      getByGatewayId,
      getByProviderModelId: vi.fn(),
    };
    const state = new ContextContainer();

    await expect(
      resolveRuntimeModelSelection({ catalog, selection: "openai/gpt-5.5", state }),
    ).rejects.toThrow("catalog unavailable");
    await expect(
      resolveRuntimeModelSelection({ catalog, selection: "openai/gpt-5.5", state }),
    ).resolves.toMatchObject({ reference: { id: "openai/gpt-5.5" } });

    expect(getByGatewayId).toHaveBeenCalledTimes(2);
  });

  it("normalizes live provider objects through the same catalog path", async () => {
    const model = createLanguageModel("openai.responses", "gpt-5.5");
    const catalog = createCatalog();

    const resolved = await resolveRuntimeModelSelection({
      catalog,
      selection: model,
      state: new ContextContainer(),
    });

    expect(catalog.getByProviderModelId).toHaveBeenCalledWith("openai.responses", "gpt-5.5");
    expect(resolved).toMatchObject({
      model,
      reference: {
        contextWindowTokens: 256_000,
        id: "openai/gpt-5.5",
        maxOutputTokens: 32_000,
      },
    });
  });

  it("rejects missing, malformed, and unknown selections", async () => {
    const state = new ContextContainer();

    await expect(resolveRuntimeModelSelection({ selection: null as never, state })).rejects.toThrow(
      /returned no model/,
    );
    await expect(
      resolveRuntimeModelSelection({
        selection: {
          contextWindowTokens: 128_000,
          model: "openai/gpt-5.5-mini",
        } as never,
        state,
      }),
    ).rejects.toThrow(/unknown key\(s\): contextWindowTokens/);
    await expect(
      resolveRuntimeModelSelection({
        catalog: createCatalog(null),
        selection: "custom/unknown",
        state,
      }),
    ).rejects.toThrow(/Return modelContextWindowTokens/);
  });
});

function createCatalog(
  result: Awaited<ReturnType<RuntimeModelCatalog["getByGatewayId"]>> = {
    contextWindowTokens: 256_000,
    maxOutputTokens: 32_000,
    resolvedModelId: "openai/gpt-5.5",
  },
): RuntimeModelCatalog & {
  getByGatewayId: ReturnType<typeof vi.fn<RuntimeModelCatalog["getByGatewayId"]>>;
  getByProviderModelId: ReturnType<typeof vi.fn<RuntimeModelCatalog["getByProviderModelId"]>>;
} {
  return {
    getByGatewayId: vi.fn(async () => result),
    getByProviderModelId: vi.fn(async () => result),
  };
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
