import { describe, expect, it } from "vitest";

import {
  EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION,
  EXTENSION_COMPATIBILITY_MANIFEST_KIND,
  findUnsupportedExtensionCapabilities,
  parseExtensionCompatibilityManifest,
  serializeExtensionCompatibilityManifest,
} from "#compiler/extension-compatibility.js";

describe("extension compatibility manifest", () => {
  it("round-trips compatibility metadata without compiled contributions", () => {
    const manifest = {
      kind: EXTENSION_COMPATIBILITY_MANIFEST_KIND,
      formatVersion: EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION,
      builtWithEve: "0.24.6",
      requires: { extension: 1, tool: 1 },
    } as const;

    expect(
      parseExtensionCompatibilityManifest(
        serializeExtensionCompatibilityManifest(manifest),
        "/pkg/dist/extension/_manifest.json",
      ),
    ).toEqual(manifest);
  });

  it("rejects executable or contribution fields", () => {
    expect(() =>
      parseExtensionCompatibilityManifest(
        JSON.stringify({
          kind: EXTENSION_COMPATIBILITY_MANIFEST_KIND,
          formatVersion: EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION,
          builtWithEve: "0.24.6",
          requires: { extension: 1 },
          contributions: { tools: [] },
        }),
        "/pkg/dist/extension/_manifest.json",
      ),
    ).toThrow(/invalid/);
  });

  it("checks only required capabilities and fails closed for unknown contracts", () => {
    const manifest = {
      kind: EXTENSION_COMPATIBILITY_MANIFEST_KIND,
      formatVersion: EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION,
      builtWithEve: "0.24.6",
      requires: { extension: 1, tool: 1 },
    } as const;

    expect(
      findUnsupportedExtensionCapabilities(manifest, {
        extension: [1],
        tool: [1],
        skill: [2],
      }),
    ).toEqual([]);
    expect(
      findUnsupportedExtensionCapabilities(
        { ...manifest, requires: { futureCapability: 1, tool: 2 } },
        { extension: [1], tool: [1] },
      ),
    ).toEqual([
      { capability: "futureCapability", requiredVersion: 1, supportedVersions: [] },
      { capability: "tool", requiredVersion: 2, supportedVersions: [1] },
    ]);
  });
});
