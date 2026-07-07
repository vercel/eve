import { describe, expect, it } from "vitest";

import { resolveSubagentCallMessage } from "#execution/subagent-invocation.js";

describe("resolveSubagentCallMessage", () => {
  it("returns the input message string by default", () => {
    expect(resolveSubagentCallMessage({ callInput: { message: "find the marker" } })).toBe(
      "find the marker",
    );
  });

  it("serializes structured input without a message field", () => {
    expect(resolveSubagentCallMessage({ callInput: { city: "Seoul", days: 3 } })).toBe(
      '{"city":"Seoul","days":3}',
    );
  });

  it("prefers a definition formatInput over the default derivation", () => {
    expect(
      resolveSubagentCallMessage({
        callInput: { city: "Seoul", message: "ignored" },
        formatInput: (input) => `city=${input.city}`,
      }),
    ).toBe("city=Seoul");
  });
});
