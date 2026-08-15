import { describe, expect, it } from "vitest";

import { experimental_chatgpt } from "./index.js";

describe("experimental_chatgpt", () => {
  it("defaults to gpt-5.6-sol", () => {
    const model = experimental_chatgpt();

    if (typeof model === "string") throw new Error("expected a model instance");
    expect(model.modelId).toBe("gpt-5.6-sol");
  });

  it("creates a Codex-served model from a bare OpenAI slug", () => {
    const model = experimental_chatgpt("gpt-5.5");

    expect(typeof model).toBe("object");
    if (typeof model === "string") throw new Error("expected a model instance");
    expect(model.modelId).toBe("gpt-5.5");
    expect(model.provider).toContain("codex");
  });

  it("strips an openai/ provider prefix", () => {
    const model = experimental_chatgpt("openai/gpt-5.5");

    if (typeof model === "string") throw new Error("expected a model instance");
    expect(model.modelId).toBe("gpt-5.5");
  });

  it("rejects a non-OpenAI provider-qualified id", () => {
    expect(() => experimental_chatgpt("anthropic/claude-sonnet-4.6")).toThrow(
      'experimental_chatgpt serves OpenAI models through the local ChatGPT login; received "anthropic/claude-sonnet-4.6".',
    );
  });

  it("rejects an empty model", () => {
    expect(() => experimental_chatgpt("  ")).toThrow("name an OpenAI model");
    expect(() => experimental_chatgpt("openai/")).toThrow("name an OpenAI model");
  });
});
