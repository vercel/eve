import { describe, expect, it } from "vitest";

import { parseExtensionPackageRoots } from "#shared/extension-package-contract.js";

describe("parseExtensionPackageRoots", () => {
  it("parses source and dist roots", () => {
    expect(
      parseExtensionPackageRoots({
        source: "extension",
        dist: "dist/extension",
        externalDependencies: ["sharp", "sharp", "@acme/runtime"],
      }),
    ).toEqual({
      source: "extension",
      dist: "dist/extension",
      externalDependencies: ["sharp", "@acme/runtime"],
    });
  });

  it("accepts a dist-only published package", () => {
    expect(parseExtensionPackageRoots({ dist: "dist/extension" })).toEqual({
      dist: "dist/extension",
    });
  });

  it("rejects missing or empty dist", () => {
    expect(parseExtensionPackageRoots({ source: "extension" })).toBeNull();
    expect(parseExtensionPackageRoots({ source: "extension", dist: "" })).toBeNull();
  });

  it("rejects a present but invalid source", () => {
    expect(parseExtensionPackageRoots({ source: "", dist: "dist/extension" })).toBeNull();
    expect(parseExtensionPackageRoots({ source: 7, dist: "dist/extension" })).toBeNull();
  });

  it("rejects invalid external dependency declarations", () => {
    expect(
      parseExtensionPackageRoots({ dist: "dist/extension", externalDependencies: "sharp" }),
    ).toBeNull();
    expect(
      parseExtensionPackageRoots({ dist: "dist/extension", externalDependencies: [""] }),
    ).toBeNull();
    expect(
      parseExtensionPackageRoots({ dist: "dist/extension", externalDependencies: [7] }),
    ).toBeNull();
  });

  it("rejects non-object contracts", () => {
    expect(parseExtensionPackageRoots("extension")).toBeNull();
    expect(parseExtensionPackageRoots(["extension"])).toBeNull();
    expect(parseExtensionPackageRoots(null)).toBeNull();
    expect(parseExtensionPackageRoots(undefined)).toBeNull();
  });
});
