import { describe, expect, it, vi } from "vitest";

import { win32 } from "node:path";
import { captureVercel, runVercelCaptureStdout } from "#setup/primitives/run-vercel.js";

import {
  classifySelfModificationConfig,
  connectorName,
  defaultSelfModificationSetupOperations,
  parseGitHubRemote,
  renderSelfModificationConfig,
  repositoryRelativeDirectory,
  type SelfModificationSetupDependencies,
} from "./setup.js";

describe("self-modification setup", () => {
  it("recognizes default local configurations", () => {
    expect(renderSelfModificationConfig()).toContain(
      'import selfModification from "eve/self-modification/local";',
    );
    expect(renderSelfModificationConfig()).toContain('// model: "provider/model"');
    expect(classifySelfModificationConfig(renderSelfModificationConfig())).toBe("local");
    expect(
      classifySelfModificationConfig(
        renderSelfModificationConfig().replace(
          '"eve/self-modification/local"',
          '"eve/self-modification"',
        ),
      ),
    ).toBe("local");
    expect(
      classifySelfModificationConfig(
        'import { defineSelfModificationConfig } from "eve/self-modification/config";\n\nexport default defineSelfModificationConfig({});\n',
      ),
    ).toBe("local");
  });

  it("renders the deployed extension configuration", () => {
    const source = renderSelfModificationConfig({
      baseBranch: "release/production",
      connector: "github/selfmod-acme-agents",
      directory: "apps/support",
      repository: "acme/agents",
    });
    expect(source).toContain('import selfModification from "eve/self-modification/remote";');
    expect(source).toContain('// model: "provider/model"');
    expect(source).not.toContain("deployed: {");
    expect(source).toContain('    repository: "acme/agents",');
    expect(source).toContain('directory: "apps/support"');
    expect(source).toContain('baseBranch: "release/production"');
    expect(source).toContain('    connector: "github/selfmod-acme-agents",');
    expect(source).toContain("authorize: () => true");
    expect(source).not.toContain("getToken");
    expect(classifySelfModificationConfig(source)).toBe("generated");
  });

  it("refuses altered generated configuration as authored", () => {
    expect(
      classifySelfModificationConfig(
        `${renderSelfModificationConfig({ baseBranch: "main", connector: "github/selfmod-acme-agents", directory: ".", repository: "acme/agents" })}\n// edited`,
      ),
    ).toBe("authored");
  });

  it("finds a connector on a later Vercel list page", async () => {
    const capture = vi.fn<typeof captureVercel>();
    capture.mockResolvedValueOnce({
      ok: true,
      stdout: JSON.stringify({
        connectors: [{ type: "github", uid: "github/other" }],
        cursor: "next-page",
      }),
    });
    capture.mockResolvedValueOnce({
      ok: true,
      stdout: JSON.stringify({
        connectors: [{ type: "github", uid: "github/selfmod-acme-agents" }],
      }),
    });
    const deps: SelfModificationSetupDependencies = {
      captureVercel: capture,
      runVercelCaptureStdout: vi.fn<typeof runVercelCaptureStdout>(),
    };
    const operations = defaultSelfModificationSetupOperations("/project", deps);

    await expect(
      operations.findOrCreateConnector("selfmod-acme-agents", {
        orgId: "team_acme",
        projectId: "prj_agent",
      }),
    ).resolves.toBe("github/selfmod-acme-agents");
    expect(capture).toHaveBeenNthCalledWith(
      1,
      [
        "connect",
        "list",
        "--all-projects",
        "--service",
        "github",
        "-F",
        "json",
        "--scope",
        "team_acme",
      ],
      { cwd: "/project" },
    );
    expect(capture).toHaveBeenNthCalledWith(
      2,
      [
        "connect",
        "list",
        "--all-projects",
        "--service",
        "github",
        "-F",
        "json",
        "--scope",
        "team_acme",
        "--next",
        "next-page",
      ],
      { cwd: "/project" },
    );
    expect(deps.runVercelCaptureStdout).not.toHaveBeenCalled();
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
