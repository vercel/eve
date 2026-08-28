import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolvePackageRoot } from "#internal/application/package.js";
import { DURABLE_CONTRACT_MANIFEST_FILENAME } from "#internal/durable-contract-registry.js";

describe("durable contract build manifest", () => {
  it("matches the package version and current registry", async () => {
    const packageRoot = resolvePackageRoot();
    const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
      readonly version: string;
    };
    const manifest = await readFile(
      join(packageRoot, "dist", DURABLE_CONTRACT_MANIFEST_FILENAME),
      "utf8",
    );
    const buildModuleUrl = new URL(
      "../../scripts/durable-contract-manifest-build.mjs",
      import.meta.url,
    );
    const { canonicalJson, serializeBuildDurableContractManifest } = (await import(
      buildModuleUrl.href
    )) as {
      readonly canonicalJson: (value: unknown) => string;
      readonly serializeBuildDurableContractManifest: (builtWithEve: string) => string;
    };

    expect(canonicalJson({ b: 1, a: { d: 2, c: true } })).toBe('{"a":{"c":true,"d":2},"b":1}');
    expect(() => canonicalJson(undefined)).toThrow(/cannot encode undefined/);
    expect(() => canonicalJson(Number.NaN)).toThrow(/cannot encode NaN/);
    expect(manifest).toBe(serializeBuildDurableContractManifest(packageJson.version));
    expect(JSON.parse(manifest)).toMatchObject({
      dataContracts: expect.arrayContaining([
        {
          acceptedVersions: [0, 1],
          currentVersion: 1,
          name: "sessionInboxWire",
          schemaHashes: { 0: null, 1: expect.stringMatching(/^sha256:[\da-f]{64}$/u) },
        },
      ]),
      formatVersion: 2,
    });
  });
});
