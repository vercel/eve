import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import { describe, expect, it } from "vitest";

import {
  applyConversationCacheControl,
  applyLastToolCacheBreakpoint,
  detectPromptCachePath,
  getAnthropicCacheMarker,
  mergeGatewayAutoCaching,
} from "#harness/prompt-cache.js";

function makeObjectModel(provider: string): LanguageModel {
  return {
    provider,
    modelId: "test-model",
    specificationVersion: "v3",
  } as unknown as LanguageModel;
}

describe("detectPromptCachePath", () => {
  it("returns gateway-auto for any string model id", () => {
    expect(detectPromptCachePath("anthropic/claude-sonnet-4-5")).toEqual({
      kind: "gateway-auto",
    });
    expect(detectPromptCachePath("bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0")).toEqual({
      kind: "gateway-auto",
    });
    expect(detectPromptCachePath("vertex/claude-sonnet-4-5")).toEqual({
      kind: "gateway-auto",
    });
    expect(detectPromptCachePath("openai/gpt-5")).toEqual({ kind: "gateway-auto" });
  });

  it("returns anthropic-direct for a direct Anthropic provider instance", () => {
    expect(detectPromptCachePath(makeObjectModel("anthropic.messages"))).toEqual({
      kind: "anthropic-direct",
    });
  });

  it("returns anthropic-direct for the Bedrock Anthropic subpath", () => {
    expect(detectPromptCachePath(makeObjectModel("bedrock.anthropic"))).toEqual({
      kind: "anthropic-direct",
    });
  });

  it("returns anthropic-direct for the Vertex Anthropic subpath", () => {
    expect(detectPromptCachePath(makeObjectModel("vertex.anthropic"))).toEqual({
      kind: "anthropic-direct",
    });
  });

  it("returns anthropic-direct regardless of case", () => {
    expect(detectPromptCachePath(makeObjectModel("Anthropic.Messages"))).toEqual({
      kind: "anthropic-direct",
    });
  });

  it("returns none for a direct OpenAI provider instance", () => {
    expect(detectPromptCachePath(makeObjectModel("openai.chat"))).toEqual({ kind: "none" });
  });

  it("returns none for a direct Google Gemini provider instance", () => {
    expect(detectPromptCachePath(makeObjectModel("google.generative-ai"))).toEqual({
      kind: "none",
    });
  });

  it("returns none for generic Bedrock Converse (no anthropic subpath)", () => {
    expect(detectPromptCachePath(makeObjectModel("bedrock"))).toEqual({ kind: "none" });
  });
});

describe("getAnthropicCacheMarker", () => {
  it("returns the Anthropic cache marker shape", () => {
    expect(getAnthropicCacheMarker()).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
  });

  it("returns a frozen object", () => {
    const marker = getAnthropicCacheMarker();
    expect(Object.isFrozen(marker)).toBe(true);
    expect(Object.isFrozen(marker.anthropic)).toBe(true);
    expect(Object.isFrozen(marker.anthropic.cacheControl)).toBe(true);
  });
});

describe("mergeGatewayAutoCaching", () => {
  it("creates a fresh gateway block when base is undefined", () => {
    expect(mergeGatewayAutoCaching(undefined)).toEqual({
      gateway: { caching: "auto" },
    });
  });

  it("creates a fresh gateway block when base has no gateway key", () => {
    expect(mergeGatewayAutoCaching({ someOtherProvider: { foo: "bar" } })).toEqual({
      someOtherProvider: { foo: "bar" },
      gateway: { caching: "auto" },
    });
  });

  it("preserves existing gateway.order and adds caching", () => {
    const result = mergeGatewayAutoCaching({
      gateway: { order: ["anthropic", "bedrock"] },
    });
    expect(result).toEqual({
      gateway: { order: ["anthropic", "bedrock"], caching: "auto" },
    });
  });

  it("respects an explicit author override of gateway.caching", () => {
    expect(mergeGatewayAutoCaching({ gateway: { caching: false } })).toEqual({
      gateway: { caching: false },
    });
  });

  it("does not mutate the input object", () => {
    const base = { gateway: { order: ["anthropic", "bedrock"] } };
    const snapshot = JSON.parse(JSON.stringify(base));
    mergeGatewayAutoCaching(base);
    expect(base).toEqual(snapshot);
  });
});

describe("applyLastToolCacheBreakpoint", () => {
  const marker = getAnthropicCacheMarker();

  it("is a no-op for an empty tool set", () => {
    const tools = {} as ToolSet;
    expect(applyLastToolCacheBreakpoint(tools, marker)).toEqual({});
  });

  it("attaches the marker only to the last tool", () => {
    const tools = {
      alpha: { description: "first" },
      beta: { description: "second" },
      gamma: { description: "third" },
    } as unknown as ToolSet;

    const result = applyLastToolCacheBreakpoint(tools, marker) as Record<
      string,
      { description: string; providerOptions?: unknown }
    >;

    expect(result.alpha).toEqual({ description: "first" });
    expect(result.beta).toEqual({ description: "second" });
    expect(result.gamma).toEqual({
      description: "third",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
  });

  it("merges existing providerOptions on the last tool", () => {
    const tools = {
      only: {
        description: "one",
        providerOptions: { anthropic: { other: 1 }, openai: { something: 2 } },
      },
    } as unknown as ToolSet;

    const result = applyLastToolCacheBreakpoint(tools, marker) as Record<
      string,
      { providerOptions: Record<string, unknown> } | undefined
    >;

    // The marker's anthropic namespace overrides the existing one.
    expect(result.only?.providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
      openai: { something: 2 },
    });
  });

  it("does not mutate the input tool set or its tools", () => {
    const tools = {
      one: { description: "first" },
      two: { description: "second" },
    } as unknown as ToolSet;
    const snapshot = JSON.parse(JSON.stringify(tools));
    applyLastToolCacheBreakpoint(tools, marker);
    expect(tools).toEqual(snapshot);
  });
});

describe("applyConversationCacheControl", () => {
  const marker = getAnthropicCacheMarker();

  it("returns a fresh empty array for empty input", () => {
    const input: readonly ModelMessage[] = [];
    const out = applyConversationCacheControl(input, marker);
    expect(out).toEqual([]);
    expect(out).not.toBe(input);
  });

  it("marks a sole user message", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "hi" }];
    const out = applyConversationCacheControl(messages, marker);
    expect(out[0]).toEqual({
      role: "user",
      content: "hi",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
  });

  it("marks both the last user and last assistant in a multi-turn history", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
      { role: "user", content: "hi2" },
      { role: "assistant", content: "yo2" },
    ];
    const out = applyConversationCacheControl(messages, marker);

    expect(out[0]).toEqual({ role: "user", content: "hi" });
    expect(out[1]).toEqual({ role: "assistant", content: "yo" });
    expect(out[2]).toEqual({
      role: "user",
      content: "hi2",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
    expect(out[3]).toEqual({
      role: "assistant",
      content: "yo2",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
  });

  it("skips tool-result messages and still marks the last user and assistant", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "do the thing" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "1", toolName: "t", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "1",
            toolName: "t",
            output: { type: "text", value: "done" },
          },
        ],
      },
    ];
    const out = applyConversationCacheControl(messages, marker);

    // Tool-result is not marked.
    expect(out[2]).toEqual(messages[2]);

    // The last assistant (index 1) is marked.
    expect((out[1] as { providerOptions?: unknown }).providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });

    // The last user (index 0) is marked.
    expect((out[0] as { providerOptions?: unknown }).providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
  });

  it("preserves existing providerOptions on marked messages", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: "hi",
        providerOptions: { openai: { someKey: "someValue" } },
      },
    ];
    const out = applyConversationCacheControl(messages, marker);
    expect((out[0] as { providerOptions: Record<string, unknown> }).providerOptions).toEqual({
      openai: { someKey: "someValue" },
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
  });

  it("does not mutate the input array or the input message objects", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ];
    const snapshot: readonly ModelMessage[] = messages.map((m) => ({ ...m }));
    const originalRef0 = messages[0];
    const originalRef1 = messages[1];

    const out = applyConversationCacheControl(messages, marker);

    expect(messages).toEqual(snapshot);
    expect(messages[0]).toBe(originalRef0);
    expect(messages[1]).toBe(originalRef1);
    expect(out).not.toBe(messages);
    expect(out[0]).not.toBe(originalRef0);
    expect(out[1]).not.toBe(originalRef1);
  });
});
