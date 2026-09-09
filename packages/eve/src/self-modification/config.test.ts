import { afterEach, describe, expect, it } from "vitest";

import { resolveSelfModificationConfig } from "./config.js";
import { resolveGitHubCredential } from "./credentials.js";
import { resolveSelfModificationMode } from "./mode.js";

afterEach(() => {
  delete process.env.EVE_DEV;
  delete process.env.EVE_SELF_MODIFICATION_GITHUB_TOKEN;
  delete process.env.VERCEL_ENV;
});

const deployed = {
  deployed: {
    source: { git: { directory: "apps/weather", repository: "github.com/vercel/eve" } },
    target: { branch: "main" },
    credentials: { pat: true },
  },
} as const;

describe("self-modification deployed configuration", () => {
  it("resolves a repository-root application", () => {
    expect(
      resolveSelfModificationConfig({
        deployed: {
          ...deployed.deployed,
          source: { git: { ...deployed.deployed.source.git, directory: "." } },
        },
      }),
    ).toMatchObject({
      deployed: {
        directory: ".",
        repository: { owner: "vercel", repo: "eve" },
        targetBranch: "main",
      },
    });
  });

  it("requires opting into the self-hosted PAT exception", () => {
    expect(resolveSelfModificationConfig(deployed)).toMatchObject({
      localEnabled: true,
      deployed: { credentials: { kind: "pat" } },
    });
    expect(() =>
      resolveSelfModificationConfig({
        deployed: { ...deployed.deployed, credentials: undefined },
      }),
    ).toThrow("must explicitly configure");
  });

  it("resolves a Vercel Connect connector only in Vercel Production", () => {
    const config = resolveSelfModificationConfig({
      deployed: {
        ...deployed.deployed,
        credentials: { vercelConnect: { connector: "github/selfmod-vercel-eve" } },
      },
    });
    expect(resolveSelfModificationMode(config)).toBe("disabled");
    process.env.VERCEL_ENV = "production";
    expect(resolveSelfModificationMode(config)).toBe("deployed");
  });

  it.each(["", "/agent", "agent/../other", "agent//other", "agent\\other"])(
    "rejects unsafe application directories: %s",
    (directory) => {
      expect(() =>
        resolveSelfModificationConfig({
          deployed: {
            ...deployed.deployed,
            source: { git: { ...deployed.deployed.source.git, directory } },
          },
        }),
      ).toThrow("safe repository-relative");
    },
  );

  it("requires complete deployed configuration", () => {
    expect(() =>
      resolveSelfModificationConfig({ deployed: { source: deployed.deployed.source } } as never),
    ).toThrow("both source and target");
  });

  it("rejects ambiguous or malformed credential configuration", () => {
    expect(() =>
      resolveSelfModificationConfig({
        deployed: {
          ...deployed.deployed,
          credentials: { pat: true, vercelConnect: { connector: "github/example" } },
        },
      }),
    ).toThrow("exactly one");
    expect(() =>
      resolveSelfModificationConfig({
        deployed: { ...deployed.deployed, credentials: { pat: false } as never },
      }),
    ).toThrow("pat must be true");
  });

  it.each([
    [null, "configuration must be an object"],
    [{ local: null }, "local must be an object"],
    [
      { deployed: { source: null, target: deployed.deployed.target } },
      "deployed.source must be an object",
    ],
    [
      { deployed: { source: {}, target: deployed.deployed.target } },
      "deployed.source.git must be an object",
    ],
    [
      { deployed: { source: deployed.deployed.source, target: null } },
      "deployed.target must be an object",
    ],
  ])("rejects malformed nested configuration", (config, message) => {
    expect(() => resolveSelfModificationConfig(config as never)).toThrow(message);
  });

  it("rejects a fully qualified target ref", () => {
    expect(() =>
      resolveSelfModificationConfig({
        deployed: { ...deployed.deployed, target: { branch: "refs/heads/main" } },
      }),
    ).toThrow("must be a branch name");
  });

  it("activates deployed while keeping local editing local", () => {
    const config = resolveSelfModificationConfig(deployed);
    expect(resolveSelfModificationMode(config)).toBe("deployed");
    process.env.EVE_DEV = "1";
    expect(resolveSelfModificationMode(config)).toBe("local");
  });

  it("resolves the GitHub token for each capability", async () => {
    process.env.EVE_SELF_MODIFICATION_GITHUB_TOKEN = " secret-token ";
    const repository = resolveSelfModificationConfig(deployed).deployed!.repository;
    await expect(resolveGitHubCredential({ capability: "checkout", repository })).resolves.toBe(
      "secret-token",
    );
    await expect(resolveGitHubCredential({ capability: "publish", repository })).resolves.toBe(
      "secret-token",
    );
  });
});
