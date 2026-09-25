import { describe, expect, it } from "vitest";

import { classifyCatalogEntry } from "./extension/classify-registry-item.js";
import type { CatalogEntry } from "./extension/subagents/agent/tools/search_registry.js";

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    address: "extension/browserbase",
    title: "Browserbase",
    ...overrides,
  };
}

describe("classifyCatalogEntry", () => {
  it("installs an item that declares no setup", () => {
    expect(classifyCatalogEntry(entry())).toEqual({ kind: "installable" });
  });

  it("hands a setup-bearing item to the terminal", () => {
    const result = classifyCatalogEntry(entry({ address: "channel/slack", declaresSetup: true }));
    expect(result.kind).toBe("needs-terminal");
    expect(result).toHaveProperty("reason", expect.stringContaining("setup flow"));
  });
});
