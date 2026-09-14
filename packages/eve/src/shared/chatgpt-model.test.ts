import { describe, expect, it } from "vitest";

import {
  isChatGptModelRouting,
  normalizeChatGptModelId,
  parseChatGptModelSelection,
} from "./chatgpt-model.js";

describe("ChatGPT model ids", () => {
  it("parses only a bare OpenAI id after the setup prefix", () => {
    expect(parseChatGptModelSelection("chatgpt/gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(parseChatGptModelSelection("chatgpt/not/a-bare-slug")).toBeUndefined();
    expect(parseChatGptModelSelection("chatgpt/")).toBeUndefined();
  });

  it("normalizes the public helper's optional openai prefix", () => {
    expect(normalizeChatGptModelId(" openai/gpt-5.5 ")).toBe("gpt-5.5");
    expect(normalizeChatGptModelId("anthropic/claude-sonnet-5")).toBeUndefined();
  });

  it("identifies the Codex external route used by ChatGPT models", () => {
    expect(isChatGptModelRouting({ kind: "external", provider: "codex" })).toBe(true);
    expect(isChatGptModelRouting({ kind: "external", provider: "openai" })).toBe(false);
    expect(isChatGptModelRouting({ kind: "gateway", target: "openai" })).toBe(false);
  });
});
