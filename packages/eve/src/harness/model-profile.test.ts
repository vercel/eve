import { createGateway, type LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import { type ModelProfile, resolveModelProfile } from "#harness/model-profile.js";
import type { AgentPromptCacheDefinition } from "#shared/agent-definition.js";

function model(provider: string, modelId = "test-model"): LanguageModel {
  return new MockLanguageModelV3({ modelId, provider });
}

const direct = {
  anthropicCache: undefined,
  filesOutsideToolResults: false,
  gateway: false,
  googleSearchDropsTools: false,
};

describe("resolveModelProfile", () => {
  it.each<[string, LanguageModel, ModelProfile, AgentPromptCacheDefinition?]>([
    ["a bare Gateway id", "openai/gpt-5", { ...direct, gateway: true, provider: "openai" }],
    [
      "a Gateway instance used by local auth",
      createGateway({ apiKey: "test-key" })("anthropic/claude-opus-5"),
      { ...direct, gateway: true, provider: "anthropic" },
    ],
    [
      "a namespaced Gateway provider",
      model("gateway.language-model", "google/gemini-3"),
      { ...direct, gateway: true, provider: "google" },
    ],
    [
      "direct Anthropic",
      model("anthropic.messages"),
      { ...direct, anthropicCache: { ttl: "5m" }, provider: "anthropic" },
    ],
    [
      "Vertex Anthropic",
      model("vertex.anthropic"),
      { ...direct, anthropicCache: { ttl: "5m" }, provider: "vertex" },
    ],
    [
      "Bedrock Converse with an Anthropic model id",
      model("amazon-bedrock", "ANTHROPIC.claude-3-5-sonnet-20241022-v2:0"),
      { ...direct, anthropicCache: { ttl: "5m" }, provider: "amazon-bedrock" },
    ],
    [
      "Bedrock Converse with another model id",
      model("amazon-bedrock", "amazon.nova-pro-v1:0"),
      { ...direct, provider: "amazon-bedrock" },
    ],
    ["OpenAI Responses", model("openai.responses"), { ...direct, provider: "openai" }],
    [
      "OpenAI Chat Completions",
      model("openai.chat"),
      { ...direct, filesOutsideToolResults: true, provider: "openai" },
    ],
    ["the ChatGPT subscription", model("codex.responses"), { ...direct, provider: "codex" }],
    [
      "a Gateway Gemini model older than Gemini 3",
      "google/gemini-2.5-flash",
      { ...direct, gateway: true, googleSearchDropsTools: true, provider: "google" },
    ],
    [
      "a direct Gemini model older than Gemini 3",
      model("google.generative-ai", "models/gemini-2.5-pro"),
      { ...direct, googleSearchDropsTools: true, provider: "google" },
    ],
    [
      "Gemini Robotics-ER 1.5, which the SDK treats as pre-Gemini 2",
      "google/gemini-robotics-er-1.5-preview",
      { ...direct, gateway: true, googleSearchDropsTools: true, provider: "google" },
    ],
    ["a provider-less test double", {} as LanguageModel, { ...direct, provider: "" }],
    [
      "an opaque Bedrock inference profile declared as Anthropic",
      model("amazon-bedrock", "arn:aws:bedrock:us-east-1:123:application-inference-profile/abc"),
      { ...direct, anthropicCache: { ttl: "5m" }, provider: "amazon-bedrock" },
      { anthropic: {} },
    ],
    [
      "direct Anthropic with a 1-hour cache",
      model("anthropic.messages"),
      { ...direct, anthropicCache: { ttl: "1h" }, provider: "anthropic" },
      { anthropic: { ttl: "1h" } },
    ],
    [
      "a Gateway model, which caches on its own",
      "anthropic/claude-opus-5",
      { ...direct, gateway: true, provider: "anthropic" },
      { anthropic: { ttl: "1h" } },
    ],
  ])("describes %s", (_, input, expected, promptCache) => {
    expect(resolveModelProfile(input, promptCache)).toEqual(expected);
  });
});
