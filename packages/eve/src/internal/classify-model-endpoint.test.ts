import { anthropic } from "@ai-sdk/anthropic";
import { gateway } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import { classifyModelEndpoint } from "./classify-model-endpoint.js";

describe("classifyModelEndpoint", () => {
  it("classifies a bare string id as gateway-routed", () => {
    expect(classifyModelEndpoint("anthropic/claude-sonnet-4.6")).toEqual({
      kind: "gateway",
      target: "anthropic",
    });
  });

  it("classifies a gateway() instance as gateway-routed", () => {
    expect(classifyModelEndpoint(gateway("anthropic/claude-sonnet-4.6"))).toEqual({
      kind: "gateway",
      target: "anthropic",
    });
  });

  it("classifies a provider instance outside AI Gateway as external", () => {
    expect(classifyModelEndpoint(anthropic("claude-sonnet-4.6"))).toEqual({
      kind: "external",
      provider: "anthropic",
    });
  });

  it("classifies a router outside AI Gateway as external", () => {
    expect(
      classifyModelEndpoint(
        new MockLanguageModelV3({ provider: "openrouter", modelId: "openai/gpt-5.2" }),
      ),
    ).toEqual({ kind: "external", provider: "openrouter" });
  });

  it("records the byok provider when providerOptions.gateway.byok is present", () => {
    expect(
      classifyModelEndpoint("anthropic/claude-sonnet-4.6", {
        gateway: { byok: { anthropic: [{ apiKey: "sk-test" }] } },
      }),
    ).toEqual({ kind: "gateway", target: "anthropic", byok: "anthropic" });
  });

  it("does not flip to external for non-byok providerOptions on a string id", () => {
    // providerOptions never changes the routing endpoint — only the model value
    // does. A string stays gateway-routed regardless of provider knobs.
    expect(
      classifyModelEndpoint("anthropic/claude-sonnet-4.6", {
        anthropic: { thinking: { budget_tokens: 1024 } },
      }),
    ).toEqual({ kind: "gateway", target: "anthropic" });
  });
});
