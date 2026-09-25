import { describe, expect, it } from "vitest";

import {
  findCatalogModelBySlug,
  normalizeCatalogModelId,
  type CatalogModel,
} from "#internal/model-catalog.js";

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
