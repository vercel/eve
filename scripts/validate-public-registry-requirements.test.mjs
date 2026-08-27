import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  validatePublicRegistryRequirements,
  validatePublicRegistryRequirementsFromFiles,
} from "./validate-public-registry-requirements.mjs";

function registry(requirement) {
  return { items: [{ name: "channel/github", meta: { eve: { requires: requirement } } }] };
}

test("accepts public requirements satisfied by the published Eve version", () => {
  assert.doesNotThrow(() => validatePublicRegistryRequirements(registry(">=0.31.3"), "0.31.3"));
});

test("rejects public requirements for an unpublished Eve version with staging guidance", () => {
  assert.throws(
    () => validatePublicRegistryRequirements(registry(">=0.31.4"), "0.31.3"),
    /registry\.staged-requirements\.json/u,
  );
});

test("resolves repository files independently of the current working directory", async () => {
  const previousWorkingDirectory = process.cwd();
  try {
    process.chdir(tmpdir());
    await assert.doesNotReject(validatePublicRegistryRequirementsFromFiles());
  } finally {
    process.chdir(previousWorkingDirectory);
  }
});
