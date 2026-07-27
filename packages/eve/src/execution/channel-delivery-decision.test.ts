import { describe, expect, it } from "vitest";

import { normalizeChannelDeliveryDecision } from "#execution/channel-delivery-decision.js";

describe("normalizeChannelDeliveryDecision", () => {
  it("preserves explicit decisions", () => {
    const decision = {
      action: "defer" as const,
      input: { message: "later" },
      reason: "classifier",
    };
    expect(normalizeChannelDeliveryDecision(decision)).toBe(decision);
  });

  it("normalizes StepInput as dispatch", () => {
    expect(normalizeChannelDeliveryDecision({ message: "now" })).toEqual({
      action: "dispatch",
      input: { message: "now" },
    });
  });

  it("normalizes void as drop", () => {
    expect(normalizeChannelDeliveryDecision(undefined)).toEqual({ action: "drop" });
  });
});
