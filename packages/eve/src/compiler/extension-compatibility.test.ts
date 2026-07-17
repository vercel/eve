import { describe, expect, it } from "vitest";

import {
  EXTENSION_CAPABILITY_SUPPORT,
  EXTENSION_CAPABILITY_VERSIONS,
  EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION,
  EXTENSION_COMPATIBILITY_MANIFEST_KIND,
  findUnsupportedExtensionCapabilities,
  parseExtensionCompatibilityManifest,
  serializeExtensionCompatibilityManifest,
  type ExtensionCapability,
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

  it("fails closed for capability names that collide with Object.prototype members", () => {
    const manifest = {
      kind: EXTENSION_COMPATIBILITY_MANIFEST_KIND,
      formatVersion: EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION,
      builtWithEve: "0.24.6",
      requires: { toString: 1, constructor: 1, hasOwnProperty: 2 },
    } as const;

    expect(findUnsupportedExtensionCapabilities(manifest)).toEqual([
      { capability: "constructor", requiredVersion: 1, supportedVersions: [] },
      { capability: "hasOwnProperty", requiredVersion: 2, supportedVersions: [] },
      { capability: "toString", requiredVersion: 1, supportedVersions: [] },
    ]);
  });

  it("supports every capability version it stamps", () => {
    for (const [capability, version] of Object.entries(EXTENSION_CAPABILITY_VERSIONS)) {
      expect(EXTENSION_CAPABILITY_SUPPORT[capability as ExtensionCapability]).toContain(version);
    }
  });
});
