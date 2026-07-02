import { describe, expect, it } from "vitest";

import { experimental_codex, isExperimentalCodexModel } from "#shared/codex-subscription-model.js";

describe("experimental_codex", () => {
  it("wraps a bare OpenAI model slug", () => {
    const model = experimental_codex("gpt-5.5");

    expect(model.model).toBe("gpt-5.5");
    expect(model.fallback).toBeUndefined();
    expect(isExperimentalCodexModel(model)).toBe(true);
  });

  it("strips a redundant openai/ gateway prefix", () => {
    expect(experimental_codex("openai/gpt-5.5").model).toBe("gpt-5.5");
  });

  it("carries the production fallback model", () => {
    const model = experimental_codex("gpt-5.5", "anthropic/claude-sonnet-4.6");

    expect(model.fallback).toBe("anthropic/claude-sonnet-4.6");
  });

  it("rejects empty and non-OpenAI provider-qualified slugs", () => {
    expect(() => experimental_codex("")).toThrow("bare OpenAI model slug");
    expect(() => experimental_codex("openai/")).toThrow("bare OpenAI model slug");
    expect(() => experimental_codex("anthropic/claude-sonnet-4.6")).toThrow(
      "bare OpenAI model slug",
    );
  });
});

describe("isExperimentalCodexModel", () => {
  it("rejects strings, null, and unrelated objects", () => {
    expect(isExperimentalCodexModel("openai/gpt-5.5")).toBe(false);
    expect(isExperimentalCodexModel(null)).toBe(false);
    expect(isExperimentalCodexModel({ model: "gpt-5.5" })).toBe(false);
    expect(isExperimentalCodexModel({ kind: "eve.experimental-codex-model" })).toBe(false);
  });
});
