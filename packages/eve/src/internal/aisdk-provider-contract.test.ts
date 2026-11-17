import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import { gateway } from "ai";
import { describe, expect, it } from "vitest";

describe("ai-sdk provider identity contract (canary)", () => {
  it("gateway instances report provider 'gateway'", () => {
    expect(gateway("anthropic/claude-sonnet-5").provider).toBe("gateway");
    expect(gateway("anthropic/claude-sonnet-5").modelId).toBe("anthropic/claude-sonnet-5");
  });

  it("a bare string resolves through the gateway global default provider", () => {
    expect(
      (globalThis as { AI_SDK_DEFAULT_PROVIDER?: unknown }).AI_SDK_DEFAULT_PROVIDER,
    ).toBeUndefined();
    expect(gateway.languageModel("anthropic/claude-sonnet-5").provider).toBe("gateway");
    expect(gateway.decisionModel("typesafe-ai/jev").provider).toBe("gateway");
  });

  it("direct provider instances do not report 'gateway'", () => {
    const providers = [
      anthropic("claude-sonnet-5").provider,
      openai("gpt-5.4").provider,
      google("gemini-2.5-pro").provider,
    ];
    expect(anthropic("claude-sonnet-5").provider).toMatch(/^anthropic(\.|$)/);
    expect(openai("gpt-5.4").provider).toMatch(/^openai(\.|$)/);
    expect(google("gemini-2.5-pro").provider).toMatch(/^google(\.|$)/);
    for (const provider of providers) {
      expect(provider.split(".")[0]).not.toBe("gateway");
    }
  });
});
