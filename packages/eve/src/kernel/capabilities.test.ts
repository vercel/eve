import { describe, expect, it } from "vitest";

import {
  getKernelCapabilityAtPath,
  getReplaceableKernelCapabilityAtPath,
} from "#kernel/capabilities.js";

describe("kernel capability paths", () => {
  it("uses canonical module identity across authored extensions", () => {
    expect(getKernelCapabilityAtPath("tools/agent.mjs")).toBe("agent");
    expect(getReplaceableKernelCapabilityAtPath("tools/web_search.cts")).toBe("web_search");
  });

  it("keeps reserved capabilities non-replaceable", () => {
    expect(getKernelCapabilityAtPath("tools/final_output.js")).toBe("final_output");
    expect(getReplaceableKernelCapabilityAtPath("tools/final_output.js")).toBeUndefined();
  });
});
