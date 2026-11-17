import { describe, expect, it } from "vitest";
import { ATTRIBUTE_VALUE_MAX_BYTES } from "@workflow/world";

import { EVE_ATTRIBUTE_VALUE_MAX_BYTES } from "#runtime/attributes/emit.js";

describe("EVE_ATTRIBUTE_VALUE_MAX_BYTES drift guard", () => {
  it("matches @workflow/world's ATTRIBUTE_VALUE_MAX_BYTES", () => {
    expect(EVE_ATTRIBUTE_VALUE_MAX_BYTES).toBe(ATTRIBUTE_VALUE_MAX_BYTES);
  });
});
