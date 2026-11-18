import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createCompiledRuntimeModelCatalogLoader,
  resolveCompiledRuntimeModelCatalogCachePath,
} from "#compiler/model-catalog.js";
import {
  catalogModelProviderSchema,
  catalogModelSchema,
  modelCatalogResponseSchema,
  type CatalogModel,
} from "#internal/model-catalog.js";

const MOCK_MODELS: CatalogModel[] = [
  {
    slug: "anthropic/claude-opus-4.7",
    providers: [
      {
        provider: "anthropic",
        providerModelId: "claude-opus-4-7",
        contextWindowTokens: 200_000,
      },
      {
        provider: "bedrock",
        providerModelId: "anthropic.claude-opus-4-7-v1",
        contextWindowTokens: 200_000,
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
      },
    ],
  },
  {
    slug: "arcee-ai/trinity-large-thinking",
    providers: [
      {
        provider: "arcee-ai",
        providerModelId: "trinity-large-thinking",
        contextWindowTokens: 262_100,
      },
    ],
  },
  {
    slug: "moonshotai/kimi-k2",
    providers: [
      {
        provider: "moonshotai",
        providerModelId: "kimi-k2",
        contextWindowTokens: 131_072,
      },
    ],
  },
  {
    slug: "moonshotai/kimi-k2-thinking",
    providers: [
      {
        provider: "moonshotai",
        providerModelId: "kimi-k2-thinking",
        contextWindowTokens: 216_144,
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
      },
      {
        provider: "providerB",
        providerModelId: "zero-model",
        contextWindowTokens: 50_000,
      },
    ],
  },
];

const MOCK_PROVIDER_ALIASES: Record<string, string> = { blackForestLabs: "bfl" };

function unusedAppRoot(): string {
  return join(tmpdir(), `eve-model-catalog-${randomUUID()}`);
}

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
    const loader = createCompiledRuntimeModelCatalogLoader(unusedAppRoot());
    const limits = await loader.getModelLimits("anthropic/claude-opus-4.7");
    expect(limits?.contextWindowTokens).toBe(200_000);
  });

  it("identifies eve when fetching the AI Gateway model catalog", async () => {
    mockCatalogFetch();
    const loader = createCompiledRuntimeModelCatalogLoader(unusedAppRoot());

    await loader.getModelLimits("bfl/flux-pro");

    const [url, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(url).toBe("https://ai-gateway.vercel.sh/v1/models/catalog");
    expect(new Headers(init?.headers).get("user-agent")).toMatch(/^eve\/.+/);
  });

  it("returns null for unknown slug", async () => {
    mockCatalogFetch();
    const loader = createCompiledRuntimeModelCatalogLoader(unusedAppRoot());
    const limits = await loader.getModelLimits("unknown/model");
    expect(limits).toBeNull();
  });

  it("strips -thinking suffix from model ID before lookup", async () => {
    mockCatalogFetch();
    const loader = createCompiledRuntimeModelCatalogLoader(unusedAppRoot());
    const limits = await loader.getModelLimits("anthropic/claude-opus-4.7-thinking");
    expect(limits?.contextWindowTokens).toBe(200_000);
  });

  it("resolves a model whose canonical slug ends in -thinking", async () => {
    mockCatalogFetch();
    const loader = createCompiledRuntimeModelCatalogLoader(unusedAppRoot());
    const limits = await loader.getModelLimits("arcee-ai/trinity-large-thinking");
    expect(limits?.contextWindowTokens).toBe(262_100);
  });

  it("prefers the exact -thinking slug over its base model", async () => {
    mockCatalogFetch();
    const loader = createCompiledRuntimeModelCatalogLoader(unusedAppRoot());
    const limits = await loader.getModelLimits("moonshotai/kimi-k2-thinking");
    expect(limits?.contextWindowTokens).toBe(216_144);
  });

  it("resolves by provider and providerModelId", async () => {
    mockCatalogFetch();
    const loader = createCompiledRuntimeModelCatalogLoader(unusedAppRoot());
    const result = await loader.getByProviderModelId("anthropic", "claude-opus-4-7");
    expect(result?.slug).toBe("anthropic/claude-opus-4.7");
    expect(result?.contextWindowTokens).toBe(200_000);
  });

  it("strips dotted sub-path from provider before lookup", async () => {
    mockCatalogFetch();
    const loader = createCompiledRuntimeModelCatalogLoader(unusedAppRoot());
    const result = await loader.getByProviderModelId("anthropic.messages", "claude-opus-4-7");
    expect(result?.slug).toBe("anthropic/claude-opus-4.7");
  });

  it("resolves provider alias before lookup", async () => {
    mockCatalogFetch();
    const loader = createCompiledRuntimeModelCatalogLoader(unusedAppRoot());
    const result = await loader.getByProviderModelId("blackForestLabs", "flux-pro");
    expect(result?.slug).toBe("bfl/flux-pro");
  });

  it("resolves provider alias combined with dot stripping", async () => {
    mockCatalogFetch();
    const loader = createCompiledRuntimeModelCatalogLoader(unusedAppRoot());
    const result = await loader.getByProviderModelId("blackForestLabs.images", "flux-pro");
    expect(result?.slug).toBe("bfl/flux-pro");
  });

  it("returns null for unknown provider and providerModelId", async () => {
    mockCatalogFetch();
    const loader = createCompiledRuntimeModelCatalogLoader(unusedAppRoot());
    const result = await loader.getByProviderModelId("unknown", "model");
    expect(result).toBeNull();
  });

  it("skips providers with zero contextWindowTokens and uses the next valid one", async () => {
    mockCatalogFetch();
    const loader = createCompiledRuntimeModelCatalogLoader(unusedAppRoot());
    const limits = await loader.getModelLimits("example/zero-first-provider");
    expect(limits?.contextWindowTokens).toBe(50_000);
  });

  it("skips providers with zero contextWindowTokens in getByProviderModelId", async () => {
    mockCatalogFetch();
    const loader = createCompiledRuntimeModelCatalogLoader(unusedAppRoot());
    const result = await loader.getByProviderModelId("providerA", "zero-model");
    expect(result).toBeNull();
    const result2 = await loader.getByProviderModelId("providerB", "zero-model");
    expect(result2?.slug).toBe("example/zero-first-provider");
    expect(result2?.contextWindowTokens).toBe(50_000);
  });

  it("projects the catalog onto the snapshot a build ships", async () => {
    mockCatalogFetch();
    const loader = createCompiledRuntimeModelCatalogLoader(unusedAppRoot());

    const metadata = await loader.loadModelMetadata();

    expect(metadata.fetchedAt).toEqual(expect.any(String));
    expect(metadata.providerAliases).toEqual(MOCK_PROVIDER_ALIASES);
    expect(metadata.models.find(({ slug }) => slug === "example/zero-first-provider")).toEqual({
      slug: "example/zero-first-provider",
      providers: [
        { contextWindowTokens: 50_000, provider: "providerB", providerModelId: "zero-model" },
      ],
    });
  });

  it("ships an empty snapshot when the catalog is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const loader = createCompiledRuntimeModelCatalogLoader(unusedAppRoot());

    await expect(loader.loadModelMetadata()).resolves.toMatchObject({
      fetchedAt: null,
      models: [],
    });
  });

  it("preserves the fetch error for an unknown model", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const loader = createCompiledRuntimeModelCatalogLoader(unusedAppRoot());
    await expect(loader.getModelLimits("unknown/model")).rejects.toThrow("offline");
  });

  describe("catalog request retries", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.spyOn(fs, "readFile").mockRejectedValue(new Error("no cached catalog"));
      vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
      vi.spyOn(fs, "writeFile").mockResolvedValue(undefined);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("recovers the metadata prefetch and shared model lookup after transport failures", async () => {
      mockCatalogFetch();
      vi.mocked(fetch)
        .mockRejectedValueOnce(
          new TypeError("fetch failed", {
            cause: Object.assign(new Error("socket closed"), { code: "ECONNRESET" }),
          }),
        )
        .mockRejectedValueOnce(new DOMException("The operation timed out", "TimeoutError"));
      const loader = createCompiledRuntimeModelCatalogLoader(unusedAppRoot());
      const result = Promise.all([
        loader.loadModelMetadata(),
        loader.getModelLimits("anthropic/claude-opus-4.7"),
      ]);
      const assertion = expect(result).resolves.toMatchObject([
        { fetchedAt: expect.any(String) },
        { contextWindowTokens: 200_000 },
      ]);

      await Promise.all([vi.runAllTimersAsync(), assertion]);
      await expect(loader.getModelLimits("openai/gpt-5.4")).resolves.toMatchObject({
        contextWindowTokens: 400_000,
      });
      expect(fetch).toHaveBeenCalledTimes(3);
      const signals = vi.mocked(fetch).mock.calls.map(([, init]) => init?.signal);
      expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
      expect(new Set(signals).size).toBe(3);
    });

    it.each([429, 503])(
      "recovers after HTTP %s without consuming the failed response",
      async (status) => {
        mockCatalogFetch();
        const cancel = vi.fn();
        vi.mocked(fetch).mockResolvedValueOnce(
          new Response(new ReadableStream({ cancel }), { status }),
        );
        const loader = createCompiledRuntimeModelCatalogLoader(unusedAppRoot());
        const assertion = expect(loader.getModelLimits("openai/gpt-5.4")).resolves.toMatchObject({
          contextWindowTokens: 400_000,
        });

        await Promise.all([vi.runAllTimersAsync(), assertion]);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(cancel).toHaveBeenCalledOnce();
      },
    );

    it("bounds transport retries and retains the terminal failure for later lookups", async () => {
      const error = new TypeError("fetch failed", {
        cause: Object.assign(new Error("connection timed out"), {
          code: "UND_ERR_CONNECT_TIMEOUT",
        }),
      });
      vi.spyOn(globalThis, "fetch").mockRejectedValue(error);
      const loader = createCompiledRuntimeModelCatalogLoader(unusedAppRoot());
      const assertion = expect(loader.loadModelMetadata()).resolves.toMatchObject({
        fetchedAt: null,
      });

      await Promise.all([vi.runAllTimersAsync(), assertion]);
      await expect(loader.getModelLimits("openai/gpt-5.4")).rejects.toBe(error);
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it.each([401, 404, 501])("does not retry permanent HTTP %s failures", async (status) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status }));
      const loader = createCompiledRuntimeModelCatalogLoader(unusedAppRoot());
      const assertion = expect(loader.getModelLimits("openai/gpt-5.4")).rejects.toThrow(
        `HTTP ${status}`,
      );

      await Promise.all([vi.runAllTimersAsync(), assertion]);
      expect(fetch).toHaveBeenCalledOnce();
    });

    it.each([
      ["invalid JSON", "not JSON"],
      ["invalid schema", JSON.stringify({ models: "not an array" })],
    ])("does not retry %s", async (_name, body) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));
      const loader = createCompiledRuntimeModelCatalogLoader(unusedAppRoot());
      const assertion = expect(loader.getModelLimits("openai/gpt-5.4")).rejects.toThrow();

      await Promise.all([vi.runAllTimersAsync(), assertion]);
      expect(fetch).toHaveBeenCalledOnce();
    });

    it("does not retry unrelated request errors", async () => {
      const error = new TypeError("invalid URL");
      vi.spyOn(globalThis, "fetch").mockRejectedValue(error);
      const loader = createCompiledRuntimeModelCatalogLoader(unusedAppRoot());
      const assertion = expect(loader.getModelLimits("openai/gpt-5.4")).rejects.toBe(error);

      await Promise.all([vi.runAllTimersAsync(), assertion]);
      expect(fetch).toHaveBeenCalledOnce();
    });

    it.each([
      ["fresh", 0, 0],
      ["stale", 10 * 60 * 1000, 3],
    ])(
      "preserves the %s disk cache when the catalog is unavailable",
      async (_name, age, requests) => {
        vi.mocked(fs.readFile).mockResolvedValue(
          JSON.stringify({
            fetchedAt: new Date(Date.now() - age).toISOString(),
            kind: "eve-model-catalog-cache",
            models: MOCK_MODELS,
            providerAliases: MOCK_PROVIDER_ALIASES,
            version: 2,
          }),
        );
        vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
        const loader = createCompiledRuntimeModelCatalogLoader(unusedAppRoot());
        const assertion = expect(loader.getModelLimits("openai/gpt-5.4")).resolves.toMatchObject({
          contextWindowTokens: 400_000,
        });

        await Promise.all([vi.runAllTimersAsync(), assertion]);
        expect(fetch).toHaveBeenCalledTimes(requests);
      },
    );
  });

  it("returns cache path under .eve/cache", () => {
    expect(resolveCompiledRuntimeModelCatalogCachePath("/app")).toBe(
      "/app/.eve/cache/model-catalog.json",
    );
  });
});
