import { describe, expect, it } from "vitest";

import { modelAuthAdapterForRouting } from "#internal/model-auth/adapters.js";

describe("model auth adapters", () => {
  it("maps gateway routing to AI Gateway auth", () => {
    expect(modelAuthAdapterForRouting({ kind: "gateway", target: "openai" }).auth).toEqual({
      kind: "ai-gateway",
    });
  });

  it("maps Codex routing to Codex auth", () => {
    expect(modelAuthAdapterForRouting({ kind: "external", provider: "codex" }).auth).toEqual({
      kind: "codex",
    });
  });

  it("preserves non-Codex external providers", () => {
    expect(modelAuthAdapterForRouting({ kind: "external", provider: "anthropic" }).auth).toEqual({
      kind: "external",
      provider: "anthropic",
    });
  });
});
