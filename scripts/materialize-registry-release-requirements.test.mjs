import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  materializeRegistryReleaseRequirements,
  materializeRegistryRequirements,
} from "./materialize-registry-release-requirements.mjs";

function registry() {
  return { items: [{ name: "channel/github", meta: { eve: { requires: ">=0.30.7" } } }] };
}

test("updates only staged requirements at the selected release version", () => {
  const result = materializeRegistryRequirements(
    registry(),
    { items: ["channel/github"] },
    "0.32.0",
  );
  assert.equal(result.items[0].meta.eve.requires, ">=0.32.0");
});

test("consumes staged requirements after materializing the release registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "eve-registry-release-"));
  const registryPath = join(root, "registry.json");
  const requirementsPath = join(root, "requirements.json");
  const packagePath = join(root, "package.json");
  try {
    await Promise.all([
      writeFile(registryPath, JSON.stringify(registry())),
      writeFile(requirementsPath, JSON.stringify({ items: ["channel/github"] })),
      writeFile(packagePath, JSON.stringify({ version: "0.32.0" })),
    ]);
    await materializeRegistryReleaseRequirements({ packagePath, registryPath, requirementsPath });
    assert.equal(
      JSON.parse(await readFile(registryPath, "utf8")).items[0].meta.eve.requires,
      ">=0.32.0",
    );
    await assert.rejects(readFile(requirementsPath, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("does nothing when no staged requirements exist", async () => {
  const root = await mkdtemp(join(tmpdir(), "eve-registry-release-"));
  const registryPath = join(root, "registry.json");
  const requirementsPath = join(root, "missing.json");
  const packagePath = join(root, "package.json");
  try {
    await writeFile(registryPath, JSON.stringify(registry()));
    await materializeRegistryReleaseRequirements({ packagePath, registryPath, requirementsPath });
    assert.deepEqual(JSON.parse(await readFile(registryPath, "utf8")), registry());
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("rejects an unknown staged registry item", () => {
  assert.throws(
    () => materializeRegistryRequirements(registry(), { items: ["channel/missing"] }, "0.32.0"),
    /unknown item/u,
  );
});
