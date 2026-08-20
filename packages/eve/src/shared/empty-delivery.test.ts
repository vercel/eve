import { describe, expect, it } from "vitest";

import {
  EMPTY_DELIVERY_SENTINEL,
  hasEmptyDeliverySentinel,
  TASK_DELIVERY_INSTRUCTION,
} from "#shared/empty-delivery.js";

describe("TASK_DELIVERY_INSTRUCTION", () => {
  it("uses runtime task state to defer intermediate results and consolidate the final report", () => {
    expect(TASK_DELIVERY_INSTRUCTION).toContain("[Task state]");
    expect(TASK_DELIVERY_INSTRUCTION).toContain("runtime-authored");
    expect(TASK_DELIVERY_INSTRUCTION).toContain("terminal output");
    expect(TASK_DELIVERY_INSTRUCTION).toContain("If any task is pending");
    expect(TASK_DELIVERY_INSTRUCTION).toContain("When no task is pending");
    expect(TASK_DELIVERY_INSTRUCTION).toContain("do not use the sentinel");
    expect(TASK_DELIVERY_INSTRUCTION).toContain(EMPTY_DELIVERY_SENTINEL);
  });
});

describe("hasEmptyDeliverySentinel", () => {
  it("recognizes the exact sentinel", () => {
    expect(hasEmptyDeliverySentinel(EMPTY_DELIVERY_SENTINEL)).toBe(true);
  });

  it("recognizes an HTML-escaped sentinel", () => {
    expect(hasEmptyDeliverySentinel("&lt;eve-empty-delivery/&gt;")).toBe(true);
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
