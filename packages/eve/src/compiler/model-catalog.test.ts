import { afterEach, describe, expect, it, vi } from "vitest";

import {
  catalogModelProviderSchema,
  catalogModelSchema,
  createCompiledRuntimeModelCatalogLoader,
  modelCatalogResponseSchema,
  resolveCompiledRuntimeModelCatalogCachePath,
  type CatalogModel,
} from "#compiler/model-catalog.js";

const MOCK_MODELS: CatalogModel[] = [
  {
    slug: "anthropic/claude-opus-4.7",
    providers: [
      {
        provider: "anthropic",
        providerModelId: "claude-opus-4-7",
        contextWindowTokens: 200_000,
        maxOutputTokens: 32_000,
      },
      {
        provider: "bedrock",
        providerModelId: "anthropic.claude-opus-4-7-v1",
        contextWindowTokens: 200_000,
        maxOutputTokens: 32_000,
      },
    ],
  },
  {
    slug: "openai/gpt-5.4",
    providers: [
      {
        provider: "openai",
        providerModelId: "gpt-5.4",
        contextWindowTokens: 400_000,
        maxOutputTokens: 128_000,
      },
    ],
  },
  {
    slug: "bfl/flux-pro",
    providers: [
      {
        provider: "bfl",
        providerModelId: "flux-pro",
        contextWindowTokens: 1_000,
        maxOutputTokens: 1_000,
      },
    ],
  },
  {
    slug: "example/zero-first-provider",
    providers: [
      {
        provider: "providerA",
        providerModelId: "zero-model",
        contextWindowTokens: 0,
        maxOutputTokens: 0,
      },
      {
        provider: "providerB",
        providerModelId: "zero-model",
        contextWindowTokens: 50_000,
        maxOutputTokens: 8_000,
      },
    ],
  },
];

const MOCK_PROVIDER_ALIASES: Record<string, string> = { blackForestLabs: "bfl" };

function mockCatalogFetch(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(
        JSON.stringify({ models: MOCK_MODELS, providerAliases: MOCK_PROVIDER_ALIASES }),
        { status: 200 },
      ),
  );
}

describe("catalogModelProviderSchema", () => {
  it("parses a valid provider entry", () => {
    const result = catalogModelProviderSchema.safeParse(MOCK_MODELS[0]!.providers[0]);
    expect(result.success).toBe(true);
  });

  it("accepts extra fields via passthrough", () => {
    const result = catalogModelProviderSchema.safeParse({
      ...MOCK_MODELS[0]!.providers[0],
      extra: "field",
    });
    expect(result.success).toBe(true);
  });

  it("accepts zero contextWindowTokens at schema level", () => {
    const result = catalogModelProviderSchema.safeParse({
      ...MOCK_MODELS[0]!.providers[0],
      contextWindowTokens: 0,
    });
    expect(result.success).toBe(true);
  });

  it("rejects negative contextWindowTokens", () => {
    const result = catalogModelProviderSchema.safeParse({
      ...MOCK_MODELS[0]!.providers[0],
      contextWindowTokens: -1,
    });
    expect(result.success).toBe(false);
  });
});

describe("catalogModelSchema", () => {
  it("parses a valid model with multiple providers", () => {
    const result = catalogModelSchema.safeParse(MOCK_MODELS[0]);
    expect(result.success).toBe(true);
  });

  it("rejects a model with no providers", () => {
    const result = catalogModelSchema.safeParse({
      slug: "test/model",
      providers: [],
    });
    expect(result.success).toBe(false);
  });

  it("accepts extra fields via passthrough", () => {
    const result = catalogModelSchema.safeParse({
      ...MOCK_MODELS[0],
      extra: true,
    });
    expect(result.success).toBe(true);
  });
});

describe("modelCatalogResponseSchema", () => {
  it("parses a valid response", () => {
    const result = modelCatalogResponseSchema.safeParse({
      models: MOCK_MODELS,
      providerAliases: MOCK_PROVIDER_ALIASES,
    });
    expect(result.success).toBe(true);
  });

  it("accepts extra top-level fields via passthrough", () => {
    const result = modelCatalogResponseSchema.safeParse({
      models: MOCK_MODELS,
      providerAliases: MOCK_PROVIDER_ALIASES,
      extra: true,
    });
    expect(result.success).toBe(true);
  });
});

describe("createCompiledRuntimeModelCatalogLoader", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves model limits by slug", async () => {
    mockCatalogFetch();
    const loader = createCompiledRuntimeModelCatalogLoader("/tmp/test-app");
    const limits = await loader.getModelLimits("anthropic/claude-opus-4.7");
    expect(limits).toEqual({ contextWindowTokens: 200_000, maxOutputTokens: 32_000 });
  });

  it("returns null for unknown slug", async () => {
    mockCatalogFetch();
    const loader = createCompiledRuntimeModelCatalogLoader("/tmp/test-app");
    const limits = await loader.getModelLimits("unknown/model");
    expect(limits).toBeNull();
  });

  it("strips -thinking suffix from model ID before lookup", async () => {
    mockCatalogFetch();
    const loader = createCompiledRuntimeModelCatalogLoader("/tmp/test-app");
    const limits = await loader.getModelLimits("anthropic/claude-opus-4.7-thinking");
    expect(limits).toEqual({ contextWindowTokens: 200_000, maxOutputTokens: 32_000 });
  });

  it("resolves by provider and providerModelId", async () => {
    mockCatalogFetch();
    const loader = createCompiledRuntimeModelCatalogLoader("/tmp/test-app");
    const result = await loader.getByProviderModelId("anthropic", "claude-opus-4-7");
    expect(result?.slug).toBe("anthropic/claude-opus-4.7");
    expect(result?.limits).toEqual({ contextWindowTokens: 200_000, maxOutputTokens: 32_000 });
  });

  it("strips dotted sub-path from provider before lookup", async () => {
    mockCatalogFetch();
    const loader = createCompiledRuntimeModelCatalogLoader("/tmp/test-app");
    const result = await loader.getByProviderModelId("anthropic.messages", "claude-opus-4-7");
    expect(result?.slug).toBe("anthropic/claude-opus-4.7");
  });

  it("resolves provider alias before lookup", async () => {
    mockCatalogFetch();
    const loader = createCompiledRuntimeModelCatalogLoader("/tmp/test-app");
    const result = await loader.getByProviderModelId("blackForestLabs", "flux-pro");
    expect(result?.slug).toBe("bfl/flux-pro");
  });

  it("resolves provider alias combined with dot stripping", async () => {
    mockCatalogFetch();
    const loader = createCompiledRuntimeModelCatalogLoader("/tmp/test-app");
    const result = await loader.getByProviderModelId("blackForestLabs.images", "flux-pro");
    expect(result?.slug).toBe("bfl/flux-pro");
  });

  it("returns null for unknown provider and providerModelId", async () => {
    mockCatalogFetch();
    const loader = createCompiledRuntimeModelCatalogLoader("/tmp/test-app");
    const result = await loader.getByProviderModelId("unknown", "model");
    expect(result).toBeNull();
  });

  it("skips providers with zero contextWindowTokens and uses the next valid one", async () => {
    mockCatalogFetch();
    const loader = createCompiledRuntimeModelCatalogLoader("/tmp/test-app");
    const limits = await loader.getModelLimits("example/zero-first-provider");
    expect(limits).toEqual({ contextWindowTokens: 50_000, maxOutputTokens: 8_000 });
  });

  it("skips providers with zero contextWindowTokens in getByProviderModelId", async () => {
    mockCatalogFetch();
    const loader = createCompiledRuntimeModelCatalogLoader("/tmp/test-app");
    const result = await loader.getByProviderModelId("providerA", "zero-model");
    expect(result).toBeNull();
    const result2 = await loader.getByProviderModelId("providerB", "zero-model");
    expect(result2?.slug).toBe("example/zero-first-provider");
    expect(result2?.limits).toEqual({ contextWindowTokens: 50_000, maxOutputTokens: 8_000 });
  });

  it("falls back to built-in limits when fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const loader = createCompiledRuntimeModelCatalogLoader("/tmp/test-app");
    const limits = await loader.getModelLimits("openai/gpt-5.4");
    expect(limits).toEqual({ contextWindowTokens: 400_000, maxOutputTokens: 128_000 });
  });

  it("returns null for unknown model when fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const loader = createCompiledRuntimeModelCatalogLoader("/tmp/test-app");
    const limits = await loader.getModelLimits("unknown/model");
    expect(limits).toBeNull();
  });

  it("returns cache path under .eve/cache", () => {
    expect(resolveCompiledRuntimeModelCatalogCachePath("/app")).toBe(
      "/app/.eve/cache/model-catalog.json",
    );
  });
});
