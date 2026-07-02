import { describe, expect, it } from "vitest";

import { isLanguageModelInstance, isLanguageModelValue } from "#shared/language-model.js";

const MODEL_INSTANCE = {
  specificationVersion: "v4",
  provider: "anthropic",
  modelId: "claude-sonnet-4.6",
  doGenerate: () => {},
  doStream: () => {},
};

describe("isLanguageModelInstance", () => {
  it("accepts v2, v3, and v4 model shapes", () => {
    for (const specificationVersion of ["v2", "v3", "v4"]) {
      expect(isLanguageModelInstance({ ...MODEL_INSTANCE, specificationVersion })).toBe(true);
    }
  });

  it("rejects unknown specification versions and missing entry points", () => {
    expect(isLanguageModelInstance({ ...MODEL_INSTANCE, specificationVersion: "v1" })).toBe(false);
    expect(isLanguageModelInstance({ ...MODEL_INSTANCE, doStream: undefined })).toBe(false);
    expect(isLanguageModelInstance({ ...MODEL_INSTANCE, modelId: 42 })).toBe(false);
  });

  it("rejects strings, null, and empty objects", () => {
    expect(isLanguageModelInstance("anthropic/claude-sonnet-4.6")).toBe(false);
    expect(isLanguageModelInstance(null)).toBe(false);
    expect(isLanguageModelInstance({})).toBe(false);
  });
});

describe("isLanguageModelValue", () => {
  it("accepts a non-empty model id string", () => {
    expect(isLanguageModelValue("anthropic/claude-sonnet-4.6")).toBe(true);
  });

  it("rejects empty and blank strings", () => {
    expect(isLanguageModelValue("")).toBe(false);
    expect(isLanguageModelValue("   ")).toBe(false);
  });

  it("accepts a model instance and rejects undefined", () => {
    expect(isLanguageModelValue(MODEL_INSTANCE)).toBe(true);
    expect(isLanguageModelValue(undefined)).toBe(false);
  });
});
