import { describe, expect, it } from "vitest";

import {
  COMPILE_METADATA_KIND,
  COMPILE_METADATA_VERSION,
  compileMetadataSchema,
  type CompileMetadata,
} from "#protocol/compile-metadata.js";

describe("compile metadata protocol", () => {
  it("accepts exact lowercase SHA-256 digests and integer diagnostic counts", () => {
    expect(compileMetadataSchema.safeParse(createMetadata()).success).toBe(true);
  });

  it.each([
    ["short", "abc"],
    ["uppercase", "A".repeat(64)],
    ["non-hex", "g".repeat(64)],
  ])("rejects a %s digest", (_name, sha256) => {
    const metadata = createMetadata();

    expect(
      compileMetadataSchema.safeParse({
        ...metadata,
        compile: {
          ...metadata.compile,
          manifest: { ...metadata.compile.manifest, sha256 },
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    { errors: -1, warnings: 0 },
    { errors: 0, warnings: 0.5 },
  ])("rejects invalid diagnostic counts %#", (summary) => {
    const metadata = createMetadata();

    expect(
      compileMetadataSchema.safeParse({
        ...metadata,
        discovery: { ...metadata.discovery, summary },
      }).success,
    ).toBe(false);
  });
});

function createMetadata(): CompileMetadata {
  return {
    compile: {
      manifest: { path: ".eve/compile/compiled-agent-manifest.json", sha256: "a".repeat(64) },
      moduleMap: {
        identitySha256: "f".repeat(64),
        path: ".eve/compile/module-map.mjs",
        sha256: "b".repeat(64),
      },
    },
    discovery: {
      diagnostics: { path: ".eve/discovery/diagnostics.json", sha256: "c".repeat(64) },
      manifest: {
        path: ".eve/discovery/agent-discovery-manifest.json",
        sha256: "d".repeat(64),
      },
      sourceGraphHash: "e".repeat(64),
      summary: { errors: 0, warnings: 0 },
    },
    generator: { name: "eve", version: "0.0.0-test" },
    kind: COMPILE_METADATA_KIND,
    status: "ready",
    version: COMPILE_METADATA_VERSION,
  };
}
