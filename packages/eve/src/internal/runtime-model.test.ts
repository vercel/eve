import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import { formatLanguageModelGatewayId } from "#internal/runtime-model.js";

describe("formatLanguageModelGatewayId", () => {
  it("passes through a string id unchanged", () => {
    expect(formatLanguageModelGatewayId("anthropic/claude-sonnet-4-5")).toBe(
      "anthropic/claude-sonnet-4-5",
    );
  });

  it("formats a LanguageModel instance as `${provider}/${modelId}`", () => {
    expect(
      formatLanguageModelGatewayId(
        new MockLanguageModelV3({ provider: "anthropic", modelId: "claude-opus-4-7" }),
      ),
    ).toBe("anthropic/claude-opus-4.7");
  });

  it("strips a dot-suffixed provider sub-path to the first segment", () => {
    expect(
      formatLanguageModelGatewayId(
        new MockLanguageModelV3({ provider: "anthropic.messages", modelId: "claude-opus-4-7" }),
      ),
    ).toBe("anthropic/claude-opus-4.7");

    expect(
      formatLanguageModelGatewayId(
        new MockLanguageModelV3({ provider: "openai.responses", modelId: "gpt-5.4" }),
      ),
    ).toBe("openai/gpt-5.4");
  });

  it("preserves dots inside the model id", () => {
    expect(
      formatLanguageModelGatewayId(
        new MockLanguageModelV3({ provider: "openai", modelId: "gpt-5.4" }),
      ),
    ).toBe("openai/gpt-5.4");
  });

  it("rewrites the version separator in Anthropic claude model ids", () => {
    expect(
      formatLanguageModelGatewayId(
        new MockLanguageModelV3({ provider: "anthropic", modelId: "claude-sonnet-4-5" }),
      ),
    ).toBe("anthropic/claude-sonnet-4.5");
  });
});
