import { describe, expect, it, vi } from "vitest";

import { resolveDeploymentSource } from "#internal/application/deployment-source.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("resolveDeploymentSource", () => {
  it("prefers complete explicit build metadata", () => {
    const gitRoot = vi.fn();
    expect(
      resolveDeploymentSource({
        appRoot: "/repo/apps/support",
        env: {
          EVE_SOURCE_REPOSITORY: "github.com/acme/support-agent",
          EVE_SOURCE_REVISION: SHA.toUpperCase(),
          EVE_SOURCE_ROOT: "apps/support",
          VERCEL_GIT_PROVIDER: "github",
        },
        gitRoot,
      }),
    ).toEqual({
      repository: "github.com/acme/support-agent",
      revision: SHA,
      rootDirectory: "apps/support",
    });
    expect(gitRoot).not.toHaveBeenCalled();
  });

  it("captures GitHub Vercel metadata and derives the monorepo app root", () => {
    expect(
      resolveDeploymentSource({
        appRoot: "/repo/apps/support",
        env: {
          VERCEL_GIT_COMMIT_SHA: SHA,
          VERCEL_GIT_PROVIDER: "github",
          VERCEL_GIT_REPO_OWNER: "acme",
          VERCEL_GIT_REPO_SLUG: "support-agent",
        },
        gitRoot: () => "/repo",
      }),
    ).toEqual({
      repository: "github.com/acme/support-agent",
      revision: SHA,
      rootDirectory: "apps/support",
    });
  });

  it("returns null for incomplete or unsupported build metadata", () => {
    expect(
      resolveDeploymentSource({
        appRoot: "/app",
        env: { EVE_SOURCE_REPOSITORY: "github.com/acme/support-agent" },
      }),
    ).toBeNull();
    expect(
      resolveDeploymentSource({
        appRoot: "/app",
        env: {
          VERCEL_GIT_COMMIT_SHA: SHA,
          VERCEL_GIT_PROVIDER: "gitlab",
          VERCEL_GIT_REPO_OWNER: "acme",
          VERCEL_GIT_REPO_SLUG: "support-agent",
        },
      }),
    ).toBeNull();
  });

  it.each([
    { repository: "https://github.com/acme/support-agent", rootDirectory: ".", revision: SHA },
    { repository: "github.com/acme/support-agent", rootDirectory: "../support", revision: SHA },
    { repository: "github.com/acme/support-agent", rootDirectory: ".", revision: "main" },
  ])("returns null for invalid source identity %#", (source) => {
    expect(
      resolveDeploymentSource({
        appRoot: "/app",
        env: {
          EVE_SOURCE_REPOSITORY: source.repository,
          EVE_SOURCE_REVISION: source.revision,
          EVE_SOURCE_ROOT: source.rootDirectory,
        },
      }),
    ).toBeNull();
  });
});
