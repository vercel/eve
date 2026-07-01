import { describe, expect, it } from "vitest";

import { classifyModelAuth } from "#internal/model-auth/classify.js";

describe("model auth classification", () => {
  it("maps gateway routing to AI Gateway auth", () => {
    expect(classifyModelAuth({ kind: "gateway", target: "openai" })).toEqual({
      kind: "ai-gateway",
    });
  });

  it("preserves external providers, including one named codex", () => {
    expect(classifyModelAuth({ kind: "external", provider: "codex" })).toEqual({
      kind: "external",
      provider: "codex",
    });
    expect(classifyModelAuth({ kind: "external", provider: "anthropic" })).toEqual({
      kind: "external",
      provider: "anthropic",
    });
  });
});
