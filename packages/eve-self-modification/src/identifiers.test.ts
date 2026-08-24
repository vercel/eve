import { describe, expect, it } from "vitest";

import { assertFullSha, assertGitRef, assertRepositoryPart } from "./identifiers.js";

describe("Git identifiers", () => {
  it("accepts deployment SHAs case-insensitively", () => {
    expect(() => assertFullSha("A".repeat(40), "revision")).not.toThrow();
  });

  it("rejects unsafe repository parts", () => {
    for (const value of [".", "..", "-owner", "owner/name"]) {
      expect(() => assertRepositoryPart(value, "repository owner")).toThrow(/invalid/u);
    }
  });

  it("rejects Git lock refs", () => {
    expect(() => assertGitRef("main.lock")).toThrow(/valid Git ref/u);
    expect(() => assertGitRef("heads/main.lock/next")).toThrow(/valid Git ref/u);
  });
});
