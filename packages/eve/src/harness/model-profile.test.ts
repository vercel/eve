import { createGateway, type LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import { type ModelProfile, resolveModelProfile } from "#harness/model-profile.js";

function model(provider: string, modelId = "test-model"): LanguageModel {
  return new MockLanguageModelV3({ modelId, provider });
}

const direct = {
  anthropicCache: false,
  filesOutsideToolResults: false,
  gateway: false,
  googleSearchDropsTools: false,
};

describe("resolveModelProfile", () => {
  it.each<[string, LanguageModel, ModelProfile]>([
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
      { ...direct, anthropicCache: true, provider: "anthropic" },
    ],
    [
      "Vertex Anthropic",
      model("vertex.anthropic"),
      { ...direct, anthropicCache: true, provider: "vertex" },
    ],
    [
      "Bedrock Converse with an Anthropic model id",
      model("amazon-bedrock", "ANTHROPIC.claude-3-5-sonnet-20241022-v2:0"),
      { ...direct, anthropicCache: true, provider: "amazon-bedrock" },
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
    ["a provider-less test double", {} as LanguageModel, { ...direct, provider: "" }],
  ])("describes %s", (_, input, expected) => {
    expect(resolveModelProfile(input)).toEqual(expected);
  });
});
