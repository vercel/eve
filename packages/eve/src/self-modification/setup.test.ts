import { describe, expect, it, vi } from "vitest";

import { win32 } from "node:path";
import { runInNewContext } from "node:vm";

import { defineSelfModificationConfig } from "./config.js";

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

function evaluateGeneratedConfig(source: string, getToken = vi.fn()) {
  return runInNewContext(
    source
      .replace('import { getToken } from "@vercel/connect";', "")
      .replace('import { defineSelfModificationConfig } from "eve/self-modification/config";', "")
      .replace('import selfModification from "eve/self-modification";', "")
      .replace("export default ", "")
      .replace("selfModification(", "defineSelfModificationConfig("),
    {
      defineSelfModificationConfig,
      getToken,
      process: { env: { VERCEL_PROJECT_ID: "prj_123" } },
    },
  ) as ReturnType<typeof defineSelfModificationConfig>;
}

describe("self-modification setup", () => {
  it("recognizes default local configurations", () => {
    expect(renderSelfModificationConfig()).toContain(
      'import selfModification from "eve/self-modification";',
    );
    expect(renderSelfModificationConfig()).toContain('// model: "provider/model"');
    expect(classifySelfModificationConfig(renderSelfModificationConfig())).toBe("local");
    expect(
      classifySelfModificationConfig(
        'import { defineSelfModificationConfig } from "eve/self-modification/config";\n\nexport default defineSelfModificationConfig({});\n',
      ),
    ).toBe("local");
  });

  it("renders a generated Connect-backed deployed configuration", () => {
    const source = renderSelfModificationConfig({
      branch: "release/production",
      channelNames: ["slack", "eve"],
      connector: "github/selfmod-acme-agents",
      directory: "apps/support",
      repository: "github.com/acme/agents",
      vercelBackend: true,
    });
    expect(source).toContain('repository: "github.com/acme/agents"');
    expect(source).toContain('directory: "apps/support"');
    expect(source).toContain('target: { branch: "release/production" }');
    expect(source).toContain('import { getToken } from "@vercel/connect"');
    expect(source).toContain('import selfModification from "eve/self-modification"');
    expect(source).toContain('return await getToken("github/selfmod-acme-agents"');
    expect(source).toContain("async resolve({ capability, repository })");
    expect(source).toContain('case "http"');
    expect(source).toContain("const projectId = process.env.VERCEL_PROJECT_ID");
    expect(source).toContain('principal?.authenticator === "oidc"');
    expect(source).toContain("principal.attributes.project_id === projectId");
    expect(source).toContain('case "channel:slack"');
    expect(source).toContain(
      "// Authorize trusted principals for this channel before returning true.\n        return false;",
    );
    expect(source).toContain(
      "// Add another branch when you add a trusted channel.\n          return false;",
    );
    expect(source).not.toContain("authorize: () => false");
    expect(source).not.toContain("EVE_SELF_MODIFICATION_GITHUB_TOKEN");
    expect(classifySelfModificationConfig(source)).toBe("generated");
  });

  it("adapts Connect tokens to checkout and publish credential requests", async () => {
    const source = renderSelfModificationConfig({
      branch: "main",
      channelNames: [],
      connector: "github/selfmod-acme-agents",
      directory: ".",
      repository: "github.com/acme/agents",
      vercelBackend: true,
    });
    const getToken = vi.fn().mockResolvedValue("github-token");
    const config = evaluateGeneratedConfig(source, getToken);
    const credentials = config.deployed?.credentials;
    if (credentials === undefined || "pat" in credentials) {
      throw new Error("Expected generated credential provider.");
    }
    const repository = { owner: "acme", repo: "agents" };

    await expect(credentials.resolve({ capability: "checkout", repository })).resolves.toBe(
      "github-token",
    );
    await expect(credentials.resolve({ capability: "publish", repository })).resolves.toBe(
      "github-token",
    );
    expect(getToken).toHaveBeenNthCalledWith(1, "github/selfmod-acme-agents", {
      authorizationDetails: [{ repositories: ["acme/agents"], type: "github_app_installation" }],
      scopes: ["contents:read", "metadata:read"],
      subject: { type: "app" },
    });
    expect(getToken).toHaveBeenNthCalledWith(2, "github/selfmod-acme-agents", {
      authorizationDetails: [{ repositories: ["acme/agents"], type: "github_app_installation" }],
      scopes: ["contents:write", "pull_requests:write", "metadata:read"],
      subject: { type: "app" },
    });
  });

  it("preserves Connect setup guidance when the generated provider fails", async () => {
    const source = renderSelfModificationConfig({
      branch: "main",
      channelNames: [],
      connector: "github/selfmod-acme-agents",
      directory: ".",
      repository: "github.com/acme/agents",
      vercelBackend: true,
    });
    const failure = new Error("connector is not attached");
    const config = evaluateGeneratedConfig(source, vi.fn().mockRejectedValue(failure));
    const credentials = config.deployed?.credentials;
    if (credentials === undefined || "pat" in credentials) {
      throw new Error("Expected generated credential provider.");
    }

    await expect(
      credentials.resolve({
        capability: "checkout",
        repository: { owner: "acme", repo: "agents" },
      }),
    ).rejects.toMatchObject({
      cause: failure,
      message: expect.stringContaining(
        "Install and attach the configured GitHub connector to this Vercel project",
      ),
    });
  });

  it.each([
    ["https://oidc.vercel.com", true],
    ["https://oidc.vercel.com/acme", true],
    ["https://identity.example.com", false],
    ["https://oidc.vercel.com.attacker.example", false],
    ["https://oidc.vercel.com@attacker.example", false],
    [undefined, false],
  ])("checks the generated policy's issuer %s", (issuer, allowed) => {
    const source = renderSelfModificationConfig({
      branch: "main",
      channelNames: ["slack"],
      connector: "github/selfmod-acme-agents",
      directory: ".",
      repository: "github.com/acme/agents",
      vercelBackend: true,
    });
    const config = evaluateGeneratedConfig(source);
    const authorize = config.deployed!.authorize;
    const principal = {
      attributes: { project_id: "prj_123" },
      authenticator: "oidc",
      issuer,
      principalId: "caller",
      principalType: "service",
    };

    expect(authorize({ channel: { kind: "http" }, principal })).toBe(allowed);
    expect(
      authorize({
        channel: { kind: "http" },
        principal: { ...principal, attributes: { project_id: "prj_other" } },
      }),
    ).toBe(false);
    expect(
      authorize({
        channel: { kind: "http" },
        principal: { ...principal, authenticator: "jwt-hmac" },
      }),
    ).toBe(false);
    expect(authorize({ channel: { kind: "channel:slack" }, principal })).toBe(false);
    expect(authorize({ channel: { kind: "http" }, principal: null })).toBe(false);
  });

  it("renders no HTTP authorization branch without a Vercel backend", () => {
    const source = renderSelfModificationConfig({
      branch: "main",
      channelNames: [],
      connector: "github/selfmod-acme-agents",
      directory: ".",
      repository: "github.com/acme/agents",
      vercelBackend: false,
    });

    expect(source).not.toContain('case "http"');
    expect(source).not.toContain('case "channel:');
    expect(source).not.toContain("VERCEL_PROJECT_ID");
    expect(source).toContain(
      "switch (channel.kind) {\n        default:\n          // Add another branch when you add a trusted channel.",
    );
  });

  it("refuses altered generated configuration as authored", () => {
    expect(
      classifySelfModificationConfig(
        `${renderSelfModificationConfig({ branch: "main", channelNames: [], connector: "github/selfmod-acme-agents", directory: ".", repository: "github.com/acme/agents", vercelBackend: false })}\n// edited`,
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
