import assert from "node:assert/strict";
import test from "node:test";

import { validatePublicRegistryRequirements } from "./validate-public-registry-requirements.mjs";

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
