import { describe, expect, it } from "vitest";

import { modelAuthForRouting } from "#internal/model-auth/classify.js";

describe("model auth classification", () => {
  it("maps gateway routing to AI Gateway auth", () => {
    expect(modelAuthForRouting({ kind: "gateway", target: "openai" })).toEqual({
      kind: "ai-gateway",
    });
  });

  it("maps Codex routing to Codex auth", () => {
    expect(modelAuthForRouting({ kind: "external", provider: "codex" })).toEqual({
      kind: "codex",
    });
  });

  it("preserves non-Codex external providers", () => {
    expect(modelAuthForRouting({ kind: "external", provider: "anthropic" })).toEqual({
      kind: "external",
      provider: "anthropic",
    });
  });
});
