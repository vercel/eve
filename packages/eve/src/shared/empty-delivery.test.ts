import { describe, expect, it } from "vitest";

import { EMPTY_DELIVERY_SENTINEL, hasEmptyDeliverySentinel } from "#shared/empty-delivery.js";

describe("hasEmptyDeliverySentinel", () => {
  describe.each([EMPTY_DELIVERY_SENTINEL, "&lt;eve-empty-delivery/&gt;"])("%s", (sentinel) => {
    it("recognizes a standalone sentinel with optional surrounding whitespace", () => {
      expect(hasEmptyDeliverySentinel(sentinel)).toBe(true);
      expect(hasEmptyDeliverySentinel(` \n${sentinel}\t `)).toBe(true);
    });

    it.each([
      `before ${sentinel}`,
      `${sentinel} after`,
      `before ${sentinel} after`,
      `\`${sentinel}\``,
      `\`\`\`\n${sentinel}\n\`\`\``,
      `${sentinel}\n${sentinel}`,
    ])("preserves message content: %s", (message) => {
      expect(hasEmptyDeliverySentinel(message)).toBe(false);
    });
  });

  it("rejects absent, empty, and partial sentinels", () => {
    expect(hasEmptyDeliverySentinel("<eve-empty-delivery>")).toBe(false);
    expect(hasEmptyDeliverySentinel("")).toBe(false);
    expect(hasEmptyDeliverySentinel(" \n\t")).toBe(false);
    expect(hasEmptyDeliverySentinel(null)).toBe(false);
    expect(hasEmptyDeliverySentinel(undefined)).toBe(false);
  });
});
