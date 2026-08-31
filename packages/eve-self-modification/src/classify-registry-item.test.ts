import { describe, expect, it } from "vitest";

import { classifyCatalogEntry } from "../extension/classify-registry-item.js";
import type { CatalogEntry } from "../extension/tools/search_registry.js";

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    address: "extension/browserbase",
    title: "Browserbase",
    ...overrides,
  };
}

describe("classifyCatalogEntry", () => {
  it("installs an item that declares no setup and no components", () => {
    expect(classifyCatalogEntry(entry())).toEqual({ kind: "installable" });
  });

  it("hands a setup-bearing item to the terminal", () => {
    const result = classifyCatalogEntry(entry({ address: "channel/slack", declaresSetup: true }));
    expect(result.kind).toBe("needs-terminal");
    expect(result).toHaveProperty("reason", expect.stringContaining("setup flow"));
  });

  it("hands a bundle to the terminal and names its components", () => {
    const result = classifyCatalogEntry(
      entry({ address: "linear", components: ["channel/linear-agent", "connection/linear"] }),
    );
    expect(result.kind).toBe("needs-terminal");
    expect(result).toHaveProperty("reason", expect.stringContaining("channel/linear-agent"));
  });

  it("hands over a bundle that also declares setup", () => {
    expect(
      classifyCatalogEntry(entry({ components: ["channel/x"], declaresSetup: true })).kind,
    ).toBe("needs-terminal");
  });

  it("treats an empty components list as no bundle", () => {
    expect(classifyCatalogEntry(entry({ components: [] })).kind).toBe("installable");
  });
});
