import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import { gateway } from "ai";
import { describe, expect, it } from "vitest";

/**
 * CANARY: pins the third-party AI SDK behavior that {@link classifyModelRouting}
 * depends on to decide gateway-vs-external routing. If an `@ai-sdk/*` upgrade
 * changes these provider identities, this fails loudly here rather than letting
 * routing classification silently flip downstream.
 *
 * Reading `.provider`/`.modelId` is pure — the SDK constructs models lazily and
 * only authenticates per request — so this is safe in the hermetic unit tier.
 */
describe("ai-sdk provider identity contract (canary)", () => {
  it("gateway instances report provider 'gateway'", () => {
    expect(gateway("anthropic/claude-sonnet-4.6").provider).toBe("gateway");
    expect(gateway("anthropic/claude-sonnet-4.6").modelId).toBe("anthropic/claude-sonnet-4.6");
  });

  it("a bare string resolves through the gateway global default provider", () => {
    // The hermetic unit env installs no override, so the AI SDK default applies.
    expect(
      (globalThis as { AI_SDK_DEFAULT_PROVIDER?: unknown }).AI_SDK_DEFAULT_PROVIDER,
    ).toBeUndefined();
    expect(gateway.languageModel("anthropic/claude-sonnet-4.6").provider).toBe("gateway");
  });

  it("direct provider instances do not report 'gateway'", () => {
    const providers = [
      anthropic("claude-sonnet-4.6").provider,
      openai("gpt-5.4").provider,
      google("gemini-2.5-pro").provider,
    ];
    expect(anthropic("claude-sonnet-4.6").provider).toMatch(/^anthropic(\.|$)/);
    expect(openai("gpt-5.4").provider).toMatch(/^openai(\.|$)/);
    expect(google("gemini-2.5-pro").provider).toMatch(/^google(\.|$)/);
    for (const provider of providers) {
      expect(provider.split(".")[0]).not.toBe("gateway");
    }
  });
});
