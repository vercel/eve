import { describe, expect, it } from "vitest";

import {
  codexModelSlugFromGatewayId,
  codexModelsFromGatewayCatalog,
  formatCodexModelId,
  parseCodexModelId,
  selectableCodexModels,
} from "#internal/codex-model-catalog.js";

describe("Codex model catalog", () => {
  it("maps OpenAI Gateway model ids into Codex model ids", () => {
    expect(formatCodexModelId("gpt-5.5")).toBe("codex/gpt-5.5");
    expect(parseCodexModelId("codex/gpt-5.5")).toBe("gpt-5.5");
    expect(parseCodexModelId("openai/gpt-5.5")).toBeNull();
    expect(codexModelSlugFromGatewayId("openai/gpt-5.5")).toBe("gpt-5.5");
    expect(codexModelSlugFromGatewayId("anthropic/claude-sonnet-4.6")).toBeNull();
  });

  it("derives selectable Codex models from the OpenAI Gateway catalog entries", () => {
    expect(
      codexModelsFromGatewayCatalog([
        { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6", type: "language" },
        { id: "openai/gpt-5.5", name: "GPT-5.5", type: "language" },
        { id: "openai/gpt-image-2", name: "GPT Image 2", type: "image" },
        { id: "openai/gpt-5.5", name: "Duplicate GPT-5.5", type: "language" },
      ]),
    ).toEqual([{ slug: "gpt-5.5", displayName: "GPT-5.5" }]);
  });

  it("filters and sorts selectable models", () => {
    expect(
      selectableCodexModels([
        { slug: "z-model", displayName: "Z model", visibility: "list" },
        { slug: "hidden", displayName: "Hidden", visibility: "hidden" },
        { slug: "a-model", displayName: "A model" },
      ]).map((model) => model.slug),
    ).toEqual(["a-model", "z-model"]);
  });
});
