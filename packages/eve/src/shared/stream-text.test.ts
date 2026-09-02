import { describe, expect, it } from "vitest";

import { applyStreamTextDelta } from "#shared/stream-text.js";

describe("applyStreamTextDelta", () => {
  it("starts, appends, and restarts a text block", () => {
    expect(applyStreamTextDelta(undefined, true, "Hel")).toBe("Hel");
    expect(applyStreamTextDelta("Hel", false, "lo")).toBe("Hello");
    expect(applyStreamTextDelta("Hello", true, "New")).toBe("New");
  });

  it("rejects a continuation without the block start", () => {
    expect(applyStreamTextDelta(undefined, false, "lo")).toBeUndefined();
  });
});
