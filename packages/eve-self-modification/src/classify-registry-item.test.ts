import { describe, expect, it } from "vitest";

import { classifyCatalogEntry, isOfficialAddress } from "../extension/classify-registry-item.js";
import type { CatalogEntry } from "../extension/tools/search_registry.js";

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    address: "extension/browserbase",
    title: "Browserbase",
    ...overrides,
  };
}

describe("isOfficialAddress", () => {
  it("accepts relative official addresses", () => {
    expect(isOfficialAddress("channel/slack")).toBe(true);
    expect(isOfficialAddress("linear")).toBe(true);
    expect(isOfficialAddress("experimental/self-modification")).toBe(true);
  });

  it("rejects everything v1 routes elsewhere", () => {
    expect(isOfficialAddress("@acme/widget")).toBe(false);
    expect(isOfficialAddress("https://example.com/item.json")).toBe(false);
    expect(isOfficialAddress("@skills/writing")).toBe(false);
    expect(isOfficialAddress("../etc/passwd")).toBe(false);
    expect(isOfficialAddress("channel/slack;rm -rf /")).toBe(false);
    expect(isOfficialAddress("--overwrite")).toBe(false);
    expect(isOfficialAddress("Channel/Slack")).toBe(false);
  });
});

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
