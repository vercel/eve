import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import {
  AI_GATEWAY_MODELS_CATALOG_URL,
  AI_GATEWAY_MODELS_URL,
  resolveGatewayRequestHeaders,
  vercelGatewayFetch,
} from "#internal/gateway.js";
import { EVE_EVAL_HEADER, EVE_EVAL_HEADER_VALUE } from "#internal/evaluation.js";

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

describe("resolveGatewayRequestHeaders", () => {
  it("returns the eve user-agent for bare model ids", () => {
    expect(resolveGatewayRequestHeaders("anthropic/claude-sonnet-4-5")).toEqual({
      "user-agent": expect.stringMatching(/^eve\/.+/),
    });
  });

  it("returns the eve user-agent for gateway model instances", () => {
    const model = new MockLanguageModelV3({
      provider: "gateway.language-model",
      modelId: "anthropic/claude-sonnet-4-5",
    });
    expect(resolveGatewayRequestHeaders(model)).toEqual({
      "user-agent": expect.stringMatching(/^eve\/.+/),
    });
  });

  it("adds the supplied application and eval attribution", () => {
    expect(
      resolveGatewayRequestHeaders("anthropic/claude-sonnet-4-5", {
        evaluation: true,
        referer: "https://weather.example.com",
        title: "Weather Agent",
      }),
    ).toEqual({
      "http-referer": "https://weather.example.com",
      "user-agent": expect.stringMatching(/^eve\/.+/),
      "x-title": "Weather Agent",
      [EVE_EVAL_HEADER]: EVE_EVAL_HEADER_VALUE,
    });
  });

  it("returns undefined for direct-provider model instances", () => {
    const model = new MockLanguageModelV3({
      provider: "anthropic.messages",
      modelId: "claude-sonnet-4-5",
    });
    expect(resolveGatewayRequestHeaders(model)).toBeUndefined();
  });
});
