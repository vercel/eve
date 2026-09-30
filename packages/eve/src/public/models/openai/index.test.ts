import { describe, expect, it } from "vitest";

import { chatgpt, experimental_chatgpt, openai } from "./index.js";

it.each([
  ["chatgpt", chatgpt],
  ["openai", openai],
] as const)(
  "%s defaults to gpt-6-luna-fast without overriding explicit models",
  (_name, helper) => {
    const model = helper();
    const explicit = helper("gpt-5.6-luna-fast");
    if (typeof model === "string" || typeof explicit === "string")
      throw new Error("expected model instances");
    expect(model.modelId).toBe("gpt-6-luna-fast");
    expect(explicit.modelId).toBe("gpt-5.6-luna-fast");
  },
);

describe("chatgpt", () => {
  it("creates a Codex-served model from a bare OpenAI slug", () => {
    const model = chatgpt("gpt-5.5");
    expect(typeof model).toBe("object");
    if (typeof model === "string") throw new Error("expected a model instance");
    expect(model.modelId).toBe("gpt-5.5");
    expect(model.provider).toContain("codex");
  });

  it("strips an openai/ provider prefix", () => {
    const model = chatgpt("openai/gpt-5.5");
    if (typeof model === "string") throw new Error("expected a model instance");
    expect(model.modelId).toBe("gpt-5.5");
  });

  it("rejects a non-OpenAI provider-qualified id", () => {
    expect(() => chatgpt("anthropic/claude-sonnet-4.6")).toThrow(
      'chatgpt serves OpenAI models through the local ChatGPT login; received "anthropic/claude-sonnet-4.6".',
    );
  });

  it("keeps the deprecated alias working", () => {
    const model = experimental_chatgpt("gpt-5.5");
    if (typeof model === "string") throw new Error("expected a model instance");
    expect(model.modelId).toBe("gpt-5.5");
  });
});
