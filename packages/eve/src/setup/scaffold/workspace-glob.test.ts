import { describe, expect, it } from "vitest";

import {
  workspacePatternClaimsRelativePath,
  workspacePatternForProject,
  workspacePatternsClaimProject,
} from "./workspace-glob.js";

describe("workspace glob helpers", () => {
  it.each([
    ["apps/web", "apps/web", true],
    ["./apps/*", "apps/web", true],
    ["apps/*", "apps/web/nested", false],
    ["apps/**", "apps/web/nested", true],
    ["packages/*/fixtures", "packages/eve/fixtures", true],
    ["packages/*/fixtures", "packages/eve/test/fixtures", false],
  ] as const)("checks whether pattern %j claims %j", (pattern, relativePath, expected) => {
    expect(workspacePatternClaimsRelativePath(pattern, relativePath)).toBe(expected);
  });

  it("applies negative patterns after positive matches", () => {
    expect(
      workspacePatternsClaimProject(
        ["apps/**", "!apps/private/**"],
        "/repo",
        "/repo/apps/web/agent",
      ),
    ).toBe(true);
    expect(
      workspacePatternsClaimProject(
        ["apps/**", "!apps/private/**"],
        "/repo",
        "/repo/apps/private/agent",
      ),
    ).toBe(false);
  });

  it("derives the sibling package pattern for a nested project path", () => {
    expect(workspacePatternForProject("/repo", "/repo/agents/my-agent")).toBe("agents/*");
    expect(workspacePatternForProject("/repo", "/repo/apps/eve/my-agent")).toBe("apps/eve/*");
    expect(workspacePatternForProject("/repo", "/repo/my-agent")).toBe("my-agent");
  });
});
