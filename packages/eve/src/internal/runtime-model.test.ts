import type { LanguageModelV2, LanguageModelV3, LanguageModelV4 } from "@ai-sdk/provider";
import type { LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, expectTypeOf, it } from "vitest";

import { formatLanguageModelGatewayId, isRuntimeLanguageModel } from "#internal/runtime-model.js";
import { anthropic } from "#public/models/anthropic/index.js";
import type { EveLanguageModel } from "#public/models/index.js";

describe("EveLanguageModel", () => {
  it("accepts every AI SDK language model specification", () => {
    expectTypeOf<LanguageModelV2>().toExtend<EveLanguageModel>();
    expectTypeOf<LanguageModelV3>().toExtend<EveLanguageModel>();
    expectTypeOf<LanguageModelV4>().toExtend<EveLanguageModel>();
    expectTypeOf<Exclude<LanguageModel, string>>().toExtend<EveLanguageModel>();
    expectTypeOf<MockLanguageModelV3>().toExtend<EveLanguageModel>();
  });

  it("describes the same shape the runtime guard accepts", () => {
    expect(isRuntimeLanguageModel(new MockLanguageModelV3())).toBe(true);
    expect(isRuntimeLanguageModel(anthropic())).toBe(true);
    expect(isRuntimeLanguageModel({ provider: "p", modelId: "m" })).toBe(false);
  });
});

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
