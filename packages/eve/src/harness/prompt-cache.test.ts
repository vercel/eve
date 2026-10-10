import type { ModelMessage, ToolSet } from "ai";
import { describe, expect, it } from "vitest";

import {
  applyConversationCacheControl,
  applyLastToolCacheBreakpoint,
  applySystemCacheBreakpoint,
  mergeGatewayAutoCaching,
} from "#harness/prompt-cache.js";

const fiveMinutes = { ttl: "5m" } as const;
const marker = {
  anthropic: { cacheControl: { type: "ephemeral" } },
  bedrock: { cachePoint: { type: "default" } },
};

describe("Anthropic cache breakpoints with a 1-hour TTL", () => {
  it("carry the TTL on every breakpoint in both provider namespaces", () => {
    const oneHour = { ttl: "1h" } as const;
    const hourMarker = {
      anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
      bedrock: { cachePoint: { type: "default", ttl: "1h" } },
    };
    const tools = applyLastToolCacheBreakpoint(
      { only: { description: "one" } } as unknown as ToolSet,
      oneHour,
    ) as Record<string, { providerOptions?: unknown }>;
    const system = applySystemCacheBreakpoint([{ role: "system", content: "rules" }], oneHour);
    const messages = applyConversationCacheControl(
      [
        { role: "user", content: "hi" },
        { role: "assistant", content: "yo" },
        { role: "user", content: "hi2" },
      ],
      oneHour,
    );

    expect(tools.only?.providerOptions).toEqual(hourMarker);
    expect(system[0]?.providerOptions).toEqual(hourMarker);
    expect(messages.map((message) => message.providerOptions)).toEqual([
      undefined,
      hourMarker,
      hourMarker,
    ]);
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
  it("is a no-op for an empty tool set", () => {
    const tools = {} as ToolSet;
    expect(applyLastToolCacheBreakpoint(tools, fiveMinutes)).toEqual({});
  });

  it("attaches the marker only to the last tool", () => {
    const tools = {
      alpha: { description: "first" },
      beta: { description: "second" },
      gamma: { description: "third" },
    } as unknown as ToolSet;

    const result = applyLastToolCacheBreakpoint(tools, fiveMinutes) as Record<
      string,
      { description: string; providerOptions?: unknown }
    >;

    expect(result.alpha).toEqual({ description: "first" });
    expect(result.beta).toEqual({ description: "second" });
    expect(result.gamma).toEqual({
      description: "third",
      providerOptions: { ...marker },
    });
  });

  it("merges existing providerOptions on the last tool", () => {
    const tools = {
      only: {
        description: "one",
        providerOptions: { anthropic: { other: 1 }, openai: { something: 2 } },
      },
    } as unknown as ToolSet;

    const result = applyLastToolCacheBreakpoint(tools, fiveMinutes) as Record<
      string,
      { providerOptions: Record<string, unknown> } | undefined
    >;

    // The marker's namespaces override any existing ones; foreign namespaces
    // are preserved.
    expect(result.only?.providerOptions).toEqual({
      ...marker,
      openai: { something: 2 },
    });
  });

  it("does not mutate the input tool set or its tools", () => {
    const tools = {
      one: { description: "first" },
      two: { description: "second" },
    } as unknown as ToolSet;
    const snapshot = JSON.parse(JSON.stringify(tools));
    applyLastToolCacheBreakpoint(tools, fiveMinutes);
    expect(tools).toEqual(snapshot);
  });
});

describe("applyConversationCacheControl", () => {
  it("returns a fresh empty array for empty input", () => {
    const input: readonly ModelMessage[] = [];
    const out = applyConversationCacheControl(input, fiveMinutes);
    expect(out).toEqual([]);
    expect(out).not.toBe(input);
  });

  it("marks a sole user message", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "hi" }];
    const out = applyConversationCacheControl(messages, fiveMinutes);
    expect(out[0]).toEqual({
      role: "user",
      content: "hi",
      providerOptions: { ...marker },
    });
  });

  it("marks the last message and the most recent assistant before it", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
      { role: "user", content: "hi2" },
      { role: "assistant", content: "yo2" },
    ];
    const out = applyConversationCacheControl(messages, fiveMinutes);

    expect(out[0]).toEqual({ role: "user", content: "hi" });
    expect(out[1]).toEqual({
      role: "assistant",
      content: "yo",
      providerOptions: { ...marker },
    });
    expect(out[2]).toEqual({ role: "user", content: "hi2" });
    expect(out[3]).toEqual({
      role: "assistant",
      content: "yo2",
      providerOptions: { ...marker },
    });
  });

  it("marks a trailing tool-result message so fresh tool results enter the cache", () => {
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
    const out = applyConversationCacheControl(messages, fiveMinutes);

    // The trailing tool-result message carries the final breakpoint.
    expect((out[2] as { providerOptions?: unknown }).providerOptions).toEqual({ ...marker });

    // The most recent assistant (index 1) is the advancement anchor.
    expect((out[1] as { providerOptions?: unknown }).providerOptions).toEqual({ ...marker });

    // The user message is untouched.
    expect(out[0]).toEqual(messages[0]);
  });

  it("preserves existing providerOptions on marked messages", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: "hi",
        providerOptions: { openai: { someKey: "someValue" } },
      },
    ];
    const out = applyConversationCacheControl(messages, fiveMinutes);
    expect((out[0] as { providerOptions: Record<string, unknown> }).providerOptions).toEqual({
      openai: { someKey: "someValue" },
      ...marker,
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

    const out = applyConversationCacheControl(messages, fiveMinutes);

    expect(messages).toEqual(snapshot);
    expect(messages[0]).toBe(originalRef0);
    expect(messages[1]).toBe(originalRef1);
    expect(out).not.toBe(messages);
    // Unmarked messages keep their identity; marked messages are copies.
    expect(out[0]).toBe(originalRef0);
    expect(out[1]).not.toBe(originalRef1);
  });
});
