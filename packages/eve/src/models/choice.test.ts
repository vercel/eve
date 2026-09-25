import { describe, expect, it } from "vitest";

import { choice } from "#models/choice.js";

const fallback = { providerOptions: { gateway: { models: ["anthropic/claude-opus-4.7"] } } };

describe("choice", () => {
  it("keeps list order and accepts described entries", () => {
    expect(
      choice(["openai/gpt-5.4-mini", { model: "openai/gpt-5.4", description: "Hard work." }]),
    ).toEqual({
      kind: "eve.model-choice",
      choices: [
        { model: "openai/gpt-5.4-mini" },
        { model: "openai/gpt-5.4", description: "Hard work." },
      ],
    });
  });

  it("reads a mapping from slug to description or options", () => {
    expect(
      choice({
        "openai/gpt-5.4-mini": "Quick drafts.",
        "openai/gpt-5.4": { description: "Hard work.", modelOptions: fallback },
      }).choices,
    ).toEqual([
      { model: "openai/gpt-5.4-mini", description: "Quick drafts." },
      { model: "openai/gpt-5.4", description: "Hard work.", modelOptions: fallback },
    ]);
  });

  it.each([
    [[], "non-empty list"],
    [{}, "non-empty list"],
    [[{ description: "No model." }], 'must set "model"'],
    [{ "openai/gpt-5.4": { model: "openai/gpt-5.4-mini" } }, "its key is the model"],
  ])("rejects %j", (input, error) => {
    expect(() => choice(input as never)).toThrow(error);
  });
});
