import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolvePackageRoot } from "#internal/application/package.js";
import {
  DURABLE_CONTRACT_MANIFEST_FILENAME,
  serializeDurableContractManifest,
} from "#internal/durable-contract-registry.js";

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

    expect(manifest).toBe(serializeDurableContractManifest(packageJson.version));
  });
});
