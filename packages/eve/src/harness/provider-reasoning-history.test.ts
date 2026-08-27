import type { LanguageModel, ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { normalizeProviderReasoningHistory } from "#harness/provider-reasoning-history.js";

describe("normalizeProviderReasoningHistory", () => {
  it("removes generic reasoning before an OpenAI Gateway turn", () => {
    const reasoning = { text: "private generic reasoning", type: "reasoning" as const };
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [reasoning, { text: "Previous answer", type: "text" }],
      },
      { content: "Continue", role: "user" },
    ];

    expect(
      normalizeProviderReasoningHistory({
        messages,
        model: model("gateway.language-model", "openai/gpt-5.6-luna"),
      }),
    ).toEqual([
      {
        role: "assistant",
        content: [{ text: "Previous answer", type: "text" }],
      },
      { content: "Continue", role: "user" },
    ]);
    expect(messages[0]?.content).toContain(reasoning);
  });

  it.each([
    { openai: { itemId: "rs_123" } },
    { openai: { reasoningEncryptedContent: "encrypted-reasoning" } },
  ])("preserves replayable OpenAI reasoning with %o", (openai) => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            providerOptions: openai,
            text: "OpenAI reasoning summary",
            type: "reasoning",
          },
        ],
      },
    ];

    expect(
      normalizeProviderReasoningHistory({
        messages,
        model: model("openai.responses", "gpt-5.6-luna"),
      }),
    ).toEqual(messages);
  });

  it("uses Azure metadata for Azure OpenAI Responses", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            providerOptions: { azure: { itemId: "rs_123" } },
            text: "Azure OpenAI reasoning",
            type: "reasoning",
          },
        ],
      },
    ];

    expect(
      normalizeProviderReasoningHistory({
        messages,
        model: model("azure.responses", "gpt-5.6-luna"),
      }),
    ).toEqual(messages);
  });

  it("requires encrypted reasoning for the stateless Codex transport", () => {
    const itemReasoning: ModelMessage = {
      role: "assistant",
      content: [
        {
          providerOptions: { openai: { itemId: "rs_123" } },
          text: "Stored OpenAI reasoning",
          type: "reasoning",
        },
      ],
    };
    const encryptedReasoning: ModelMessage = {
      role: "assistant",
      content: [
        {
          providerOptions: { openai: { reasoningEncryptedContent: "encrypted-reasoning" } },
          text: "Encrypted OpenAI reasoning",
          type: "reasoning",
        },
      ],
    };
    const codex = model("codex.responses", "gpt-5.6-luna");

    expect(normalizeProviderReasoningHistory({ messages: [itemReasoning], model: codex })).toEqual(
      [],
    );
    expect(
      normalizeProviderReasoningHistory({ messages: [encryptedReasoning], model: codex }),
    ).toEqual([encryptedReasoning]);
  });

  it("preserves signed reasoning for the provider that produced it", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            providerOptions: { anthropic: { signature: "signed-reasoning" } },
            text: "Anthropic reasoning",
            type: "reasoning",
          },
        ],
      },
    ];

    expect(
      normalizeProviderReasoningHistory({
        messages,
        model: model("anthropic.messages", "claude-sonnet-5"),
      }),
    ).toEqual(messages);
  });

  it.each([
    ["custom.responses", "custom-reasoning-model"],
    ["gateway.responses", "openai/custom-reasoning-model"],
  ])("does not classify arbitrary provider %s as OpenAI", (provider, modelId) => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [{ text: "Custom provider reasoning", type: "reasoning" }],
      },
    ];

    expect(
      normalizeProviderReasoningHistory({
        messages,
        model: model(provider, modelId),
      }),
    ).toEqual(messages);
  });

  it("filters foreign reasoning only for the OpenAI model after a provider switch", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            providerOptions: { google: { thoughtSignature: "signed-reasoning" } },
            text: "Google reasoning",
            type: "reasoning",
          },
          {
            providerOptions: { openai: { reasoningEncryptedContent: "encrypted-reasoning" } },
            text: "OpenAI reasoning",
            type: "reasoning",
          },
        ],
      },
    ];

    expect(
      normalizeProviderReasoningHistory({
        messages,
        model: model("gateway.language-model", "openai/gpt-5.6-terra"),
      }),
    ).toEqual([
      {
        role: "assistant",
        content: [
          {
            providerOptions: { openai: { reasoningEncryptedContent: "encrypted-reasoning" } },
            text: "OpenAI reasoning",
            type: "reasoning",
          },
        ],
      },
    ]);
    expect(
      normalizeProviderReasoningHistory({
        messages,
        model: model("google.generative-ai", "gemini-3.5"),
      }),
    ).toEqual(messages);
  });
});

function model(provider: string, modelId: string): LanguageModel {
  return { modelId, provider, specificationVersion: "v3" } as LanguageModel;
}
