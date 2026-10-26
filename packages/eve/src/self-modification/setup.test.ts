import { describe, expect, it, vi } from "vitest";

import { win32 } from "node:path";
import { runInNewContext } from "node:vm";

import { captureVercel, runVercelCaptureStdout } from "#setup/primitives/run-vercel.js";

import type { DeployedSelfModificationConfig } from "./remote/config-schema.js";
import {
  branchProtectionStatus,
  classifySelfModificationConfig,
  connectorName,
  defaultSelfModificationSetupOperations,
  parseGitHubRemote,
  renderSelfModificationConfig,
  repositoryRelativeDirectory,
  type SelfModificationSetupDependencies,
} from "./setup.js";

const values = {
  baseBranch: "main",
  channelNames: [],
  connector: "github/selfmod-acme-agents",
  directory: ".",
  repository: "acme/agents",
};

function evaluateGeneratedConfig(source: string) {
  return runInNewContext(
    source
      .replace('import selfModification from "eve/self-modification/remote";', "")
      .replace("export default ", ""),
    {
      process: { env: { VERCEL_PROJECT_ID: "prj_123" } },
      selfModification: (config: DeployedSelfModificationConfig) => config,
    },
  ) as DeployedSelfModificationConfig;
}

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
      ...values,
      baseBranch: "release/production",
      channelNames: ["slack", "eve"],
      directory: "apps/support",
    });
    expect(source).toContain('import selfModification from "eve/self-modification/remote";');
    expect(source).toContain('// model: "provider/model"');
    expect(source).not.toContain("deployed: {");
    expect(source).toContain('    repository: "acme/agents",');
    expect(source).toContain('directory: "apps/support"');
    expect(source).toContain('baseBranch: "release/production"');
    expect(source).toContain('    connector: "github/selfmod-acme-agents",');
    expect(source).not.toContain("authorize: () => true");
    expect(source).toContain('case "http"');
    expect(source).toContain(
      'case "channel:slack":\n        // Authorize trusted principals for this channel before returning true.\n        return false;\n      default:',
    );
    expect(source).not.toContain('case "channel:eve"');
    expect(source).not.toContain("getToken");
    expect(classifySelfModificationConfig(source)).toBe("generated");
  });

  it.each([
    ["https://oidc.vercel.com", true],
    ["https://oidc.vercel.com/acme", true],
    ["https://identity.example.com", false],
    ["https://oidc.vercel.com.attacker.example", false],
    ["https://oidc.vercel.com@attacker.example", false],
    [undefined, false],
  ])("checks the generated policy's issuer %s", (issuer, allowed) => {
    const config = evaluateGeneratedConfig(
      renderSelfModificationConfig({ ...values, channelNames: ["slack"] }),
    );
    const principal = {
      attributes: { project_id: "prj_123" },
      authenticator: "oidc",
      issuer,
      principalId: "caller",
      principalType: "service" as const,
    };

    expect(config.authorize({ channel: { kind: "http" }, principal })).toBe(allowed);
    expect(
      config.authorize({
        channel: { kind: "http" },
        principal: { ...principal, attributes: { project_id: "prj_other" } },
      }),
    ).toBe(false);
    expect(
      config.authorize({
        channel: { kind: "http" },
        principal: { ...principal, authenticator: "jwt-hmac" },
      }),
    ).toBe(false);
    expect(config.authorize({ channel: { kind: "channel:slack" }, principal })).toBe(false);
    expect(config.authorize({ channel: { kind: "http" }, principal: null })).toBe(false);
  });

  it.each([
    [[{ type: "pull_request" }], { protected: true }, "pull-request-required"],
    [[{ type: "pull_request" }], undefined, "pull-request-required"],
    [[{ type: "deletion" }], { protected: true }, "protected"],
    [[], { protected: false }, "unprotected"],
    [undefined, { protected: false }, "unknown"],
    [[], undefined, "unknown"],
  ])("classifies rules %j and branch %j as %s", (rules, branch, status) => {
    expect(
      branchProtectionStatus(
        rules === undefined ? undefined : JSON.stringify(rules),
        branch === undefined ? undefined : JSON.stringify(branch),
      ),
    ).toBe(status);
  });

  it("reads branch protection through the GitHub CLI", async () => {
    const captureGitHub = vi.fn(async (args: readonly string[]) =>
      args[1]!.includes("/rules/") ? "[]" : '{"protected":false}',
    );
    const operations = defaultSelfModificationSetupOperations("/project", {
      captureGitHub,
      captureVercel: vi.fn<typeof captureVercel>(),
      runVercelCaptureStdout: vi.fn<typeof runVercelCaptureStdout>(),
    });

    await expect(
      operations.checkBranchProtection("acme/agents", "release/production"),
    ).resolves.toBe("unprotected");
    expect(captureGitHub).toHaveBeenCalledWith([
      "api",
      "repos/acme/agents/rules/branches/release%2Fproduction",
    ]);
    expect(captureGitHub).toHaveBeenCalledWith([
      "api",
      "repos/acme/agents/branches/release%2Fproduction",
    ]);
  });

  it("refuses altered generated configuration as authored", () => {
    expect(
      classifySelfModificationConfig(`${renderSelfModificationConfig(values)}\n// edited`),
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
      captureGitHub: vi.fn(),
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
