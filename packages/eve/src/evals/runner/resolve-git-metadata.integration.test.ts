import { describe, expect, it } from "vitest";

import { resolveLocalGitMetadata } from "#evals/runner/resolve-git-metadata.js";

describe("resolveLocalGitMetadata", () => {
  it("returns sha and branch for the current repo", () => {
    const metadata = resolveLocalGitMetadata(process.cwd());
    expect(metadata.sha).toBeDefined();
    expect(typeof metadata.sha).toBe("string");
    expect(metadata.sha?.length).toBeGreaterThan(0);
  });

  it("returns empty metadata for a non-git directory", () => {
    const metadata = resolveLocalGitMetadata("/tmp");
    expect(metadata.sha).toBeUndefined();
    expect(metadata.branch).toBeUndefined();
  });
});
