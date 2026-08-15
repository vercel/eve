import { describe, expect, it } from "vitest";

import { EMPTY_DELIVERY_SENTINEL, hasEmptyDeliverySentinel } from "#shared/empty-delivery.js";

describe("hasEmptyDeliverySentinel", () => {
  it("recognizes the exact sentinel", () => {
    expect(hasEmptyDeliverySentinel(EMPTY_DELIVERY_SENTINEL)).toBe(true);
  });

  it("recognizes the sentinel anywhere in the response", () => {
    expect(hasEmptyDeliverySentinel(`before ${EMPTY_DELIVERY_SENTINEL} after`)).toBe(true);
  });

  it("rejects absent, empty, and partial sentinels", () => {
    expect(hasEmptyDeliverySentinel("<eve-empty-delivery>")).toBe(false);
    expect(hasEmptyDeliverySentinel("")).toBe(false);
    expect(hasEmptyDeliverySentinel(null)).toBe(false);
    expect(hasEmptyDeliverySentinel(undefined)).toBe(false);
  });
});
