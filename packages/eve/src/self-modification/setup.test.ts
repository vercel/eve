import { describe, expect, it } from "vitest";

import { win32 } from "node:path";

import {
  classifySelfModificationConfig,
  connectorName,
  parseGitHubRemote,
  renderSelfModificationConfig,
  repositoryRelativeDirectory,
} from "./setup.js";

describe("self-modification setup", () => {
  it("renders a generated Connect-backed deployed configuration", () => {
    const source = renderSelfModificationConfig({
      branch: "release/production",
      connector: "github/selfmod-acme-agents",
      directory: "apps/support",
      repository: "github.com/acme/agents",
    });
    expect(source).toContain('repository: "github.com/acme/agents"');
    expect(source).toContain('directory: "apps/support"');
    expect(source).toContain('target: { branch: "release/production" }');
    expect(source).toContain('connector: "github/selfmod-acme-agents"');
    expect(source).not.toContain("EVE_SELF_MODIFICATION_GITHUB_TOKEN");
    expect(classifySelfModificationConfig(source)).toBe("generated");
  });

  it("refuses altered generated configuration as authored", () => {
    expect(
      classifySelfModificationConfig(
        `${renderSelfModificationConfig({ branch: "main", connector: "github/selfmod-acme-agents", directory: ".", repository: "github.com/acme/agents" })}\n// edited`,
      ),
    ).toBe("authored");
  });

  it("uses a stable repository-specific connector name", () => {
    expect(connectorName("Acme", "agents_tools")).toBe("selfmod-acme-agents-tools");
  });

  it("normalizes Windows application directories", () => {
    expect(
      repositoryRelativeDirectory(
        "C:\\work\\agents",
        "C:\\work\\agents\\apps\\support",
        win32.relative,
      ),
    ).toBe("apps/support");
  });

  it.each([
    "https://github.com/acme/agents.git",
    "git@github.com:acme/agents.git",
    "ssh://git@github.com/acme/agents.git",
  ])("detects GitHub remotes without retaining credentials: %s", (remote) => {
    expect(parseGitHubRemote(remote)).toEqual({ owner: "acme", repo: "agents" });
  });
});
