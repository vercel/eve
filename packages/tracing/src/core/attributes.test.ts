import { describe, expect, it } from "vitest";
import { runtimeContextAttributes, usageAttributes } from "./attributes.js";
import { modelUsage } from "../adapters/ai-sdk-payload.js";

describe("model call usage", () => {
  it("records reasoning tokens from the AI SDK's output details", () => {
    const usage = modelUsage({
      inputTokens: 100,
      outputTokens: 40,
      outputTokenDetails: { reasoningTokens: 12 },
    });
    expect(usageAttributes(usage, true)).toMatchObject({
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.output_tokens": 40,
      "gen_ai.usage.reasoning.output_tokens": 12,
    });
    expect(usageAttributes(usage)).not.toHaveProperty("gen_ai.usage.reasoning.output_tokens");
  });
});

describe("runtime context projection", () => {
  it("retains shared objects under each path while stopping cycles", () => {
    const user = { id: "alice" };
    const input: Record<string, unknown> = { requester: user, assignee: user };
    input.self = input;
    expect(runtimeContextAttributes(input)).toEqual({
      "ai.settings.context.requester.id": "alice",
      "ai.settings.context.assignee.id": "alice",
    });
  });
});
