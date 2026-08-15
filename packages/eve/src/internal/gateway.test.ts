import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import {
  AI_GATEWAY_MODELS_CATALOG_URL,
  AI_GATEWAY_MODELS_URL,
  vercelGatewayFetch,
  resolveProviderHeaders,
} from "#internal/gateway.js";

describe("Gateway endpoints", () => {
  it("point at the Gateway origin", () => {
    expect(AI_GATEWAY_MODELS_URL).toBe("https://ai-gateway.vercel.sh/v1/models");
    expect(AI_GATEWAY_MODELS_CATALOG_URL).toBe("https://ai-gateway.vercel.sh/v1/models/catalog");
  });
});

describe("vercelGatewayFetch", () => {
  it("sends the eve product token as the user-agent", async () => {
    const inner = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response());
    vi.stubGlobal("fetch", inner);
    try {
      await vercelGatewayFetch(AI_GATEWAY_MODELS_URL);
    } finally {
      vi.unstubAllGlobals();
    }

    const [, init] = inner.mock.calls[0]!;
    expect(new Headers(init?.headers).get("user-agent")).toMatch(/^eve\/.+/);
  });
});

describe("resolveProviderHeaders", () => {
  it("returns the eve user-agent for bare model ids", () => {
    expect(resolveProviderHeaders("anthropic/claude-sonnet-4-5")).toEqual({
      "user-agent": expect.stringMatching(/^eve\/.+/),
    });
  });

  it("returns the eve user-agent for gateway model instances", () => {
    const model = new MockLanguageModelV3({
      provider: "gateway.language-model",
      modelId: "anthropic/claude-sonnet-4-5",
    });
    expect(resolveProviderHeaders(model)).toEqual({
      "user-agent": expect.stringMatching(/^eve\/.+/),
    });
  });

  it("returns undefined for direct-provider model instances", () => {
    const model = new MockLanguageModelV3({
      provider: "anthropic.messages",
      modelId: "claude-sonnet-4-5",
    });
    expect(resolveProviderHeaders(model)).toBeUndefined();
  });
});
