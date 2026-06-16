import { describe, expect, it } from "vitest";

import { resolveLocalGitMetadata } from "#evals/runner/resolve-git-metadata.js";

describe("resolveLocalGitMetadata", () => {
  it("returns sha and branch for the current repo", () => {
    // The test itself runs from within a git repo
    const metadata = resolveLocalGitMetadata(process.cwd());
    expect(metadata.sha).toBeDefined();
    expect(typeof metadata.sha).toBe("string");
    expect(metadata.sha?.length).toBeGreaterThan(0);
    // Branch may be undefined in detached HEAD CI, but sha should always exist
  });

  it("returns empty metadata for a non-git directory", () => {
    const metadata = resolveLocalGitMetadata("/tmp");
    // /tmp is not a git repo, so both should be undefined
    expect(metadata.sha).toBeUndefined();
    expect(metadata.branch).toBeUndefined();
  });
});
