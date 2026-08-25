import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCanaryVersion, prepareCanaryRelease } from "./prepare-canary-release.mjs";

const sha = "d2995e12e1234567890abcdef1234567890abcde";

test("appends the short commit ID to the current semver", () => {
  assert.equal(createCanaryVersion("0.44.4", sha), "0.44.4-d2995e12e123");
});

test("keeps an all-numeric short ID valid semver", () => {
  const numericSha = "0123456789012345678901234567890123456789";
  assert.equal(createCanaryVersion("0.44.4", numericSha), "0.44.4-g012345678901");
});

test("updates the eve package version", async () => {
  const root = await mkdtemp(join(tmpdir(), "eve-canary-release-"));
  const packagePath = join(root, "package.json");

  try {
    await writeFile(packagePath, JSON.stringify({ name: "eve", version: "0.44.4" }));
    const version = await prepareCanaryRelease(sha, packagePath);
    const packageJson = JSON.parse(await readFile(packagePath, "utf8"));

    assert.equal(version, "0.44.4-d2995e12e123");
    assert.equal(packageJson.version, version);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("rejects invalid version inputs", () => {
  assert.throws(() => createCanaryVersion("canary", sha), /invalid base version/u);
  assert.throws(() => createCanaryVersion("0.44.4", "not-a-sha"), /invalid git SHA/u);
});
