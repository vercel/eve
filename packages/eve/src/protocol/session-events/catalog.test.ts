import { describe, expect, it } from "vitest";

import { textOfPart } from "#protocol/session-events/catalog.js";

describe("textOfPart", () => {
  it("shows a text part's text and another kind's fallback text", () => {
    expect(textOfPart({ kind: "text", value: "Deploys were up." })).toBe("Deploys were up.");
    expect(textOfPart({ fallbackText: "Deploys: 1,284", kind: "card", value: {} })).toBe(
      "Deploys: 1,284",
    );
  });

  it("shows nothing for reasoning, results, files, or an empty part", () => {
    expect(textOfPart({ fallbackText: "x", kind: "reasoning", value: "thinking" })).toBeUndefined();
    expect(textOfPart({ fallbackText: "x", kind: "result", value: { ok: true } })).toBeUndefined();
    expect(textOfPart({ kind: "card", value: {} })).toBeUndefined();
    expect(textOfPart({ kind: "text", value: "" })).toBeUndefined();
  });
});
