import { describe, expect, it } from "vitest";

import { answerSchema, isAnswer } from "#shared/input.js";

describe("answerSchema", () => {
  it("accepts an answer by option or text, naming its interaction", () => {
    expect(isAnswer({ interactionId: "i-1", optionId: "approve" })).toBe(true);
    expect(isAnswer({ interactionId: "i-1", text: "yes" })).toBe(true);
    expect(answerSchema.parse({ interactionId: "i-1" })).toEqual({ interactionId: "i-1" });
  });

  it("rejects an answer without its interaction, or with fields it doesn't know", () => {
    expect(isAnswer({ optionId: "approve" })).toBe(false);
    expect(isAnswer({ interactionId: "i-1", requestId: "i-1" })).toBe(false);
  });
});
