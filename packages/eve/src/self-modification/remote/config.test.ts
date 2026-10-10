import { afterEach, describe, expect, it } from "vitest";

import { createGitHubCredentialProvider } from "../credentials.js";
import { resolveDeployedSelfModificationConfig } from "./config.js";

afterEach(() => {
  delete process.env.EVE_SELF_MODIFICATION_GITHUB_TOKEN;
});

const deployed = {
  source: { git: { directory: "apps/weather", repository: "github.com/vercel/eve" } },
  target: { branch: "main" },
  authorize: () => true,
  credentials: { pat: true },
} as const;

describe("deployed self-modification configuration", () => {
  it("resolves a repository-root application", () => {
    expect(
      resolveDeployedSelfModificationConfig({
        ...deployed,
        source: { git: { ...deployed.source.git, directory: "." } },
      }),
    ).toMatchObject({
      directory: ".",
      repository: { owner: "vercel", repo: "eve" },
      targetBranch: "main",
    });
  });

  it("requires opting into the self-hosted PAT exception", () => {
    expect(resolveDeployedSelfModificationConfig(deployed)).toMatchObject({
      credentials: { kind: "pat" },
    });
    expect(() =>
      resolveDeployedSelfModificationConfig({ ...deployed, credentials: undefined }),
    ).toThrow("must explicitly configure");
  });

  it("resolves an application-supplied credential provider", () => {
    const provider = { resolve: async () => "github-token" };
    const config = resolveDeployedSelfModificationConfig({ ...deployed, credentials: provider });

    expect(config.credentials).toEqual({ kind: "provider", provider });
  });

  it.each(["", "/agent", "agent/../other", "agent//other", "agent\\other"])(
    "rejects unsafe application directories: %s",
    (directory) => {
      expect(() =>
        resolveDeployedSelfModificationConfig({
          ...deployed,
          source: { git: { ...deployed.source.git, directory } },
        }),
      ).toThrow("safe repository-relative");
    },
  );

  it("requires complete configuration", () => {
    expect(() =>
      resolveDeployedSelfModificationConfig({ source: deployed.source } as never),
    ).toThrow("source, target, and authorization");
  });

  it("requires an authorization policy", () => {
    expect(() => {
      const { authorize: _authorize, ...withoutAuthorize } = deployed;
      resolveDeployedSelfModificationConfig(withoutAuthorize as never);
    }).toThrow("source, target, and authorization");
    expect(() =>
      resolveDeployedSelfModificationConfig({ ...deployed, authorize: true as never }),
    ).toThrow("authorize must be a function");
  });

  it("rejects ambiguous or malformed credential configuration", () => {
    expect(() =>
      resolveDeployedSelfModificationConfig({
        ...deployed,
        credentials: { pat: true, resolve: async () => "token" } as never,
      }),
    ).toThrow("not both");
    expect(() =>
      resolveDeployedSelfModificationConfig({ ...deployed, credentials: { pat: false } as never }),
    ).toThrow("pat must be true");
    expect(() =>
      resolveDeployedSelfModificationConfig({
        ...deployed,
        credentials: { resolve: true } as never,
      }),
    ).toThrow("resolve function");
  });

  it.each([
    [null, "configuration must be an object"],
    [{ ...deployed, source: null }, "source must be an object"],
    [{ ...deployed, source: {} }, "source.git must be an object"],
    [{ ...deployed, target: null }, "target must be an object"],
  ])("rejects malformed nested configuration", (config, message) => {
    expect(() => resolveDeployedSelfModificationConfig(config as never)).toThrow(message);
  });

  it("rejects a fully qualified target ref", () => {
    expect(() =>
      resolveDeployedSelfModificationConfig({
        ...deployed,
        target: { branch: "refs/heads/main" },
      }),
    ).toThrow("must be a branch name");
  });

  it("resolves the GitHub token for each capability", async () => {
    process.env.EVE_SELF_MODIFICATION_GITHUB_TOKEN = " secret-token ";
    const { credentials, repository } = resolveDeployedSelfModificationConfig(deployed);
    const provider = createGitHubCredentialProvider(credentials);
    await expect(provider.resolve({ capability: "checkout", repository })).resolves.toBe(
      "secret-token",
    );
    await expect(provider.resolve({ capability: "publish", repository })).resolves.toBe(
      "secret-token",
    );
  });
});
