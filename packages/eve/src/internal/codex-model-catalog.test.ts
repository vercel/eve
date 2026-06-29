import { describe, expect, it, vi } from "vitest";

import {
  fetchCodexModelCatalog,
  formatCodexModelId,
  parseCodexModelCatalog,
  parseCodexModelId,
  selectableCodexModels,
  type CodexModelCatalogCommand,
} from "#internal/codex-model-catalog.js";

describe("Codex model catalog", () => {
  it("parses the raw Codex catalog into eve-owned model entries", () => {
    const models = parseCodexModelCatalog(
      `warning before json
{"models":[{"slug":"gpt-5.5","display_name":"GPT-5.5","context_window":272000,"visibility":"list"},{"slug":"hidden","visibility":"hidden"}]}`,
    );

    expect(models).toEqual([
      {
        slug: "gpt-5.5",
        displayName: "GPT-5.5",
        contextWindowTokens: 272000,
        visibility: "list",
      },
      { slug: "hidden", displayName: "hidden", visibility: "hidden" },
    ]);
  });

  it("falls back to the bundled catalog when the refreshed catalog fails", async () => {
    const command = vi.fn<CodexModelCatalogCommand>(async (args) => {
      if (!args.includes("--bundled")) {
        throw new Error("remote unavailable");
      }
      return { stdout: '{"models":[{"slug":"gpt-5.4","display_name":"GPT-5.4"}]}' };
    });

    await expect(fetchCodexModelCatalog({ command })).resolves.toEqual([
      { slug: "gpt-5.4", displayName: "GPT-5.4" },
    ]);
    expect(command).toHaveBeenCalledWith(["debug", "models"], { signal: undefined });
    expect(command).toHaveBeenCalledWith(["debug", "models", "--bundled"], {
      signal: undefined,
    });
  });

  it("formats, parses, and filters model ids for eve selection", () => {
    expect(formatCodexModelId("gpt-5.5")).toBe("codex/gpt-5.5");
    expect(parseCodexModelId("codex/gpt-5.5")).toBe("gpt-5.5");
    expect(parseCodexModelId("openai/gpt-5.5")).toBeNull();
    expect(
      selectableCodexModels([
        { slug: "z-model", displayName: "Z model", visibility: "list" },
        { slug: "hidden", displayName: "Hidden", visibility: "hidden" },
        { slug: "a-model", displayName: "A model" },
      ]).map((model) => model.slug),
    ).toEqual(["a-model", "z-model"]);
  });
});
