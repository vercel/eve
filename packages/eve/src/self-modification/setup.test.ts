import { describe, expect, it } from "vitest";

import { win32 } from "node:path";
import { runInNewContext } from "node:vm";

import { defineSelfModificationConfig } from "./config.js";

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
      channelNames: ["slack", "eve"],
      connector: "github/selfmod-acme-agents",
      directory: "apps/support",
      repository: "github.com/acme/agents",
      vercelBackend: true,
    });
    expect(source).toContain('repository: "github.com/acme/agents"');
    expect(source).toContain('directory: "apps/support"');
    expect(source).toContain('target: { branch: "release/production" }');
    expect(source).toContain('connector: "github/selfmod-acme-agents"');
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
    const config = runInNewContext(
      source
        .replace('import { defineSelfModificationConfig } from "eve/self-modification/config";', "")
        .replace("export default ", ""),
      {
        defineSelfModificationConfig,
        process: { env: { VERCEL_PROJECT_ID: "prj_123" } },
      },
    ) as ReturnType<typeof defineSelfModificationConfig>;
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
