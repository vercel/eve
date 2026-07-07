import { describe, expect, it } from "vitest";

import { mountNamespace, packageStateNamespace } from "#discover/extensions.js";

describe("mountNamespace", () => {
  it("derives the namespace from the mount filename", () => {
    expect(mountNamespace("extensions/crm.ts")).toBe("crm");
    expect(mountNamespace("extensions/toolkit.mts")).toBe("toolkit");
  });
});

describe("packageStateNamespace", () => {
  it("keeps a plain package name", () => {
    expect(packageStateNamespace("toolkit-extension")).toBe("toolkit-extension");
  });

  it("flattens a scoped package name", () => {
    expect(packageStateNamespace("@acme/crm")).toBe("acme-crm");
  });

  it("replaces characters that are unsafe in a key segment", () => {
    expect(packageStateNamespace("@acme/crm.tools")).toBe("acme-crm.tools");
  });

  it("falls back to a stable token for a degenerate name", () => {
    expect(packageStateNamespace("@")).toBe("extension");
  });
});
