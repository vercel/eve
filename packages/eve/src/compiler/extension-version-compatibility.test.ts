import { describe, expect, it } from "vitest";

import {
  checkExtensionVersionCompatibility,
  EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION,
  EXTENSION_COMPATIBILITY_MANIFEST_KIND,
  parseExtensionCompatibilityManifest,
  serializeExtensionCompatibilityManifest,
} from "#compiler/extension-compatibility.js";

const manifest = {
  kind: EXTENSION_COMPATIBILITY_MANIFEST_KIND,
  formatVersion: EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION,
  builtWithEve: "1.3.2",
  contractMajor: 1,
  build: { externalDependencies: ["@acme/runtime-sdk"] },
} as const;
const path = "/pkg/dist/extension/_manifest.json";

describe("version-based extension compatibility", () => {
  it("round-trips the build version and external dependency metadata", () => {
    expect(
      parseExtensionCompatibilityManifest(serializeExtensionCompatibilityManifest(manifest), path),
    ).toEqual(manifest);
  });

  it("accepts an older build on newer patch and minor releases, not the reverse", () => {
    expect(checkExtensionVersionCompatibility(manifest, "1.3.2", [1])).toBeUndefined();
    expect(checkExtensionVersionCompatibility(manifest, "1.3.4", [1])).toBeUndefined();
    expect(checkExtensionVersionCompatibility(manifest, "1.3.4-rc.1", [1])).toBeUndefined();
    expect(checkExtensionVersionCompatibility(manifest, "1.4.0", [1])).toBeUndefined();
    expect(checkExtensionVersionCompatibility(manifest, "1.3.1", [1])).toEqual({
      kind: "newer-eve",
      minimumVersion: "1.3.2",
    });
  });

  it("requires an explicit decision before accepting another distribution generation", () => {
    expect(checkExtensionVersionCompatibility(manifest, "2.0.0", [])).toEqual({
      kind: "unsupported-contract",
      contractMajor: 1,
    });
    expect(checkExtensionVersionCompatibility(manifest, "2.0.0", [1])).toBeUndefined();
    expect(
      checkExtensionVersionCompatibility({ ...manifest, contractMajor: 2 }, "2.0.0", [1]),
    ).toEqual({
      kind: "unsupported-contract",
      contractMajor: 2,
    });
  });

  it("retains RC builds at 1.0 unless the distribution generation is dropped", () => {
    const rc = { ...manifest, builtWithEve: "0.85.0", contractMajor: 0 };
    expect(checkExtensionVersionCompatibility(rc, "1.0.0", [0])).toBeUndefined();
    expect(checkExtensionVersionCompatibility(rc, "1.0.0", [1])).toEqual({
      kind: "unsupported-contract",
      contractMajor: 0,
    });
  });

  it.each([1, 2])("rejects old epoch format %i with rebuild guidance", (formatVersion) => {
    expect(() =>
      parseExtensionCompatibilityManifest(
        JSON.stringify({
          kind: "eve-extension",
          formatVersion,
          builtWithEve: "0.82.0",
          requires: { extension: 2 },
        }),
        path,
      ),
    ).toThrow(/old epoch format/);
  });

  it("rejects invalid versions and unexpected fields", () => {
    for (const extra of [
      { builtWithEve: "not-a-version" },
      { builtWithEve: "1.3.2 || 1.4.0" },
      { requires: { tool: 1 } },
    ]) {
      expect(() =>
        parseExtensionCompatibilityManifest(JSON.stringify({ ...manifest, ...extra }), path),
      ).toThrow(/invalid/);
    }
    expect(checkExtensionVersionCompatibility(manifest, "unknown", [1])).toEqual({
      kind: "newer-eve",
      minimumVersion: "1.3.2",
    });
  });
});
