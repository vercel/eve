import { describe, expect, it } from "vitest";

import { activeTurnId } from "#harness/active-turn-id.js";

describe("activeTurnId", () => {
  it("returns the in-flight turn id when a turn is active", () => {
    expect(
      activeTurnId({ sessionStarted: true, sequence: 3, stepIndex: 1, turnId: "turn_3" }),
    ).toBe("turn_3");
  });

  it("mints the next turn id from the sequence between turns", () => {
    expect(activeTurnId({ sessionStarted: true, sequence: 4, stepIndex: 0, turnId: "" })).toBe(
      "turn_4",
    );
  });
});
