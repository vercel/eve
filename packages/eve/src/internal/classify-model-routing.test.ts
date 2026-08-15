import { anthropic } from "@ai-sdk/anthropic";
import { gateway } from "ai";
import { describe, expect, it } from "vitest";

import { classifyModelRouting } from "./classify-model-routing.js";

describe("classifyModelRouting", () => {
  it("classifies a bare string id as gateway-routed", () => {
    expect(classifyModelRouting("anthropic/claude-sonnet-5")).toEqual({
      kind: "gateway",
      target: "anthropic",
    });
  });

  it("classifies a gateway() instance as gateway-routed", () => {
    expect(classifyModelRouting(gateway("anthropic/claude-sonnet-5"))).toEqual({
      kind: "gateway",
      target: "anthropic",
    });
  });

  it("classifies a direct provider instance as external", () => {
    expect(classifyModelRouting(anthropic("claude-sonnet-5"))).toEqual({
      kind: "external",
      provider: "anthropic",
    });
  });

  it("records the byok provider when providerOptions.gateway.byok is present", () => {
    expect(
      classifyModelRouting("anthropic/claude-sonnet-5", {
        gateway: { byok: { anthropic: [{ apiKey: "sk-test" }] } },
      }),
    ).toEqual({ kind: "gateway", target: "anthropic", byok: "anthropic" });
  });

  it("does NOT flip to external for non-byok providerOptions on a string id", () => {
    // providerOptions never changes the routing endpoint — only the model value
    // does. A string stays gateway-routed regardless of provider knobs.
    expect(
      classifyModelRouting("anthropic/claude-sonnet-5", {
        anthropic: { thinking: { budget_tokens: 1024 } },
      }),
    ).toEqual({ kind: "gateway", target: "anthropic" });
  });
});
