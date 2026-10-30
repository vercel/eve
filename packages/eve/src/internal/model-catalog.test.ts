import { describe, expect, it } from "vitest";

import {
  createModelMetadata,
  findCatalogModelBySlug,
  lookupCatalogModelByProviderModelId,
  lookupCatalogModelBySlug,
  normalizeCatalogModelId,
  type CatalogModel,
} from "#internal/model-catalog.js";

describe("max output tokens", () => {
  const catalog = {
    models: [
      {
        slug: "anthropic/claude-sonnet-4.5",
        providers: [
          {
            contextWindowTokens: 1_000_000,
            maxOutputTokens: 64_000,
            provider: "anthropic",
            providerModelId: "claude-sonnet-4-5",
          },
        ],
      },
      {
        slug: "moonshotai/kimi-k2",
        providers: [
          {
            contextWindowTokens: 131_072,
            maxOutputTokens: 0,
            provider: "moonshotai",
            providerModelId: "kimi-k2",
          },
        ],
      },
    ],
    providerAliases: {},
  };

  it("carries the catalog's max output into the build snapshot, and drops a missing one", () => {
    const metadata = createModelMetadata({ catalog, fetchedAt: "2026-01-01T00:00:00.000Z" });
    expect(metadata.models.map((model) => model.providers[0])).toEqual([
      {
        contextWindowTokens: 1_000_000,
        maxOutputTokens: 64_000,
        provider: "anthropic",
        providerModelId: "claude-sonnet-4-5",
      },
      { contextWindowTokens: 131_072, provider: "moonshotai", providerModelId: "kimi-k2" },
    ]);
    expect(lookupCatalogModelBySlug(metadata, "anthropic/claude-sonnet-4.5")).toEqual({
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 64_000,
      slug: "anthropic/claude-sonnet-4.5",
    });
    expect(
      lookupCatalogModelByProviderModelId(metadata, "anthropic.messages", "claude-sonnet-4-5"),
    ).toMatchObject({ maxOutputTokens: 64_000 });
    expect(lookupCatalogModelBySlug(metadata, "moonshotai/kimi-k2")).toEqual({
      contextWindowTokens: 131_072,
      slug: "moonshotai/kimi-k2",
    });
  });
});

const MODELS: CatalogModel[] = [
  {
    slug: "anthropic/claude-opus-4.7",
    providers: [
      { provider: "anthropic", providerModelId: "claude-opus-4-7", contextWindowTokens: 200_000 },
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
      { provider: "moonshotai", providerModelId: "kimi-k2", contextWindowTokens: 131_072 },
    ],
  },
  {
    slug: "moonshotai/kimi-k2-thinking",
    providers: [
      { provider: "moonshotai", providerModelId: "kimi-k2-thinking", contextWindowTokens: 216_144 },
    ],
  },
];

describe("normalizeCatalogModelId", () => {
  it("strips a trailing -thinking suffix", () => {
    expect(normalizeCatalogModelId("anthropic/claude-opus-4.7-thinking")).toBe(
      "anthropic/claude-opus-4.7",
    );
  });

  it("leaves other ids untouched", () => {
    expect(normalizeCatalogModelId("openai/gpt-5.4")).toBe("openai/gpt-5.4");
    expect(normalizeCatalogModelId("openai/gpt-5.1-thinking-fast")).toBe(
      "openai/gpt-5.1-thinking-fast",
    );
  });
});

describe("findCatalogModelBySlug", () => {
  it("matches an exact slug", () => {
    expect(findCatalogModelBySlug(MODELS, "anthropic/claude-opus-4.7")?.slug).toBe(
      "anthropic/claude-opus-4.7",
    );
  });

  it("falls back to the base model for a gateway -thinking variant", () => {
    expect(findCatalogModelBySlug(MODELS, "anthropic/claude-opus-4.7-thinking")?.slug).toBe(
      "anthropic/claude-opus-4.7",
    );
  });

  it("resolves a model whose canonical slug ends in -thinking", () => {
    expect(findCatalogModelBySlug(MODELS, "arcee-ai/trinity-large-thinking")?.slug).toBe(
      "arcee-ai/trinity-large-thinking",
    );
  });

  it("prefers the exact -thinking slug over its base model", () => {
    expect(findCatalogModelBySlug(MODELS, "moonshotai/kimi-k2-thinking")?.slug).toBe(
      "moonshotai/kimi-k2-thinking",
    );
  });

  it("returns undefined for an unknown slug", () => {
    expect(findCatalogModelBySlug(MODELS, "unknown/model")).toBeUndefined();
  });
});
